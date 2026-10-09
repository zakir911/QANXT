using System.Security.Claims;
using System.Text;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using QaNxt.Api.Authorization;
using QaNxt.Api.Configuration;
using QaNxt.Api.Hubs;
using QaNxt.Api.Middleware;
using QaNxt.Api.Services;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application;
using QaNxt.Infrastructure;
using QaNxt.Infrastructure.Persistence;
using QaNxt.Infrastructure.Security;
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
builder.Configuration.AddQaNxtEnvironmentMapping();

builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .Enrich.FromLogContext()
    .Enrich.WithProperty("Service", "qanxt-api")
    // Information by default, but settable: turning logging up to diagnose an incident, or
    // down so a test run's output stays readable, should not need a code change.
    .MinimumLevel.Is(context.Configuration.GetValue("Logging:MinimumLevel", LogEventLevel.Information))
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore.Database.Command", LogEventLevel.Warning)
    .WriteTo.Console(outputTemplate:
        "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}"));

builder.Services.Configure<ProductOptions>(builder.Configuration.GetSection("Product"));
builder.Services.Configure<SecurityOptions>(builder.Configuration.GetSection("Security"));
builder.Services.Configure<VerificationOptions>(builder.Configuration.GetSection("Verification"));

builder.Services.AddQaNxtInfrastructure(builder.Configuration);
builder.Services.AddQaNxtApplicationServices();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, CurrentUser>();
builder.Services.AddScoped<ICorrelationContext, CorrelationContext>();
builder.Services.AddScoped<QaNxt.Application.Applications.ITargetPolicy, QaNxt.Api.Services.TargetPolicy>();
builder.Services.AddSingleton<QaNxt.Application.Discovery.IPlatformUrls, QaNxt.Api.Services.PlatformUrls>();
builder.Services.AddScoped<IExecutionEventPublisher, QaNxt.Api.Services.SignalRExecutionEventPublisher>();

builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase));
    });

builder.Services.AddSignalR();

// Agent passes wait on a crawl and then on a test run, so they cannot be held open on
// the request that starts them.
builder.Services.AddHostedService<QaNxt.Api.Services.AgentRunnerService>();

// Executions whose worker stopped reporting are ended rather than left running for
// ever; without this a caller waits on a run that will never finish.
builder.Services.AddHostedService<QaNxt.Api.Services.StrandedExecutionReaper>();
builder.Services.AddHostedService<QaNxt.Api.Services.StrandedSecurityScanReaper>();
builder.Services.AddHostedService<QaNxt.Api.Services.StrandedDiscoveryRunReaper>();
// Regression that happens without anybody asking. Off with Scheduling:Enabled=false.
builder.Services.AddHostedService<QaNxt.Api.Services.ScheduleRunnerService>();

// The console's own address, so a notification can link to the run it is about. Read here
// because the Application layer does not read configuration; null is valid and means
// messages carry no link rather than a link to nowhere.
builder.Services.AddSingleton(new QaNxt.Application.Notifications.NotificationOptions(
    builder.Configuration["Console:BaseUrl"] ?? Environment.GetEnvironmentVariable("QANXT_CONSOLE_URL")));

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
        // Without this, the handler rewrites "sub" and "email" into the long WS-Federation
        // claim URIs, and every lookup for them finds nothing. The visible symptom was a
        // 401 from /auth/me with a perfectly valid token; the invisible one was worse —
        // ICurrentUser.UserId was null for every authenticated request, so audit entries
        // recorded no author and every CreatedByUserId was stored as null. Roles and the
        // display name are issued under their ClaimTypes URIs already, and the claim types
        // below are named explicitly so that stays true if a default ever changes.
        options.MapInboundClaims = false;

        options.TokenValidationParameters = new TokenValidationParameters
        {
            NameClaimType = ClaimTypes.Name,
            RoleClaimType = ClaimTypes.Role,
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
            // A valid signature only proves the token was issued here, not that it still
            // describes the account. See SecurityStampValidator.
            OnTokenValidated = QaNxt.Api.Services.SecurityStampValidator.ValidateAsync,

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
var authPermitPerMinute = builder.Configuration.GetValue("Security:AuthRateLimitPermitPerMinute", 10);
// Sized for the execution plane rather than for a person: artifact uploads dominate it.
var workerPermitPerMinute = builder.Configuration.GetValue("Security:WorkerRateLimitPermitPerMinute", 6000);
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // A refusal is the one thing here worth being able to find afterwards.
    //
    // Without this, a rejected request appeared only as Serilog's ordinary request line —
    // "responded 429" at Information, among every other request. A burst of blocked
    // credential attempts therefore read exactly like a busy afternoon, which is the wrong
    // way round: the requests the platform refused are more interesting than the ones it
    // served, not less.
    //
    // Logged rather than audited. An audit row per refusal would let anyone who can reach
    // the login endpoint write unbounded rows into the governance table, which turns a
    // brute-force attempt into a second, worse problem. The attempts that got through are
    // audited as LoginFailed; the ones the limiter stopped are here.
    options.OnRejected = (context, _) =>
    {
        var logger = context.HttpContext.RequestServices
            .GetRequiredService<ILoggerFactory>().CreateLogger("QaNxt.Api.RateLimiter");
        var isCredentialEndpoint = context.HttpContext.Request.Path
            .StartsWithSegments("/api/v1/auth", StringComparison.OrdinalIgnoreCase);

        logger.Log(
            // A refused credential attempt is a security event; a tenant hitting its ordinary
            // quota is capacity news. They do not belong at the same level.
            isCredentialEndpoint ? LogLevel.Warning : LogLevel.Information,
            "Rate limit refused {Method} {Path} from {RemoteAddress} (credential endpoint: {IsCredentialEndpoint})",
            context.HttpContext.Request.Method,
            context.HttpContext.Request.Path.Value,
            context.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            isCredentialEndpoint);

        return ValueTask.CompletedTask;
    };

    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        // A browser worker is part of this platform, not a tenant spending an API quota. Its
        // traffic is a function of the work a tenant legitimately asked for: a run that fans
        // out to ten executions uploads four or five artifacts each plus a completion
        // callback. Sharing a tenant's user budget throttled the execution plane into
        // dropping evidence and stranding runs, so workers get their own, much larger
        // partition — still bounded, so a broken worker cannot hammer the API unchecked.
        var isWorker = context.User.FindFirst(JwtTokenService.TokenKindClaim)?.Value == "worker";
        if (isWorker)
        {
            var workerKey = $"worker:{context.User.FindFirst(JwtTokenService.OrganizationClaim)?.Value ?? "unknown"}";
            return RateLimitPartition.GetFixedWindowLimiter(workerKey, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = workerPermitPerMinute,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            });
        }

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

    // Credential endpoints get a much tighter budget to blunt brute-force attempts. It is
    // configurable because the right number depends on the deployment: a shared corporate
    // egress IP puts a whole office behind one partition, and a limit that locks out real
    // users gets removed altogether rather than tuned.
    options.AddPolicy("auth", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "anonymous",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = authPermitPerMinute,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0
        }));
});

// ---- Health ---------------------------------------------------------------
builder.Services.AddHealthChecks()
    .AddCheck<QaNxt.Api.Services.DatabaseHealthCheck>("database", tags: new[] { "ready" })
    .AddCheck<QaNxt.Api.Services.RedisHealthCheck>("redis", tags: new[] { "ready" });

// ---- OpenAPI --------------------------------------------------------------
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "QA NXT Control Plane API",
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
    var xml = Path.Combine(AppContext.BaseDirectory, "QaNxt.Api.xml");
    if (File.Exists(xml)) options.IncludeXmlComments(xml);
});

var app = builder.Build();

// ---- Pipeline -------------------------------------------------------------
app.UseMiddleware<CorrelationMiddleware>();
app.UseMiddleware<ExceptionHandlingMiddleware>();

var swaggerEnabled = app.Environment.IsDevelopment();

app.Use(async (context, next) =>
{
    // Conservative defaults; the console is served separately so no inline script is needed here.
    var headers = context.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["X-Frame-Options"] = "DENY";
    headers["Referrer-Policy"] = "no-referrer";
    headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()";

    // `default-src 'none'` is right for an API that only ever answers JSON — and it also
    // blocked the stylesheet, script and images of the one page this application serves as
    // HTML, so the API reference the documentation points at rendered blank (BUG-0018).
    // The reference exists only in Development, and the policy below is still same-origin
    // only: nothing external may load, and the relaxation reaches no other path.
    var isSwagger = swaggerEnabled
        && context.Request.Path.StartsWithSegments("/swagger", StringComparison.OrdinalIgnoreCase);

    headers["Content-Security-Policy"] = isSwagger
        ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'";

    await next();
});

if (swaggerEnabled)
{
    app.UseSwagger();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/swagger/v1/swagger.json", "QA NXT API v1");
        options.DocumentTitle = "QA NXT API";
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

// Authentication first, then the limiter. The limiter partitions on claims — the tenant for
// a user, a separate bucket for a browser worker — and those claims only exist once the
// bearer token has been validated. With the limiter ahead of authentication every request
// looked anonymous to it and fell back to the remote address, so the per-tenant isolation it
// was written for never took effect and every caller behind one address shared one bucket.
app.UseAuthentication();
app.UseRateLimiter();
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
    var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
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
