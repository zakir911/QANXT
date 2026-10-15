using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using QaNxt.Api.Authorization;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Diagnosis;
using QaNxt.Application.Forms;
using QaNxt.Application.Security;
using QaNxt.Application.Testing;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Api.Controllers;

/// <summary>Form-level quality engineering: the forms discovery found, how an application is
/// to be tested, the generated suite, measured coverage and its gaps, defects, the human
/// verification queue, the test repository and manual-test import.
///
/// None of these endpoints calls a model. They work identically with AI_DISABLED set.</summary>
[RequirePermission(Permissions.TestRead)]
public sealed class QualityEngineeringController : ApiControllerBase
{
    private readonly IFormTestingService _forms;
    private readonly ICoverageService _coverage;
    private readonly IDefectService _defects;
    private readonly IHumanVerificationService _human;
    private readonly ITestRepositoryService _repository;
    private readonly IManualTestImportService _import;
    private readonly ISelectionRunService _selection;
    private readonly IQaNxtDbContext _db;

    public QualityEngineeringController(IFormTestingService forms, ICoverageService coverage, IDefectService defects,
        IHumanVerificationService human, ITestRepositoryService repository, IManualTestImportService import,
        ISelectionRunService selection, IQaNxtDbContext db)
    {
        _forms = forms;
        _coverage = coverage;
        _defects = defects;
        _human = human;
        _repository = repository;
        _import = import;
        _selection = selection;
        _db = db;
    }

    // ---- Forms and the testing configuration ----------------------------------------

    /// <summary>The forms discovery found in an application.</summary>
    [HttpGet("~/api/v1/applications/{applicationId:guid}/forms")]
    public async Task<IActionResult> Forms(Guid applicationId, CancellationToken ct)
        => FromResult(await _forms.ListFormsAsync(applicationId, ct));

    /// <summary>One form as discovered: fields, constraints, locators, buttons, dependencies.</summary>
    [HttpGet("~/api/v1/forms/{formId:guid}")]
    public async Task<IActionResult> Form(Guid formId, CancellationToken ct)
        => FromResult(await _forms.GetFormModelAsync(formId, ct));

    /// <summary>Structural findings for a form: usability heuristics and security and
    /// accessibility indicators read from its markup. Never failures.</summary>
    [HttpGet("~/api/v1/forms/{formId:guid}/findings")]
    public async Task<IActionResult> Findings(Guid formId, CancellationToken ct)
        => Ok(await _db.FormFindings.Where(f => f.ApplicationFormId == formId).OrderBy(f => f.Kind).ThenBy(f => f.Code)
            .Select(f => new { f.Id, kind = f.Kind.ToString(), f.Code, f.FieldKey, f.Message, f.Severity }).ToListAsync(ct));

    [HttpGet("~/api/v1/applications/{applicationId:guid}/testing-profile")]
    public async Task<IActionResult> Profile(Guid applicationId, CancellationToken ct)
        => FromResult(await _forms.GetProfileAsync(applicationId, ct));

    /// <summary>Sets which categories, viewports, browsers and budgets apply, and how coverage is weighted.</summary>
    [HttpPut("~/api/v1/applications/{applicationId:guid}/testing-profile")]
    [RequirePermission(Permissions.ApplicationWrite)]
    public async Task<IActionResult> SaveProfile(Guid applicationId, [FromBody] TestingProfile profile, CancellationToken ct)
        => FromResult(await _forms.SaveProfileAsync(applicationId, profile, ct));

    /// <summary>Generates the form-level test suite for every discovered form (or the ones
    /// given). Deterministic; no AI.</summary>
    [HttpPost("~/api/v1/applications/{applicationId:guid}/form-tests/generate")]
    [RequirePermission(Permissions.TestGenerate)]
    public async Task<IActionResult> Generate(Guid applicationId, [FromBody] GenerateBody? body, CancellationToken ct)
        => FromResult(await _forms.GenerateAsync(new GenerateFormTestsRequest(applicationId, body?.FormIds, body?.SuiteName), ct));

    public sealed record GenerateBody(Guid[]? FormIds, string? SuiteName);

    // ---- Coverage ---------------------------------------------------------------

    /// <summary>Measured coverage: per form, per category, per dimension, with every gap.</summary>
    [HttpGet("~/api/v1/applications/{applicationId:guid}/coverage")]
    public async Task<IActionResult> Coverage(Guid applicationId, CancellationToken ct)
        => FromResult(await _coverage.ForApplicationAsync(applicationId, ct));

    // ---- Running a selection ------------------------------------------------------

    /// <summary>Run all, failed, impacted, the regression suite, or chosen categories and forms.</summary>
    [HttpPost("~/api/v1/applications/{applicationId:guid}/runs")]
    [RequirePermission(Permissions.ExecutionRun)]
    public async Task<IActionResult> Run(Guid applicationId, [FromBody] SelectionBody body, CancellationToken ct)
        => FromResult(await _selection.StartAsync(body.For(applicationId), ct));

    /// <summary>What a selection would run, without running it.</summary>
    [HttpPost("~/api/v1/applications/{applicationId:guid}/runs/preview")]
    public async Task<IActionResult> Preview(Guid applicationId, [FromBody] SelectionBody body, CancellationToken ct)
        => FromResult(await _selection.PreviewAsync(body.For(applicationId), ct));

    public sealed record SelectionBody(string Mode, TestCategory[]? Categories, Guid[]? FormIds, BrowserType? Browser,
        Guid? EnvironmentId, int? Parallelism, string? Name, RunTrigger? Trigger,
        bool IncludeSecurity = false, QaNxt.Domain.Security.SecurityProfile? SecurityProfile = null)
    {
        public SelectionRunRequest For(Guid applicationId) => new(applicationId, Mode, Categories, FormIds, Browser, EnvironmentId, Parallelism, Name, Trigger,
            IncludeSecurity, SecurityProfile);
    }

    // ---- Defects and failures --------------------------------------------------------

    [HttpGet("~/api/v1/defects")]
    [RequirePermission(Permissions.DefectRead)]
    public async Task<IActionResult> Defects([FromQuery] Guid projectId, [FromQuery] Guid? applicationId, [FromQuery] DefectStatus? status, CancellationToken ct)
        => Ok(await _defects.ListAsync(projectId, applicationId, status, ct));

    [HttpGet("~/api/v1/defects/{id:guid}")]
    [RequirePermission(Permissions.DefectRead)]
    public async Task<IActionResult> Defect(Guid id, CancellationToken ct) => FromResult(await _defects.GetAsync(id, ct));

    /// <summary>Confirms, rejects, marks as duplicate or resolves a proposed defect.</summary>
    [HttpPost("~/api/v1/defects/{id:guid}/status")]
    [RequirePermission(Permissions.DefectWrite)]
    public async Task<IActionResult> DefectStatus(Guid id, [FromBody] DefectStatusBody body, CancellationToken ct)
        => FromResult(await _defects.SetStatusAsync(id, body.Status, body.Note, ct));

    public sealed record DefectStatusBody(DefectStatus Status, string? Note);

    /// <summary>Makes a permanent regression test from a confirmed defect.</summary>
    [HttpPost("~/api/v1/defects/{id:guid}/regression-test")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> RegressionTest(Guid id, CancellationToken ct)
        => FromResult(await _defects.CreateRegressionTestAsync(id, ct), testCaseId => Ok(new { testCaseId }));

    /// <summary>Everything known about one failure, in one record.</summary>
    [HttpGet("~/api/v1/failures/{failureId:guid}/report")]
    [RequirePermission(Permissions.FailureRead)]
    public async Task<IActionResult> FailureReport(Guid failureId, CancellationToken ct)
        => FromResult(await _defects.FailureReportAsync(failureId, ct));

    // ---- Human verification -----------------------------------------------------------

    [HttpGet("~/api/v1/human-tasks")]
    public async Task<IActionResult> HumanTasks([FromQuery] Guid projectId, [FromQuery] Guid? applicationId, [FromQuery] HumanTaskStatus? status, CancellationToken ct)
        => Ok(await _human.ListAsync(projectId, applicationId, status, ct));

    [HttpGet("~/api/v1/human-tasks/{id:guid}")]
    public async Task<IActionResult> HumanTask(Guid id, CancellationToken ct) => FromResult(await _human.GetAsync(id, ct));

    [HttpPost("~/api/v1/human-tasks")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> CreateHumanTask([FromBody] CreateHumanTaskRequest request, CancellationToken ct)
        => FromResult(await _human.CreateAsync(request, ct));

    /// <summary>Records a person's verdict: passed, failed, blocked or not applicable.</summary>
    [HttpPost("~/api/v1/human-tasks/{id:guid}/verdict")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Verdict(Guid id, [FromBody] RecordHumanVerdictRequest request, CancellationToken ct)
        => FromResult(await _human.RecordVerdictAsync(id, request, ct));

    [HttpPost("~/api/v1/human-tasks/{id:guid}/evidence")]
    [RequirePermission(Permissions.TestWrite)]
    [RequestSizeLimit(26 * 1024 * 1024)]
    public async Task<IActionResult> Evidence(Guid id, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return FromResult(await _human.AttachEvidenceAsync(id, file.FileName, file.ContentType, stream, ct));
    }

    // ---- The test repository -----------------------------------------------------------

    /// <summary>Searches and filters the repository by category, lifecycle, automation, form and text.</summary>
    [HttpGet("~/api/v1/test-repository")]
    public async Task<IActionResult> Repository([FromQuery] Guid projectId, [FromQuery] Guid? applicationId, [FromQuery] TestCategory? category,
        [FromQuery] TestCaseLifecycle? lifecycle, [FromQuery] AutomationStatus? automation, [FromQuery] Guid? formId, [FromQuery] string? search,
        [FromQuery] ExecutionStatus? lastStatus, [FromQuery] int skip = 0, [FromQuery] int take = 200, CancellationToken ct = default)
    {
        var query = _db.TestCases.Where(tc => tc.ProjectId == projectId);
        if (applicationId is not null) query = query.Where(tc => tc.ApplicationId == applicationId);
        // The counts the page's tiles show, over the whole repository of this application:
        // a tile that counted only the rows on screen would change as the user paged.
        var byLifecycle = await query.GroupBy(tc => tc.Lifecycle).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
        var byLastStatus = await query.Where(tc => tc.Lifecycle == TestCaseLifecycle.Active)
            .GroupBy(tc => tc.LastStatus).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
        var facets = new
        {
            lifecycle = byLifecycle.ToDictionary(x => x.Key.ToString(), x => x.Count),
            lastStatus = new
            {
                // Exactly what the last-result filter selects, so a tile and the list it opens agree.
                passed = byLastStatus.Where(x => x.Key == ExecutionStatus.Passed).Sum(x => x.Count),
                failed = byLastStatus.Where(x => x.Key == ExecutionStatus.Failed).Sum(x => x.Count),
                neverRun = byLastStatus.Where(x => x.Key == null).Sum(x => x.Count)
            }
        };
        if (category is not null) query = query.Where(tc => tc.Category == category);
        if (lifecycle is not null) query = query.Where(tc => tc.Lifecycle == lifecycle);
        if (automation is not null) query = query.Where(tc => tc.AutomationStatus == automation);
        if (formId is not null) query = query.Where(tc => tc.ApplicationFormId == formId);
        if (lastStatus is not null) query = query.Where(tc => tc.LastStatus == lastStatus);
        if (!string.IsNullOrWhiteSpace(search))
        {
            var term = $"%{search.Trim()}%";
            query = query.Where(tc => EF.Functions.ILike(tc.Name, term) || EF.Functions.ILike(tc.Reference, term) || EF.Functions.ILike(tc.Tags, term));
        }
        var total = await query.CountAsync(ct);
        var items = await query.OrderBy(tc => tc.Reference).Skip(Math.Max(0, skip)).Take(Math.Clamp(take, 1, 1000))
            .Select(tc => new
            {
                tc.Id, tc.Reference, tc.Name, category = tc.Category.HasValue ? tc.Category.Value.ToString() : null, tc.Technique,
                lifecycle = tc.Lifecycle.ToString(), automation = tc.AutomationStatus.ToString(), tc.Priority, tc.Tags,
                tc.ApplicationFormId, tc.FieldKey, source = tc.Source.ToString(), tc.Version, tc.LastStatus, tc.LastExecutedAt,
                tc.ExecutionCount, tc.PassCount, tc.FailCount
            }).ToListAsync(ct);
        return Ok(new { total, items, facets });
    }

    [HttpPost("~/api/v1/test-cases/{id:guid}/duplicate")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Duplicate(Guid id, [FromBody] DuplicateBody? body, CancellationToken ct)
        => FromResult(await _repository.DuplicateAsync(id, body?.Name, ct), newId => Ok(new { testCaseId = newId }));

    public sealed record DuplicateBody(string? Name);

    [HttpPost("~/api/v1/test-cases/{id:guid}/lifecycle")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Lifecycle(Guid id, [FromBody] LifecycleBody body, CancellationToken ct)
        => FromResult(await _repository.SetLifecycleAsync(id, body.Lifecycle, ct));

    public sealed record LifecycleBody(TestCaseLifecycle Lifecycle);

    [HttpPost("~/api/v1/test-cases/bulk/lifecycle")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> BulkLifecycle([FromBody] BulkLifecycleBody body, CancellationToken ct)
        => FromResult(await _repository.BulkLifecycleAsync(body.ProjectId, body.TestCaseIds, body.Lifecycle, ct));

    public sealed record BulkLifecycleBody(Guid ProjectId, Guid[] TestCaseIds, TestCaseLifecycle Lifecycle);

    [HttpPost("~/api/v1/test-cases/bulk/tags")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> BulkTags([FromBody] BulkTagBody body, CancellationToken ct)
        => FromResult(await _repository.BulkTagAsync(body.ProjectId, body.TestCaseIds, body.Tag, body.Remove, ct));

    public sealed record BulkTagBody(Guid ProjectId, Guid[] TestCaseIds, string Tag, bool Remove = false);

    [HttpGet("~/api/v1/test-cases/{id:guid}/versions")]
    public async Task<IActionResult> Versions(Guid id, CancellationToken ct) => FromResult(await _repository.VersionsAsync(id, ct));

    [HttpGet("~/api/v1/test-cases/{id:guid}/versions/compare")]
    public async Task<IActionResult> Compare(Guid id, [FromQuery] int from, [FromQuery] int to, CancellationToken ct)
        => FromResult(await _repository.CompareAsync(id, from, to, ct));

    /// <summary>Imports manual test cases from CSV, TSV, Excel (.xlsx), JSON or structured text.</summary>
    [HttpPost("~/api/v1/applications/{applicationId:guid}/manual-tests/import")]
    [RequirePermission(Permissions.TestWrite)]
    [RequestSizeLimit(11 * 1024 * 1024)]
    public async Task<IActionResult> Import(Guid applicationId, IFormFile file, [FromForm] string? suiteName, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        await file.CopyToAsync(buffer, ct);
        return FromResult(await _import.ImportAsync(new ImportManualTestsRequest(applicationId, file.FileName, buffer.ToArray(), suiteName), ct));
    }
}
