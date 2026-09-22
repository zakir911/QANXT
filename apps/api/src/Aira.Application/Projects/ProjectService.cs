using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Projects;

public sealed record CreateProjectRequest(string Name, string Key, string? Description);

public sealed record UpdateProjectRequest(
    string? Name, string? Description, BrowserType? DefaultBrowser, int? DefaultRetries,
    int? MaxParallelExecutions, int? DefaultActionTimeoutMs, bool? CaptureVideo, bool? CaptureTrace,
    bool? CaptureHar, HealingPolicy? HealingPolicy, int? HealingConfidenceThreshold,
    LlmProviderKind? AiProvider, string? AiModel, bool? AiEnabled, bool? AllowScriptExecution,
    SelfHealingGatePolicy? SelfHealingGatePolicy = null);

public sealed record ProjectSummary(Guid Id, string Name, string Key, string Description,
    int ApplicationCount, int TestCaseCount, int OpenDefectCount, DateTimeOffset CreatedAt);

public sealed record ProjectDetail(Guid Id, string Name, string Key, string Description,
    BrowserType DefaultBrowser, int DefaultRetries, int MaxParallelExecutions, int DefaultActionTimeoutMs,
    bool CaptureVideo, bool CaptureTrace, bool CaptureHar, HealingPolicy HealingPolicy,
    int HealingConfidenceThreshold, LlmProviderKind AiProvider, string? AiModel, bool AiEnabled,
    bool AllowScriptExecution, SelfHealingGatePolicy SelfHealingGatePolicy,
    DateTimeOffset CreatedAt, DateTimeOffset? UpdatedAt);

public interface IProjectService
{
    Task<IReadOnlyList<ProjectSummary>> ListAsync(CancellationToken ct = default);
    Task<Result<ProjectDetail>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<ProjectDetail>> CreateAsync(CreateProjectRequest request, CancellationToken ct = default);
    Task<Result<ProjectDetail>> UpdateAsync(Guid id, UpdateProjectRequest request, CancellationToken ct = default);
    Task<Result> DeleteAsync(Guid id, CancellationToken ct = default);
}

public sealed class ProjectService : IProjectService
{
    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;

    public ProjectService(IAiraDbContext db, ICurrentUser currentUser, IClock clock, IAuditLogger audit)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
    }

    public async Task<IReadOnlyList<ProjectSummary>> ListAsync(CancellationToken ct = default)
    {
        // Counts are computed in the database rather than by loading collections, so the
        // list stays cheap as projects grow.
        return await _db.Projects
            .OrderBy(p => p.Name)
            .Select(p => new ProjectSummary(
                p.Id, p.Name, p.Key, p.Description,
                _db.Applications.Count(a => a.ProjectId == p.Id),
                _db.TestCases.Count(tc => tc.ProjectId == p.Id),
                _db.Defects.Count(d => d.ProjectId == p.Id &&
                    (d.Status == DefectStatus.Open || d.Status == DefectStatus.Triaged || d.Status == DefectStatus.InProgress)),
                p.CreatedAt))
            .ToListAsync(ct);
    }

    public async Task<Result<ProjectDetail>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == id, ct);
        return project is null ? Error.NotFound("The project") : Result<ProjectDetail>.Success(Map(project));
    }

    public async Task<Result<ProjectDetail>> CreateAsync(CreateProjectRequest request, CancellationToken ct = default)
    {
        var organizationId = _currentUser.OrganizationId;
        if (organizationId is null) return Error.Unauthorized();

        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrWhiteSpace(request.Name)) errors["name"] = new[] { "A project name is required." };

        var key = (request.Key ?? string.Empty).Trim().ToUpperInvariant();
        if (string.IsNullOrWhiteSpace(key)) errors["key"] = new[] { "A project key is required." };
        else if (key.Length > 40) errors["key"] = new[] { "The project key must be 40 characters or fewer." };
        else if (!key.All(c => char.IsLetterOrDigit(c) || c == '-' || c == '_'))
            errors["key"] = new[] { "The project key may contain only letters, digits, hyphens and underscores." };

        if (errors.Count > 0) return Error.Validation("The project details are not valid.", errors);

        if (await _db.Projects.AnyAsync(p => p.Key == key, ct))
            return Error.Conflict("project_key_taken", $"A project with the key '{key}' already exists.");

        var project = new Project
        {
            OrganizationId = organizationId.Value,
            Name = request.Name.Trim(),
            Key = key,
            Description = request.Description?.Trim() ?? string.Empty,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        _db.Projects.Add(project);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ProjectCreated, nameof(Project), project.Id,
            $"Project '{project.Name}' ({project.Key}) created.", projectId: project.Id, ct: ct);

        return Result<ProjectDetail>.Success(Map(project));
    }

    public async Task<Result<ProjectDetail>> UpdateAsync(Guid id, UpdateProjectRequest request, CancellationToken ct = default)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (project is null) return Error.NotFound("The project");

        if (request.HealingConfidenceThreshold is < 0 or > 100)
            return Error.Validation("The healing confidence threshold must be between 0 and 100.");
        if (request.MaxParallelExecutions is < 1 or > 50)
            return Error.Validation("Parallelism must be between 1 and 50.");
        if (request.DefaultActionTimeoutMs is < 1000 or > 300_000)
            return Error.Validation("The default action timeout must be between 1000 and 300000 milliseconds.");
        if (request.DefaultRetries is < 0 or > 5)
            return Error.Validation("Retries must be between 0 and 5.");

        var before = Map(project);

        if (request.Name is not null) project.Name = request.Name.Trim();
        if (request.Description is not null) project.Description = request.Description.Trim();
        if (request.DefaultBrowser is not null) project.DefaultBrowser = request.DefaultBrowser.Value;
        if (request.DefaultRetries is not null) project.DefaultRetries = request.DefaultRetries.Value;
        if (request.MaxParallelExecutions is not null) project.MaxParallelExecutions = request.MaxParallelExecutions.Value;
        if (request.DefaultActionTimeoutMs is not null) project.DefaultActionTimeoutMs = request.DefaultActionTimeoutMs.Value;
        if (request.CaptureVideo is not null) project.CaptureVideo = request.CaptureVideo.Value;
        if (request.CaptureTrace is not null) project.CaptureTrace = request.CaptureTrace.Value;
        if (request.CaptureHar is not null) project.CaptureHar = request.CaptureHar.Value;
        if (request.HealingPolicy is not null) project.HealingPolicy = request.HealingPolicy.Value;
        if (request.HealingConfidenceThreshold is not null) project.HealingConfidenceThreshold = request.HealingConfidenceThreshold.Value;
        if (request.AiProvider is not null) project.AiProvider = request.AiProvider.Value;
        if (request.AiModel is not null) project.AiModel = string.IsNullOrWhiteSpace(request.AiModel) ? null : request.AiModel.Trim();
        if (request.AiEnabled is not null) project.AiEnabled = request.AiEnabled.Value;

        // Turning on scripting widens what an AI-authored plan may do, so it is audited
        // separately from the rest of the settings change.
        if (request.AllowScriptExecution is not null && request.AllowScriptExecution.Value != project.AllowScriptExecution)
        {
            project.AllowScriptExecution = request.AllowScriptExecution.Value;
            await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(Project), project.Id,
                $"Script execution {(project.AllowScriptExecution ? "enabled" : "disabled")} for project '{project.Name}'.",
                projectId: project.Id, ct: ct);
        }

        // What a healed test does to the quality gate is a release-policy decision, so a
        // change to it is audited in its own right rather than folded into "settings changed".
        if (request.SelfHealingGatePolicy is not null
            && request.SelfHealingGatePolicy.Value != project.SelfHealingGatePolicy)
        {
            var was = project.SelfHealingGatePolicy;
            project.SelfHealingGatePolicy = request.SelfHealingGatePolicy.Value;
            await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(Project), project.Id,
                $"Self-healing quality gate policy changed from {was} to {project.SelfHealingGatePolicy} "
                + $"for project '{project.Name}'.",
                projectId: project.Id, ct: ct);
        }

        project.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        var after = Map(project);
        await _audit.LogAsync(AuditAction.ProjectUpdated, nameof(Project), project.Id,
            $"Project '{project.Name}' updated.", new { before, after }, projectId: project.Id, ct: ct);

        return Result<ProjectDetail>.Success(after);
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (project is null) return Result.Failure(Error.NotFound("The project"));

        // Soft delete: historical runs, evidence and defects must remain interpretable.
        project.DeletedAt = _clock.UtcNow;
        project.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ProjectDeleted, nameof(Project), project.Id,
            $"Project '{project.Name}' deleted.", projectId: project.Id, ct: ct);

        return Result.Success();
    }

    private static ProjectDetail Map(Project p) => new(
        p.Id, p.Name, p.Key, p.Description, p.DefaultBrowser, p.DefaultRetries, p.MaxParallelExecutions,
        p.DefaultActionTimeoutMs, p.CaptureVideo, p.CaptureTrace, p.CaptureHar, p.HealingPolicy,
        p.HealingConfidenceThreshold, p.AiProvider, p.AiModel, p.AiEnabled, p.AllowScriptExecution,
        p.SelfHealingGatePolicy, p.CreatedAt, p.UpdatedAt);
}
