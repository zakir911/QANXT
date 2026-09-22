using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Diagnosis;
using Aira.Application.Security;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aira.Api.Controllers;

/// <summary>Failures and what the platform concluded about them.
///
/// Re-analysis is the endpoint worth explaining. An analysis is a statement made from the
/// evidence available when it was made, and the evidence outlives it: a failure diagnosed
/// before the platform could attribute a request to the step that made it deserves the
/// better answer without anyone re-running the test. Re-analysis rebuilds the verdict from
/// what was stored, so it says what the platform would say today about the same run.</summary>
[Route("api/v1/failures")]
[RequirePermission(Permissions.TestRead)]
public sealed class FailuresController : ApiControllerBase
{
    private readonly IAiraDbContext _db;
    private readonly IFailureAnalysisService _analysis;

    public FailuresController(IAiraDbContext db, IFailureAnalysisService analysis)
    {
        _db = db;
        _analysis = analysis;
    }

    /// <summary>Recurring failures for a project, newest first. Clustered on their
    /// signature, so a test failing the same way in twenty runs is one row.</summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] Guid projectId,
        [FromQuery] FailureCategory? category,
        [FromQuery] bool? regressionsOnly,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var query = _db.Failures.Where(f => f.ProjectId == projectId);
        if (category is not null) query = query.Where(f => f.Category == category);
        if (regressionsOnly == true) query = query.Where(f => f.IsRegression);

        return Ok(await query
            .OrderByDescending(f => f.LastSeenAt)
            .Take(Math.Clamp(limit == 0 ? 50 : limit, 1, 200))
            .Select(f => new
            {
                f.Id, f.TestCaseId, f.TestExecutionId, category = f.Category, f.CategoryConfidence,
                f.RawMessage, f.Signature, f.IsNewFailure, f.IsRegression, f.OccurrenceCount,
                f.FirstSeenAt, f.LastSeenAt,
                testCaseReference = _db.TestCases.Where(tc => tc.Id == f.TestCaseId)
                    .Select(tc => tc.Reference).FirstOrDefault(),
                analysis = f.Analysis == null ? null : new
                {
                    f.Analysis.Summary, f.Analysis.LikelyCause, f.Analysis.Evidence,
                    f.Analysis.SuggestedAction, category = f.Analysis.Category, f.Analysis.Confidence,
                    f.Analysis.IsLikelyApplicationDefect, f.Analysis.IsHealable,
                    f.Analysis.ProducedByAi, provider = f.Analysis.Provider, f.Analysis.Model
                }
            })
            .ToListAsync(ct));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var failure = await _db.Failures
            .Include(f => f.Analysis)
            .FirstOrDefaultAsync(f => f.Id == id, ct);

        if (failure is null) return Problem(Error.NotFound("The failure"));

        return Ok(new
        {
            failure.Id, failure.TestCaseId, failure.TestExecutionId, failure.TestActionId,
            category = failure.Category, failure.CategoryConfidence, failure.RawMessage,
            failure.RawStack, failure.Signature, failure.IsNewFailure, failure.IsRegression,
            failure.OccurrenceCount, failure.FirstSeenAt, failure.LastSeenAt,
            analysis = failure.Analysis is null ? null : new
            {
                failure.Analysis.Summary, failure.Analysis.LikelyCause, failure.Analysis.Evidence,
                failure.Analysis.SuggestedAction, category = failure.Analysis.Category,
                failure.Analysis.Confidence, failure.Analysis.IsLikelyApplicationDefect,
                failure.Analysis.IsHealable, failure.Analysis.ProducedByAi,
                provider = failure.Analysis.Provider, failure.Analysis.Model,
                failure.Analysis.EvidenceRefsJson, failure.Analysis.CreatedAt
            }
        });
    }

    /// <summary>Analyses the failure again from its stored evidence.
    ///
    /// Nothing is re-run and nothing about the result changes: the verdict is produced from
    /// the same artifacts, so what changes is only what the platform has learned to read in
    /// them since. Needs write permission because it replaces the recorded analysis.</summary>
    [HttpPost("{id:guid}/reanalyse")]
    [RequirePermission(Permissions.TestWrite)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Reanalyse(Guid id, CancellationToken ct)
        => FromResult(await _analysis.ReanalyseAsync(id, ct), analysis => Ok(new
        {
            analysis.Summary, analysis.LikelyCause, analysis.Evidence, analysis.SuggestedAction,
            category = analysis.Category, analysis.Confidence, analysis.IsLikelyApplicationDefect,
            analysis.IsHealable, analysis.ProducedByAi, provider = analysis.Provider, analysis.Model
        }));
}
