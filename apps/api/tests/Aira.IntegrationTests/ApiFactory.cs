using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Aira.Application.Abstractions;
using Aira.Infrastructure.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using System.Security.Cryptography;

namespace Aira.IntegrationTests;

/// <summary>Boots the real API against a real database.
///
/// These tests deliberately do not substitute an in-memory provider. Most of what is worth
/// checking at this level — the tenant query filters, the snake-case mapping, the migrations
/// themselves, the way Postgres treats a unique index — only exists when the real provider
/// is there. A suite that passes against a fake database and fails against Postgres is worse
/// than no suite, because it is trusted.
///
/// One database is created for the whole run and dropped afterwards. Tests stay independent
/// by creating their own organization rather than by resetting tables, which is also the
/// arrangement that exercises tenant isolation for real.</summary>
public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private static readonly string DatabaseName = $"aira_test_{Guid.NewGuid():N}";
    private static readonly string AdminConnectionString;
    private static readonly string TestConnectionString;

    /// <summary>The shared secret a browser worker presents to claim a job.</summary>
    public static readonly string WorkerToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    /// <summary>Configuration is applied as environment variables rather than through
    /// ConfigureAppConfiguration, because the API reads its JWT secret and its connection
    /// string while the builder is still being assembled — before a test host's
    /// configuration callbacks have run. Environment variables are read first, so this is
    /// the hook that actually takes effect.
    ///
    /// The secrets are generated per run and exist only in this process: the suite must
    /// behave identically on a fresh clone and on a CI runner, and must never be able to
    /// decrypt or sign anything belonging to a real environment.</summary>
    static ApiFactory()
    {
        var configured = Environment.GetEnvironmentVariable("AIRA_TEST_DATABASE_URL")
            ?? Environment.GetEnvironmentVariable("DATABASE_URL")
            ?? "Host=localhost;Port=5432;Database=aira;Username=aira;Password=aira";

        AdminConnectionString = new NpgsqlConnectionStringBuilder(configured) { Database = "postgres" }.ToString();
        TestConnectionString = new NpgsqlConnectionStringBuilder(configured) { Database = DatabaseName }.ToString();

        Environment.SetEnvironmentVariable("DATABASE_URL", TestConnectionString);
        Environment.SetEnvironmentVariable("JWT_SECRET", Convert.ToBase64String(RandomNumberGenerator.GetBytes(48)));
        Environment.SetEnvironmentVariable("ENCRYPTION_KEY", Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
        Environment.SetEnvironmentVariable("WORKER_TOKEN", WorkerToken);
        // Rate limiting exists and is tested directly; leaving the production limit in place
        // here would make a suite of fast requests flake.
        Environment.SetEnvironmentVariable("RATE_LIMIT_PERMIT_PER_MINUTE", "100000");
        // Each test registers its own organization, which is several credential calls;
        // the production budget of ten a minute would throttle the suite rather than
        // test anything. The limiter itself is exercised against the real stack, with
        // real settings, by tests/e2e/security-check.mjs.
        Environment.SetEnvironmentVariable("AUTH_RATE_LIMIT_PERMIT_PER_MINUTE", "100000");
        // A test must never reach a real model provider, and must never need a key.
        Environment.SetEnvironmentVariable("AI_DEFAULT_PROVIDER", "local");
        Environment.SetEnvironmentVariable("OPENAI_API_KEY", "");
        Environment.SetEnvironmentVariable("ANTHROPIC_API_KEY", "");
        Environment.SetEnvironmentVariable("GEMINI_API_KEY", "");
        // A request log line per call would bury the test output; a failing test still
        // reports its own assertion, and warnings and errors still come through.
        Environment.SetEnvironmentVariable("LOG_LEVEL", "Warning");
        Environment.SetEnvironmentVariable("STORAGE_PROVIDER", "filesystem");
        Environment.SetEnvironmentVariable("STORAGE_ROOT",
            Path.Combine(Path.GetTempPath(), "aira-test-artifacts", DatabaseName));
    }

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    public async Task InitializeAsync()
    {
        try
        {
            await using var connection = new NpgsqlConnection(AdminConnectionString);
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand($"CREATE DATABASE \"{DatabaseName}\"", connection);
            await command.ExecuteNonQueryAsync();
        }
        catch (NpgsqlException exception)
        {
            // A confusing failure inside the first test is far harder to act on than this.
            throw new InvalidOperationException(
                "The integration tests need PostgreSQL. Could not connect using "
                + $"{new NpgsqlConnectionStringBuilder(AdminConnectionString) { Password = "***" }}. "
                + "Start it with: bash scripts/services-ctl.sh --with-database",
                exception);
        }

        // Forces the host to build and the migrations to run now, so a schema problem is
        // reported as a setup failure rather than as every test failing at once.
        using var scope = Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AiraDbContext>().Database.CanConnectAsync();
    }

    public new async Task DisposeAsync()
    {
        await base.DisposeAsync();

        await using var connection = new NpgsqlConnection(AdminConnectionString);
        await connection.OpenAsync();
        // Sessions the host left open would otherwise block the drop.
        await using (var terminate = new NpgsqlCommand(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = @name AND pid <> pg_backend_pid()",
            connection))
        {
            terminate.Parameters.AddWithValue("name", DatabaseName);
            await terminate.ExecuteNonQueryAsync();
        }
        await using var drop = new NpgsqlCommand($"DROP DATABASE IF EXISTS \"{DatabaseName}\"", connection);
        await drop.ExecuteNonQueryAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Everything else is supplied as environment variables in the static constructor,
        // because the API reads its configuration before this callback runs.
        builder.UseEnvironment("Testing");
    }

    /// <summary>Mints a session for the tenant's own user carrying only the permissions
    /// named, so the authorization layer can be checked directly.
    ///
    /// There is no endpoint for creating a user with a lesser role yet, and the alternative —
    /// writing rows straight into the database — would test the test rather than the policy
    /// provider. This goes through the real token service, so the token is indistinguishable
    /// from one a smaller role would receive.</summary>
    public async Task<HttpClient> ClientWithPermissionsAsync(
        TestTenant tenant, params string[] permissions)
    {
        using var scope = Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test token minting");

        var db = scope.ServiceProvider.GetRequiredService<AiraDbContext>();
        var user = await db.Users.FirstAsync(u => u.Id == tenant.Auth.User.UserId);

        var tokens = scope.ServiceProvider.GetRequiredService<ITokenService>()
            .Issue(user, permissions, Array.Empty<string>());

        var client = NewClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", tokens.AccessToken);
        return client;
    }

    /// <summary>A client carrying a worker's job-scoped token rather than a user session.</summary>
    public HttpClient WorkerClient(Guid organizationId, Guid jobId, string scope)
    {
        using var serviceScope = Services.CreateScope();
        var token = serviceScope.ServiceProvider.GetRequiredService<ITokenService>()
            .IssueWorkerToken(organizationId, jobId, scope, TimeSpan.FromMinutes(10));

        var client = NewClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return client;
    }

    /// <summary>A client that does not follow redirects, so a redirect is visible as one.</summary>
    public HttpClient NewClient() => CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false
    });

    /// <summary>Registers a fresh organization and returns a client authenticated as its
    /// administrator. Each test that needs isolation calls this rather than sharing a tenant.</summary>
    public async Task<TestTenant> NewTenantAsync(string? name = null)
    {
        // The organization's slug is derived from its name, so the name has to be unique
        // even when a test passes a readable label like "Alpha".
        var unique = Guid.NewGuid().ToString("N")[..12];
        var organizationName = name is null ? $"Org {unique}" : $"{name} {unique}";
        var email = $"admin-{unique}@example.test";
        const string password = "Str0ngPassphrase!2026";

        var client = NewClient();
        var response = await client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            organizationName,
            email,
            password,
            displayName = "Test Administrator"
        }, Json);

        response.EnsureSuccessStatusCode();
        var auth = await response.Content.ReadFromJsonAsync<AuthResponse>(Json)
            ?? throw new InvalidOperationException("Registration returned no body.");

        client.DefaultRequestHeaders.Authorization = new("Bearer", auth.AccessToken);
        return new TestTenant(this, client, auth, email, password);
    }
}

public sealed record AuthResponse(
    string AccessToken, DateTimeOffset AccessTokenExpiresAt,
    string RefreshToken, DateTimeOffset RefreshTokenExpiresAt, AuthenticatedUserResponse User);

public sealed record AuthenticatedUserResponse(
    Guid UserId, Guid OrganizationId, string Email, string DisplayName,
    IReadOnlyCollection<string> Roles, IReadOnlyCollection<string> Permissions);

/// <summary>One organization and an authenticated client for it.</summary>
public sealed class TestTenant(ApiFactory factory, HttpClient client, AuthResponse auth, string email, string password)
{
    public ApiFactory Factory { get; } = factory;
    public HttpClient Client { get; } = client;
    public AuthResponse Auth { get; } = auth;
    public string Email { get; } = email;
    public string Password { get; } = password;
    public Guid OrganizationId => Auth.User.OrganizationId;

    /// <summary>A client carrying no credentials at all, for checking that an endpoint is closed.</summary>
    public HttpClient Anonymous() => Factory.NewClient();
}

/// <summary>One host for the whole run: booting ASP.NET and migrating per class would make
/// the suite slow enough that people stop running it.</summary>
[CollectionDefinition(Name)]
public sealed class ApiCollection : ICollectionFixture<ApiFactory>
{
    public const string Name = "api";
}
