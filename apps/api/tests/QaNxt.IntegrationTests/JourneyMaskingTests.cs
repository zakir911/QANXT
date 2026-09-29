using System.Net.Http.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace QaNxt.IntegrationTests;

/// <summary>
/// A recorded journey must not put a credential in the database.
///
/// <para>
/// The recorder replaces a password field's value before it leaves the page, so the primary
/// path is safe. A journey that arrives any other way — written by hand, exported from
/// another tool, produced by a recorder that is out of date — has no such protection, and
/// the importer's other defences cannot help: an arbitrary passphrase has no recognisable
/// shape, and it will not equal the credentials already on file.
/// </para>
/// <para>
/// What the payload does carry is the name of the field being typed into. A step targeting
/// "credential" and described as "Type the passphrase" was stored in plain text, and from
/// the journey it reached the generated test step as well. The masker reads those names now.
/// </para>
/// <para>
/// The last case is the one that keeps the fix honest. Masking everything would pass the
/// first two assertions and make the feature useless, so an ordinary value in an ordinary
/// field has to survive.
/// </para>
/// </summary>
[Collection(ApiCollection.Name)]
public class JourneyMaskingTests(ApiFactory factory)
{
    private const string Secret = "hunter2SuperSecretValue";

    private static object Journey(string name) => new
    {
        schemaVersion = 1,
        name,
        startUrl = "https://bank.example.test/login",
        recordedAt = DateTimeOffset.UtcNow,
        recorderVersion = "0.1.0",
        steps = new object[]
        {
            new { order = 1, action = "navigate", description = "Open", url = "https://bank.example.test/login", timestampMs = 0 },
            // Neither the target nor the description says "password", and the value looks
            // like nothing in particular. This is the case that was stored in the clear.
            new { order = 2, action = "fill", description = "Type the passphrase",
                  target = new { strategy = "testId", value = "credential" }, value = Secret, timestampMs = 900 },
            new { order = 3, action = "fill", description = "Type a search term",
                  target = new { strategy = "testId", value = "q" }, value = "ordinary text", timestampMs = 1200 }
        }
    };

    private async Task<(TestTenant Tenant, Guid ProjectId, Guid ApplicationId)> NewApplicationAsync()
    {
        var tenant = await factory.NewTenantAsync();

        var projectResponse = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Retail Banking",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await projectResponse.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var applicationResponse = await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id,
            name = "Demo Bank",
            baseUrl = "https://bank.example.test",
            allowedDomains = "bank.example.test",
            authStrategy = "none"
        }, ApiFactory.Json);
        var application = await applicationResponse.Content.ReadFromJsonAsync<ApplicationResponse>(ApiFactory.Json);

        return (tenant, project.Id, application!.Id);
    }

    [Fact]
    public async Task A_credential_named_field_is_never_stored_in_the_clear()
    {
        var (tenant, projectId, applicationId) = await NewApplicationAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/journeys/import", new
        {
            projectId,
            applicationId,
            generateTestCase = true,
            journey = Journey("Masking probe")
        }, ApiFactory.Json);
        response.EnsureSuccessStatusCode();

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        var journeyValues = await db.JourneySteps.AsNoTracking()
            .Where(s => s.Journey!.ProjectId == projectId)
            .Select(s => s.Value).ToListAsync();
        var stepValues = await db.TestSteps.AsNoTracking()
            .Where(s => s.TestCase!.ProjectId == projectId)
            .Select(s => s.Value).ToListAsync();

        journeyValues.Should().NotContain(Secret, "the recorded journey is stored as written");
        stepValues.Should().NotContain(Secret, "and the test case generated from it repeats every value");

        journeyValues.Should().Contain("${secret:app_password}");
        // The fix has to stay a filter, not a blanket. An ordinary value in an ordinary field
        // survives, or the recorded journey is worthless.
        journeyValues.Should().Contain("ordinary text");
    }
}
