using System.Text.Json;
using QaNxt.Api.Authorization;
using QaNxt.Api.Configuration;
using QaNxt.Api.Contracts;
using QaNxt.Application.Security;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace QaNxt.Api.Controllers;

/// <summary>Serves the golden test report and the certification to the console.
///
/// These files are written by the golden suite, not by the API: the endpoint reads whatever
/// the last run left on disk and never computes, caches or adjusts a number. If no run has
/// happened in this deployment it says so rather than inventing an empty green report —
/// "no evidence" and "everything passed" must never look the same in the UI.</summary>
[Route("api/v1/verification")]
[RequirePermission(Permissions.ProjectRead)]
public sealed class VerificationController : ApiControllerBase
{
    private readonly VerificationOptions _options;
    private readonly IWebHostEnvironment _environment;
    private readonly ILogger<VerificationController> _logger;

    public VerificationController(
        IOptions<VerificationOptions> options,
        IWebHostEnvironment environment,
        ILogger<VerificationController> logger)
    {
        _options = options.Value;
        _environment = environment;
        _logger = logger;
    }

    /// <summary>The last golden run: totals, metrics, quality gates and every test verdict.</summary>
    [HttpGet("report")]
    public IActionResult Report() => ReadReport("golden-test-report.json");

    /// <summary>The ten certification questions and the tests that answer them.</summary>
    [HttpGet("certification")]
    public IActionResult Certification() => ReadReport("certification.json");

    /// <summary>Where the reports are read from and whether they exist, so the console can
    /// explain an empty Verification Center instead of showing a blank page.</summary>
    [HttpGet("status")]
    public IActionResult Status()
    {
        var directory = ResolveDirectory();
        return Ok(new
        {
            directory,
            reportAvailable = System.IO.File.Exists(Path.Combine(directory, "golden-test-report.json")),
            certificationAvailable = System.IO.File.Exists(Path.Combine(directory, "certification.json")),
            command = "./scripts/run-golden-tests --all"
        });
    }

    private IActionResult ReadReport(string fileName)
    {
        var path = Path.Combine(ResolveDirectory(), fileName);
        if (!System.IO.File.Exists(path))
        {
            return StatusCode(StatusCodes.Status404NotFound, new ApiError(
                "verification_report_absent",
                $"No {fileName} has been produced in this deployment. Run ./scripts/run-golden-tests --all to create one.",
                StatusCodes.Status404NotFound, CorrelationId, null));
        }

        try
        {
            // Parsed rather than streamed so a truncated file — a run killed part way — is
            // reported as unreadable instead of arriving at the browser as broken JSON.
            using var document = JsonDocument.Parse(System.IO.File.ReadAllText(path));
            return Content(document.RootElement.GetRawText(), "application/json");
        }
        catch (JsonException exception)
        {
            _logger.LogWarning(exception, "Verification report {Path} is not valid JSON", path);
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new ApiError(
                "verification_report_unreadable",
                $"{fileName} exists but could not be parsed; the run that wrote it may not have finished.",
                StatusCodes.Status503ServiceUnavailable, CorrelationId, null));
        }
    }

    private string ResolveDirectory()
    {
        var configured = _options.ReportDirectory;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Path.IsPathRooted(configured)
                ? configured
                : Path.GetFullPath(Path.Combine(_environment.ContentRootPath, configured));
        }

        // Unconfigured, walk up from the content root looking for the repository's own
        // verification directory. This is what a developer running the stack locally gets.
        var directory = new DirectoryInfo(_environment.ContentRootPath);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "verification", "reports");
            if (Directory.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }

        return Path.Combine(_environment.ContentRootPath, "verification", "reports");
    }
}
