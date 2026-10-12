using System.IO.Compression;
using System.Text;
using FluentAssertions;
using QaNxt.Application.Reporting;
using QaNxt.Domain.Evidence;
using Xunit;

namespace QaNxt.UnitTests.Reporting;

public class RunBugReportRendererTests
{
    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");

    private static ReportArtifact Shot(string name, string caption) =>
        new(Guid.NewGuid(), "screenshot", name, "image/png", Png.Length, caption, $"key/{name}");

    private static RunBugReport Report(string actual = "Expected the submission to be refused, but it was accepted.",
        string? pageUrl = "http://app.test/register", string? response = "{\"ok\":true}")
    {
        var run = new ReportRun(Guid.NewGuid(), "Nightly regression", "Retail", "Staging", "http://app.test",
            new[] { new ReportApplication("Shop", "http://app.test") }, "Manual", "Chromium", "141.0",
            DateTimeOffset.Parse("2026-10-12T10:00:00Z"), DateTimeOffset.Parse("2026-10-12T10:05:00Z"), 300_000, "Failed",
            10, 8, 2, 0, 0, "abc123", "main", null, null, null);
        var steps = new[]
        {
            new ReportStep(1, "Open Create an account", "http://app.test/register", "passed", null, false),
            new ReportStep(2, "Enter \"17\" in Age", null, "passed", null, false),
            new ReportStep(3, "Confirm 17 was refused", null, "failed", actual, true)
        };
        var bug = new ReportBug("BUG-01", Guid.NewGuid(), "DEF-0001", "Proposed", "Create an account: accepts an invalid age", "Major", "High", "Boundary values",
            "Application defect", 70, "Shop", pageUrl, "Create an account", "age", "POST /register", "Chromium", "141.0", "1440x900 (default)",
            DateTimeOffset.Parse("2026-10-12T10:01:00Z"), 2, null, "Found by TC-0001.", steps,
            new Dictionary<string, string> { ["age"] = "17", ["notes"] = new string('L', 5000) },
            "The form is refused.", actual, steps[2], "Add the validation to the server.",
            new[] { new ReportExchange("POST", "http://app.test/register", 200, 120, "content-type: application/x-www-form-urlencoded", "age=17", response, null) },
            "curl -i -X POST 'http://app.test/register'", Array.Empty<ReportConsoleLine>(), Array.Empty<ReportA11yViolation>(),
            new[] { Shot("step-3-failure.png", "The page when step 3 failed"), Shot("step-3-failure.png", "TC-0002: The page when step 3 failed") },
            new[] { new ReportArtifact(Guid.NewGuid(), "trace", "trace.zip", "application/zip", 3, "Playwright trace", "key/trace.zip") },
            new[] { new ReportAffectedTest("TC-0001", "refuses 17", "age", "min-1", actual, null, Guid.NewGuid()) },
            "Re-run TC-0001.", Guid.NewGuid(), null);
        return new RunBugReport(run, new[] { bug },
            new[] { new ReportOtherFailure("TC-0009", "Profile opens", "Locator change", "No element matched.", "QA", Guid.NewGuid()) },
            Array.Empty<ReportFlakyTest>(), new[] { new ReportSkipGroup("Runs only in Firefox", 2, new[] { "TC-0010", "TC-0011" }) },
            DateTimeOffset.Parse("2026-10-12T10:06:00Z"));
    }

    private static Task<byte[]?> Read(ReportArtifact artifact, CancellationToken ct)
        => Task.FromResult<byte[]?>(artifact.Kind == "trace" ? new byte[] { 1, 2, 3 } : Png);

    [Fact]
    public async Task The_html_report_is_one_file_with_its_screenshots_inside_it()
    {
        var html = await RunBugReportRenderer.HtmlAsync(Report(), Read);

        html.Should().Contain("BUG-01").And.Contain("DEF-0001").And.Contain("Enter &quot;17&quot; in Age").And.Contain("← fails here")
            .And.Contain("Steps to reproduce").And.Contain("Where to look").And.Contain("Verify the fix")
            .And.Contain("Failures that are not product bugs").And.Contain("TC-0009");
        html.Should().Contain("data:image/png;base64,");
        html.Should().NotContain("src=\"http", "nothing is loaded from outside the file");
        html.Should().Contain("&quot;L&quot; &#215; 5000", "a 5000-character value is described, not printed");
        html.Should().Contain("alt=\"TC-0002: The page when step 3 failed\"");
    }

    [Fact]
    public async Task Content_from_the_application_under_test_cannot_run_in_the_report()
    {
        var hostile = Report(actual: "<script>alert(1)</script> was reflected", pageUrl: "javascript:alert(1)", response: "<img src=x onerror=alert(1)>");
        var html = await RunBugReportRenderer.HtmlAsync(hostile, Read);

        html.Should().NotContain("<script>alert(1)</script>").And.NotContain("<img src=x onerror").And.NotContain("href=\"javascript:");
        html.Should().Contain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    [Fact]
    public async Task The_evidence_pack_holds_the_report_in_three_forms_and_every_file_it_refers_to()
    {
        var bytes = await RunBugReportRenderer.ZipAsync(Report(), Read);
        using var zip = new ZipArchive(new MemoryStream(bytes));
        var names = zip.Entries.Select(e => e.FullName).ToList();

        names.Should().Contain(new[] { "bug-report.html", "bug-report.md", "bug-report.json", "README.txt", "evidence/BUG-01/trace.zip", "evidence/BUG-01/step-3-failure.png" });
        names.Should().Contain(n => n.StartsWith("evidence/BUG-01/TC-0002"), "a second test's screenshot is named after it, never overwriting the first");

        string Text(string name) { using var reader = new StreamReader(zip.GetEntry(name)!.Open(), Encoding.UTF8); return reader.ReadToEnd(); }
        Text("bug-report.html").Should().Contain("src=\"evidence/BUG-01/step-3-failure.png\"").And.Contain("href=\"evidence/BUG-01/trace.zip\"");
        Text("bug-report.md").Should().Contain("![The page when step 3 failed](evidence/BUG-01/step-3-failure.png)").And.Contain("**← fails here**");
        Text("bug-report.json").Should().Contain("\"key\": \"BUG-01\"").And.NotContain("key/step-3-failure.png", "storage keys stay on the server");
        Text("README.txt").Should().Contain("npx playwright show-trace");
    }

    [Fact]
    public void A_request_is_replayed_with_its_body_and_quotes_escaped()
    {
        var curl = RunBugReportService.Curl(new NetworkEvent
        {
            Method = "POST", Url = "http://app.test/register", RequestBodyExcerpt = "name=O'Brien&password=hunter22",
            RequestHeadersJson = "{\"content-type\":\"application/x-www-form-urlencoded\"}"
        })!;

        curl.Should().StartWith("curl -i -X POST 'http://app.test/register'");
        curl.Should().Contain("-H 'Content-Type: application/x-www-form-urlencoded'");
        curl.Should().Contain("O'\\''Brien", "a single quote cannot end the shell argument early");
        curl.Should().NotContain("hunter22", "a password in the body is masked");
    }
}
