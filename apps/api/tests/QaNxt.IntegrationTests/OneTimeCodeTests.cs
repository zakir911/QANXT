using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;
using QaNxt.Infrastructure.Persistence;

namespace QaNxt.IntegrationTests;

/// <summary>The one-time code an application asks for after the password: stored with the
/// other credentials, encrypted, checked before it is stored, and never lost by an edit that
/// changes something else.</summary>
[Collection(ApiCollection.Name)]
public class OneTimeCodeTests(ApiFactory factory)
{
    private const string Secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

    private async Task<(TestTenant Tenant, Guid ProjectId)> NewProjectAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "OTP",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await response.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        return (tenant, project!.Id);
    }

    private static object Application(Guid projectId, object credentials) => new
    {
        projectId,
        name = "Bank with OTP",
        baseUrl = "https://bank.example.test",
        description = string.Empty,
        allowedDomains = "bank.example.test",
        authStrategy = "formLogin",
        loginUrl = "https://bank.example.test/login",
        credentials
    };

    private async Task<JsonElement> StoredCredentialsAsync(Guid projectId)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        var protector = scope.ServiceProvider.GetRequiredService<ISecretProtector>();
        var stored = await db.Applications.AsNoTracking().Where(a => a.ProjectId == projectId)
            .Select(a => a.EncryptedCredentials).FirstAsync();
        stored.Should().NotContain(Secret);
        protector.TryUnprotect(stored!, out var json).Should().BeTrue();
        return JsonDocument.Parse(json!).RootElement;
    }

    [Fact]
    public async Task A_fixed_code_is_stored_encrypted_and_an_edit_to_an_authenticator_keeps_the_password()
    {
        var (tenant, projectId) = await NewProjectAsync();
        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications", Application(projectId,
            new { username = "alice", password = "pw-123456", otpMode = "Fixed", otpValue = " 246810 " }), ApiFactory.Json);
        created.StatusCode.Should().Be(HttpStatusCode.Created);
        (await created.Content.ReadAsStringAsync()).Should().NotContain("246810");

        var stored = await StoredCredentialsAsync(projectId);
        stored.GetProperty("otpMode").GetString().Should().Be("fixed");
        stored.GetProperty("otpValue").GetString().Should().Be("246810");

        var id = JsonDocument.Parse(await created.Content.ReadAsStringAsync()).RootElement.GetProperty("id").GetString();
        var updated = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{id}", new
        {
            credentials = new { username = "", password = "", otpMode = "totp", otpValue = Secret }
        }, ApiFactory.Json);
        updated.StatusCode.Should().Be(HttpStatusCode.OK);

        stored = await StoredCredentialsAsync(projectId);
        stored.GetProperty("username").GetString().Should().Be("alice");
        stored.GetProperty("password").GetString().Should().Be("pw-123456");
        stored.GetProperty("otpMode").GetString().Should().Be("totp");
        stored.GetProperty("otpValue").GetString().Should().Be(Secret);
    }

    [Fact]
    public async Task Switching_the_kind_of_code_without_a_new_value_is_refused()
    {
        var (tenant, projectId) = await NewProjectAsync();
        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications", Application(projectId,
            new { username = "alice", password = "pw-123456", otpMode = "fixed", otpValue = "246810" }), ApiFactory.Json);
        var id = JsonDocument.Parse(await created.Content.ReadAsStringAsync()).RootElement.GetProperty("id").GetString();

        // A fixed code is not an authenticator secret; keeping it would fail at every sign-in.
        var updated = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{id}", new
        {
            credentials = new { otpMode = "totp", otpValue = "" }
        }, ApiFactory.Json);
        updated.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await StoredCredentialsAsync(projectId)).GetProperty("otpValue").GetString().Should().Be("246810");
    }

    [Theory]
    [InlineData("totp", "123456")]            // a code from the app, not the secret
    [InlineData("fixed", "12")]
    [InlineData("fixed", "")]
    [InlineData("sms", "123456")]
    public async Task A_code_that_cannot_work_is_refused_before_it_is_stored(string mode, string value)
    {
        var (tenant, projectId) = await NewProjectAsync();
        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications", Application(projectId,
            new { username = "alice", password = "pw-123456", otpMode = mode, otpValue = value }), ApiFactory.Json);
        created.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
