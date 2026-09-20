using System.Net;
using System.Net.Http.Json;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Aira.Application.Abstractions;

namespace Aira.IntegrationTests;

/// <summary>Two promises the platform makes about what it is given: a credential it stores
/// never comes back out, and a URL it is pointed at is checked before anything reaches it.
///
/// Both are asserted against the stored row as well as the response, because "the API does
/// not return it" and "it is not lying in the database in plain text" are different claims
/// and only the second survives a database being copied somewhere else.</summary>
[Collection(ApiCollection.Name)]
public class SecretAndTargetTests(ApiFactory factory)
{
    private const string Password = "sup3r-s3cret-bank-passw0rd";

    private async Task<(TestTenant Tenant, Guid ProjectId)> NewProjectAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Retail Banking",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);

        var project = await response.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        return (tenant, project!.Id);
    }

    private static object Application(Guid projectId, string baseUrl, object? credentials = null) => new
    {
        projectId,
        name = "Demo Bank",
        baseUrl,
        description = "Created by an integration test",
        allowedDomains = "bank.example.test",
        authStrategy = "formLogin",
        loginUrl = $"{baseUrl.TrimEnd('/')}/login",
        credentials
    };

    [Fact]
    public async Task A_stored_credential_is_never_returned_by_the_api()
    {
        var (tenant, projectId) = await NewProjectAsync();

        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Application(projectId, "https://bank.example.test", new { username = "alice", password = Password }),
            ApiFactory.Json);
        created.StatusCode.Should().Be(HttpStatusCode.Created);

        var createdBody = await created.Content.ReadAsStringAsync();
        createdBody.Should().NotContain(Password);
        // The platform may say that a credential exists — it must not say what it is.
        createdBody.Should().Contain("hasCredentials");

        var list = await (await tenant.Client.GetAsync($"/api/v1/applications?projectId={projectId}"))
            .Content.ReadAsStringAsync();
        list.Should().NotContain(Password);
    }

    [Fact]
    public async Task A_stored_credential_is_encrypted_at_rest()
    {
        var (tenant, projectId) = await NewProjectAsync();

        await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Application(projectId, "https://bank.example.test", new { username = "alice", password = Password }),
            ApiFactory.Json);

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<AiraDbContext>();

        var stored = await db.Applications.AsNoTracking()
            .Where(a => a.ProjectId == projectId)
            .Select(a => a.EncryptedCredentials)
            .FirstAsync();

        stored.Should().NotBeNullOrEmpty();
        stored.Should().NotContain(Password);
        // The versioned envelope the protector writes, so a rotation can tell formats apart.
        stored.Should().StartWith("v1:");
    }

    [Theory]
    [InlineData("http://169.254.169.254/latest/meta-data/")]   // cloud instance metadata
    [InlineData("http://metadata.google.internal/")]
    [InlineData("file:///etc/passwd")]
    [InlineData("ftp://example.com/")]
    [InlineData("javascript:alert(1)")]
    public async Task An_application_cannot_be_pointed_at_a_target_the_guard_refuses(string baseUrl)
    {
        // The crawler and the executor both fetch whatever this says, from inside the
        // network the platform runs in, so it is the one place an SSRF has to be stopped.
        var (tenant, projectId) = await NewProjectAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Application(projectId, baseUrl), ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync()).Should().NotContain("hasCredentials");
    }

    [Fact]
    public async Task A_validation_failure_explains_itself_without_echoing_the_secret()
    {
        var (tenant, projectId) = await NewProjectAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Application(projectId, "http://169.254.169.254/", new { username = "alice", password = Password }),
            ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var body = await response.Content.ReadAsStringAsync();
        body.Should().NotContain(Password);
        // A rejection that does not say which field was wrong just gets retried blindly.
        // The refusal names the range rather than the host, which is the useful detail:
        // it tells the reader why this address class is refused at all.
        body.Should().Contain("link-local");
        body.Should().Contain("correlationId");
    }

    [Fact]
    public async Task A_problem_response_carries_the_shape_a_client_can_rely_on()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "",                       // required
            key = "not a valid key!",        // wrong characters
            description = (string?)null
        }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var problem = await response.Content.ReadFromJsonAsync<ProblemResponse>(ApiFactory.Json);
        problem!.Code.Should().NotBeNullOrWhiteSpace();
        problem.Title.Should().NotBeNullOrWhiteSpace();
        problem.Status.Should().Be(400);
        problem.CorrelationId.Should().NotBeNullOrWhiteSpace();
        problem.Errors.Should().ContainKey("name");
        problem.Errors.Should().ContainKey("key");
    }

    [Fact]
    public async Task A_missing_resource_is_reported_as_missing_rather_than_as_a_server_error()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.GetAsync($"/api/v1/projects/{Guid.NewGuid()}");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_malformed_body_is_a_client_error_not_a_crash()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.PostAsync("/api/v1/projects",
            new StringContent("{ this is not json", System.Text.Encoding.UTF8, "application/json"));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}

/// <summary>The problem document every failure returns. Field-level detail arrives under
/// "errors", keyed by the field name a form would highlight.</summary>
public sealed record ProblemResponse(
    string Code, string Title, int Status, string CorrelationId,
    Dictionary<string, string[]>? Errors);
