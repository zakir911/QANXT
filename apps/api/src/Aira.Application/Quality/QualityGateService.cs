using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Quality;

public sealed record QualityGateRuleRequest(
    string Name, QualityGateMetric Metric, QualityGateOperator Operator,
    decimal Threshold, bool? IsBlocking, bool? IsEnabled);

public sealed record QualityGateRuleDetail(
    Guid Id, Guid ProjectId, string Name, QualityGateMetric Metric, QualityGateOperator Operator,
    decimal Threshold, bool IsBlocking, bool IsEnabled, DateTimeOffset CreatedAt, DateTimeOffset? UpdatedAt);

public interface IQualityGateService
{
    Task<Result<IReadOnlyList<QualityGateRuleDetail>>> ListAsync(Guid projectId, CancellationToken ct = default);
    Task<Result<QualityGateRuleDetail>> CreateAsync(Guid projectId, QualityGateRuleRequest request, CancellationToken ct = default);
    Task<Result<QualityGateRuleDetail>> UpdateAsync(Guid id, QualityGateRuleRequest request, CancellationToken ct = default);
    Task<Result> DeleteAsync(Guid id, CancellationToken ct = default);
}

/// <summary>Configuring what "good enough" means for a project.
///
/// A gate that cannot be changed without a database migration gets worked around rather
/// than tuned, so the rules are ordinary data with an ordinary API. Every change is audited,
/// because relaxing a gate is exactly the kind of decision a team needs to be able to trace
/// back to a person — and the platform is never permitted to relax one on its own.</summary>
public sealed class QualityGateService : IQualityGateService
{
    /// <summary>Metrics expressed as a percentage cannot sensibly sit outside 0-100, and a
    /// threshold that can never be met turns the gate into a permanent block.</summary>
    private static readonly HashSet<QualityGateMetric> Percentages = new() { QualityGateMetric.PassRatePercent };

    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;

    public QualityGateService(IAiraDbContext db, ICurrentUser currentUser, IClock clock, IAuditLogger audit)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
    }

    public async Task<Result<IReadOnlyList<QualityGateRuleDetail>>> ListAsync(Guid projectId, CancellationToken ct = default)
    {
        if (!await _db.Projects.AnyAsync(p => p.Id == projectId, ct))
            return Error.NotFound("The project");

        var rules = await _db.QualityGateRules
            .Where(r => r.ProjectId == projectId)
            .OrderBy(r => r.Name)
            .Select(r => new QualityGateRuleDetail(
                r.Id, r.ProjectId, r.Name, r.Metric, r.Operator, r.Threshold,
                r.IsBlocking, r.IsEnabled, r.CreatedAt, r.UpdatedAt))
            .ToListAsync(ct);

        return Result<IReadOnlyList<QualityGateRuleDetail>>.Success(rules);
    }

    public async Task<Result<QualityGateRuleDetail>> CreateAsync(Guid projectId, QualityGateRuleRequest request, CancellationToken ct = default)
    {
        var organizationId = _currentUser.OrganizationId;
        if (organizationId is null) return Error.Unauthorized();

        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId, ct);
        if (project is null) return Error.NotFound("The project");

        if (Validate(request) is { } invalid) return Result<QualityGateRuleDetail>.Failure(invalid);

        var rule = new QualityGateRule
        {
            OrganizationId = organizationId.Value,
            ProjectId = projectId,
            Name = request.Name.Trim(),
            Metric = request.Metric,
            Operator = request.Operator,
            Threshold = request.Threshold,
            IsBlocking = request.IsBlocking ?? true,
            IsEnabled = request.IsEnabled ?? true,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        _db.QualityGateRules.Add(rule);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.QualityGateChanged, nameof(QualityGateRule), rule.Id,
            $"Quality gate rule '{rule.Name}' created: {rule.Metric} {rule.Operator} {rule.Threshold}"
            + $" ({(rule.IsBlocking ? "blocking" : "warning")}).",
            projectId: projectId, ct: ct);

        return Result<QualityGateRuleDetail>.Success(Map(rule));
    }

    public async Task<Result<QualityGateRuleDetail>> UpdateAsync(Guid id, QualityGateRuleRequest request, CancellationToken ct = default)
    {
        var rule = await _db.QualityGateRules.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (rule is null) return Error.NotFound("The quality gate rule");

        if (Validate(request) is { } invalid) return Result<QualityGateRuleDetail>.Failure(invalid);

        var before = $"{rule.Metric} {rule.Operator} {rule.Threshold} "
            + $"({(rule.IsBlocking ? "blocking" : "warning")}, {(rule.IsEnabled ? "enabled" : "disabled")})";

        rule.Name = request.Name.Trim();
        rule.Metric = request.Metric;
        rule.Operator = request.Operator;
        rule.Threshold = request.Threshold;
        rule.IsBlocking = request.IsBlocking ?? rule.IsBlocking;
        rule.IsEnabled = request.IsEnabled ?? rule.IsEnabled;
        rule.UpdatedByUserId = _currentUser.UserId;
        rule.UpdatedAt = _clock.UtcNow;

        await _db.SaveChangesAsync(ct);

        var after = $"{rule.Metric} {rule.Operator} {rule.Threshold} "
            + $"({(rule.IsBlocking ? "blocking" : "warning")}, {(rule.IsEnabled ? "enabled" : "disabled")})";

        // The before and after both go into the audit entry: "who weakened this gate, and
        // from what" is the question that gets asked after a bad release.
        await _audit.LogAsync(AuditAction.QualityGateChanged, nameof(QualityGateRule), rule.Id,
            $"Quality gate rule '{rule.Name}' changed from {before} to {after}.",
            projectId: rule.ProjectId, ct: ct);

        return Result<QualityGateRuleDetail>.Success(Map(rule));
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var rule = await _db.QualityGateRules.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (rule is null) return Result.Failure(Error.NotFound("The quality gate rule"));

        _db.QualityGateRules.Remove(rule);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.QualityGateChanged, nameof(QualityGateRule), rule.Id,
            $"Quality gate rule '{rule.Name}' ({rule.Metric} {rule.Operator} {rule.Threshold}) was deleted.",
            projectId: rule.ProjectId, ct: ct);

        return Result.Success();
    }

    private static Error? Validate(QualityGateRuleRequest request)
    {
        var errors = new Dictionary<string, string[]>();

        if (string.IsNullOrWhiteSpace(request.Name))
            errors["name"] = new[] { "A rule name is required." };
        else if (request.Name.Trim().Length > 200)
            errors["name"] = new[] { "The rule name must be 200 characters or fewer." };

        if (!Enum.IsDefined(request.Metric))
            errors["metric"] = new[] { "That is not a metric the gate can measure." };
        if (!Enum.IsDefined(request.Operator))
            errors["operator"] = new[] { "That is not a comparison the gate can make." };

        if (request.Threshold < 0)
            errors["threshold"] = new[] { "A threshold cannot be negative." };
        else if (Percentages.Contains(request.Metric) && request.Threshold > 100)
            errors["threshold"] = new[] { "A percentage threshold cannot be above 100." };

        return errors.Count == 0 ? null : Error.Validation("The quality gate rule is not valid.", errors);
    }

    private static QualityGateRuleDetail Map(QualityGateRule rule) => new(
        rule.Id, rule.ProjectId, rule.Name, rule.Metric, rule.Operator, rule.Threshold,
        rule.IsBlocking, rule.IsEnabled, rule.CreatedAt, rule.UpdatedAt);
}
