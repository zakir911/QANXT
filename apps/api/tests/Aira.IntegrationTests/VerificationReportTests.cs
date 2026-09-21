using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Aira.IntegrationTests;

/// <summary>The console's Verification Center reads its numbers from these endpoints.
///
/// The property worth protecting is that an absent report and a passing report can never
/// look the same. A deployment where nobody has run the golden suite must say so; it must
/// not return an empty object that a UI would happily render as "0 failures".</summary>
[Collection(ApiCollection.Name)]
public class VerificationReportTests(ApiFactory factory) : IDisposable
{
    private static string Path(string fileName)
        => System.IO.Path.Combine(ApiFactory.VerificationReportDirectory, fileName);

    private static void Write(string fileName, string content)
    {
        Directory.CreateDirectory(ApiFactory.VerificationReportDirectory);
        File.WriteAllText(Path(fileName), content);
    }

    public void Dispose()
    {
        if (Directory.Exists(ApiFactory.VerificationReportDirectory))
            Directory.Delete(ApiFactory.VerificationReportDirectory, recursive: true);
    }

    [Fact]
    public async Task An_absent_report_is_reported_as_absent_rather_than_as_an_empty_pass()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.GetAsync("/api/v1/verification/report");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(ApiFactory.Json);
        body.GetProperty("code").GetString().Should().Be("verification_report_absent");
        body.GetProperty("title").GetString().Should().Contain("run-golden-tests");
    }

    [Fact]
    public async Task The_status_endpoint_says_where_it_looked_and_what_it_found()
    {
        var tenant = await factory.NewTenantAsync();

        var before = await tenant.Client.GetFromJsonAsync<JsonElement>("/api/v1/verification/status", ApiFactory.Json);
        before.GetProperty("reportAvailable").GetBoolean().Should().BeFalse();
        before.GetProperty("directory").GetString().Should().Be(ApiFactory.VerificationReportDirectory);

        Write("golden-test-report.json", """{"runId":"R1","totals":{"total":1}}""");

        var after = await tenant.Client.GetFromJsonAsync<JsonElement>("/api/v1/verification/status", ApiFactory.Json);
        after.GetProperty("reportAvailable").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task A_report_is_served_exactly_as_the_golden_run_wrote_it()
    {
        var tenant = await factory.NewTenantAsync();
        Write("golden-test-report.json",
            """{"runId":"2026-09-21T07-57-51Z","overall":false,"totals":{"total":89,"passed":86,"failed":0,"notVerified":3,"criticalFailures":0}}""");

        var body = await tenant.Client.GetFromJsonAsync<JsonElement>("/api/v1/verification/report", ApiFactory.Json);

        body.GetProperty("runId").GetString().Should().Be("2026-09-21T07-57-51Z");
        body.GetProperty("overall").GetBoolean().Should().BeFalse();
        body.GetProperty("totals").GetProperty("notVerified").GetInt32().Should().Be(3);
    }

    [Fact]
    public async Task A_report_a_killed_run_left_half_written_is_refused_rather_than_served_broken()
    {
        var tenant = await factory.NewTenantAsync();
        Write("golden-test-report.json", """{"runId":"R1","totals":{"tot""");

        var response = await tenant.Client.GetAsync("/api/v1/verification/report");

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(ApiFactory.Json);
        body.GetProperty("code").GetString().Should().Be("verification_report_unreadable");
    }

    [Fact]
    public async Task The_report_is_not_readable_without_a_session()
    {
        Write("golden-test-report.json", """{"runId":"R1"}""");

        var response = await factory.NewClient().GetAsync("/api/v1/verification/report");

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
