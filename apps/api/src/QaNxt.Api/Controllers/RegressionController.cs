using QaNxt.Api.Authorization;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Quality;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Projects;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Api.Controllers;

/// <summary>Which tests a change needs, and why.
///
/// The "why" is not decoration. A pipeline that runs a narrowed set is trusting this
/// endpoint with the question of what does not get tested, and a team that cannot see the
/// reasoning has no way to tell a good selection from a broken one.</summary>
[Route("api/v1/regression")]
[RequirePermission(Permissions.TestRead)]
public sealed class RegressionController : ApiControllerBase
{
    private readonly IRegressionSelectionService _selection;
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;

    public RegressionController(
        IRegressionSelectionService selection, IQaNxtDbContext db,
        ICurrentUser currentUser, IClock clock, IAuditLogger audit)
    {
        _selection = selection;
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
    }

    /// <summary>What a set of changed files is found to affect, and which of those mappings
    /// a rule declared rather than QA NXT inferring.</summary>
    [HttpPost("impact")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Impact([FromBody] ChangeImpactRequest request, CancellationToken ct)
        => FromResult(await _selection.AnalyseImpactAsync(request, ct));

    /// <summary>The tests to run for a change, each with its score, the score's components
    /// and the sentence that earned each one.</summary>
    [HttpPost("select")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Select(
        [FromBody] RegressionSelectionRequest request, CancellationToken ct)
        => FromResult(await _selection.SelectAsync(request, ct));

    // ---- The rules a team writes ------------------------------------------

    [HttpGet("rules")]
    public async Task<IActionResult> ListRules([FromQuery] Guid projectId, CancellationToken ct)
        => Ok(await _db.ChangeImpactRules
            .Where(r => r.ProjectId == projectId)
            .OrderBy(r => r.PathPattern)
            .Select(r => new
            {
                r.Id, r.PathPattern, kind = r.Kind, r.Value, r.Notes, r.IsEnabled,
                r.CreatedAt, r.UpdatedAt
            })
            .ToListAsync(ct));

    public sealed record RuleBody(string PathPattern, ImpactKind Kind, string? Value, string? Notes, bool? IsEnabled);

    [HttpPost("rules")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> CreateRule(
        [FromQuery] Guid projectId, [FromBody] RuleBody body, CancellationToken ct)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId, ct);
        if (project is null) return Problem(Error.NotFound("The project"));

        if (Validate(body) is { } invalid) return Problem(invalid);

        var rule = new ChangeImpactRule
        {
            OrganizationId = project.OrganizationId,
            ProjectId = projectId,
            PathPattern = body.PathPattern.Trim(),
            Kind = body.Kind,
            Value = (body.Value ?? string.Empty).Trim(),
            Notes = string.IsNullOrWhiteSpace(body.Notes) ? null : body.Notes.Trim(),
            IsEnabled = body.IsEnabled ?? true,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        _db.ChangeImpactRules.Add(rule);
        await _db.SaveChangesAsync(ct);

        // A rule decides what does not get tested, which is exactly the kind of change
        // somebody asks about after a bad release.
        await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(ChangeImpactRule), rule.Id,
            $"Change impact rule created: \"{rule.PathPattern}\" affects {rule.Kind} {rule.Value}."
            + (rule.Notes is null ? string.Empty : $" {rule.Notes}"),
            projectId: projectId, ct: ct);

        return Ok(new { rule.Id, rule.PathPattern, kind = rule.Kind, rule.Value, rule.Notes, rule.IsEnabled });
    }

    [HttpDelete("rules/{id:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> DeleteRule(Guid id, CancellationToken ct)
    {
        var rule = await _db.ChangeImpactRules.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (rule is null) return Problem(Error.NotFound("The rule"));

        _db.ChangeImpactRules.Remove(rule);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(ChangeImpactRule), rule.Id,
            $"Change impact rule deleted: \"{rule.PathPattern}\" affected {rule.Kind} {rule.Value}.",
            projectId: rule.ProjectId, ct: ct);

        return NoContent();
    }

    private static Error? Validate(RuleBody body)
    {
        var errors = new Dictionary<string, string[]>();

        if (string.IsNullOrWhiteSpace(body.PathPattern))
        {
            // A blank pattern matches nothing, which would make the rule a silent no-op.
            errors["pathPattern"] = new[] { "A path pattern is required, for example src/pages/accounts/**." };
        }
        else if (body.PathPattern.Trim().Length > 500)
        {
            errors["pathPattern"] = new[] { "The path pattern must be 500 characters or fewer." };
        }

        if (!Enum.IsDefined(body.Kind))
            errors["kind"] = new[] { "That is not something a change can be said to affect." };

        if (body.Kind != ImpactKind.Everything && string.IsNullOrWhiteSpace(body.Value))
        {
            errors["value"] = new[]
            {
                $"A rule of kind {body.Kind} needs a value: the route, endpoint template, tag "
                + "or test reference it affects."
            };
        }

        return errors.Count == 0 ? null : Error.Validation("The rule is not valid.", errors);
    }
}
