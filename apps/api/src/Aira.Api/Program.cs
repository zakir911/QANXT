using System.Text;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Aira.Api.Authorization;
using Aira.Api.Configuration;
using Aira.Api.Hubs;
using Aira.Api.Middleware;
using Aira.Api.Services;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Application;
using Aira.Infrastructure;
using Aira.Infrastructure.Persistence;
using Aira.Infrastructure.Security;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using Serilog;
using Serilog.Events;

var builder = WebApplication.CreateBuilder(args);

// Flat environment variables (the ones documented in .env.example) map onto the
// hierarchical configuration before anything binds options.
builder.Configuration.AddAiraEnvironmentMapping();

builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .Enrich.FromLogContext()
    .Enrich.WithProperty("Service", "aira-api")
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore.Database.Command", LogEventLevel.Warning)
    .WriteTo.Console(outputTemplate:
        "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}"));

builder.Services.Configure<ProductOptions>(builder.Configuration.GetSection("Product"));
builder.Services.Configure<SecurityOptions>(builder.Configuration.GetSection("Security"));

builder.Services.AddAiraInfrastructure(builder.Configuration);
builder.Services.AddAiraApplicationServices();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, CurrentUser>();
builder.Services.AddScoped<ICorrelationContext, CorrelationContext>();
builder.Services.AddScoped<Aira.Application.Applications.ITargetPolicy, Aira.Api.Services.TargetPolicy>();
builder.Services.AddSingleton<Aira.Application.Discovery.IPlatformUrls, Aira.Api.Services.PlatformUrls>();
builder.Services.AddScoped<IExecutionEventPublisher, Aira.Api.Services.SignalRExecutionEventPublisher>();

builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase));
    });

builder.Services.AddSignalR();

// ---- Authentication -------------------------------------------------------
var jwtSection = builder.Configuration.GetSection("Jwt");
var jwtSecret = jwtSection["Secret"] ?? string.Empty;
if (jwtSecret.Length < JwtOptions.MinimumSecretLength)
{
    throw new InvalidOperationException(
        $"JWT_SECRET must be at least {JwtOptions.MinimumSecretLength} characters. Generate one with: openssl rand -base64 48");
}

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtSection["Issuer"],
            ValidAudience = jwtSection["Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret)),
            ClockSkew = TimeSpan.FromSeconds(30)
        };

        // SignalR cannot set an Authorization header on the WebSocket handshake, so the
        // live-execution hub accepts the token as a query parameter on that path only.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"].FirstOrDefault();
                if (!string.IsNullOrEmpty(accessToken) &&
                    context.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                {
                    context.Token = accessToken;
                }
                return Task.CompletedTask;
            }
        };
    });

builder.Services.AddSingleton<IAuthorizationPolicyProvider, PermissionPolicyProvider>();
builder.Services.AddScoped<IAuthorizationHandler, PermissionAuthorizationHandler>();
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy(RequireWorkerTokenAttribute.PolicyName, policy =>
        policy.RequireAuthenticatedUser()
              .RequireClaim(JwtTokenService.TokenKindClaim, "worker"));
});

// ---- Cross-origin ---------------------------------------------------------
// localhost and 127.0.0.1 are different origins to a browser, and a developer will use
// whichever their tooling prints. Both are allowed by default so the console is not
// mysteriously broken depending on how it was opened.
var corsOrigins = builder.Configuration.GetSection("Security:CorsOrigins").Get<string[]>() is { Length: > 0 } configured
    ? configured
    : new[] { "http://localhost:5173", "http://127.0.0.1:5173" };
builder.Services.AddCors(options => options.AddPolicy("console", policy => policy
    .WithOrigins(corsOrigins)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()
    .WithExposedHeaders(CorrelationContext.HeaderName)));

// ---- Rate limiting --------------------------------------------------------
var permitPerMinute = builder.Configuration.GetValue("Security:RateLimitPermitPerMinute", 300);
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        // Partition by authenticated user where possible so one noisy tenant cannot
        // exhaust another's budget; fall back to remote address for anonymous calls.
        var key = context.User.Identity?.IsAuthenticated == true
            ? context.User.FindFirst(JwtTokenService.OrganizationClaim)?.Value ?? "authenticated"
            : context.Connection.RemoteIpAddress?.ToString() ?? "anonymous";

        return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = permitPerMinute,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0
        });
    });

    // Credential endpoints get a much tighter budget to blunt brute-force attempts.
    options.AddPolicy("auth", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "anonymous",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});

// ---- Health ---------------------------------------------------------------
builder.Services.AddHealthChecks()
    .AddCheck<Aira.Api.Services.DatabaseHealthCheck>("database", tags: new[] { "ready" })
    .AddCheck<Aira.Api.Services.RedisHealthCheck>("redis", tags: new[] { "ready" });

// ---- OpenAPI --------------------------------------------------------------
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "AIRA Control Plane API",
        Version = "v1",
        Description = "AI autonomous web application testing platform. All endpoints are versioned under /api/v1."
    });
    options.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Name = "Authorization",
        Type = SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "JWT",
        In = ParameterLocation.Header,
        Description = "Paste the access token returned by POST /api/v1/auth/login."
    });
    options.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        [new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }]
            = Array.Empty<string>()
    });
    var xml = Path.Combine(AppContext.BaseDirectory, "Aira.Api.xml");
    if (File.Exists(xml)) options.IncludeXmlComments(xml);
});

var app = builder.Build();

// ---- Pipeline -------------------------------------------------------------
app.UseMiddleware<CorrelationMiddleware>();
app.UseMiddleware<ExceptionHandlingMiddleware>();

app.Use(async (context, next) =>
{
    // Conservative defaults; the console is served separately so no inline script is needed here.
    var headers = context.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["X-Frame-Options"] = "DENY";
    headers["Referrer-Policy"] = "no-referrer";
    headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()";
    headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
    await next();
});

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/swagger/v1/swagger.json", "AIRA API v1");
        options.DocumentTitle = "AIRA API";
    });
}
else
{
    app.UseHsts();
}

app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate = "{RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0.0}ms";
});

app.UseCors("console");
app.UseRateLimiter();
app.UseAuthentication();
app.UseMiddleware<TenantMiddleware>();
app.UseAuthorization();

app.MapControllers();
app.MapHub<ExecutionHub>("/hubs/executions");

app.MapHealthChecks("/health");
app.MapHealthChecks("/ready", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
});
// Liveness must not touch dependencies: a database outage is not a reason to restart the pod.
app.MapHealthChecks("/live", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
{
    Predicate = _ => false
});

// ---- Startup: migrate and reconcile reference data ------------------------
await using (var scope = app.Services.CreateAsyncScope())
{
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    var db = scope.ServiceProvider.GetRequiredService<AiraDbContext>();
    var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();

    if (app.Configuration.GetValue("Database:AutoMigrate", true))
    {
        logger.LogInformation("Applying database migrations…");
        await db.Database.MigrateAsync();
    }

    using (tenant.EnterSystemContext("startup reference-data reconciliation"))
    {
        await scope.ServiceProvider.GetRequiredService<DatabaseSeeder>().SeedAsync();
    }
}

app.Run();

/// <summary>Exposed so the integration test host can reference the entry point assembly.</summary>
public partial class Program;
