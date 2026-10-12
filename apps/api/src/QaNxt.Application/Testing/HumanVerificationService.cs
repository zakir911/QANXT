using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;

namespace QaNxt.Application.Testing;

public sealed record HumanTaskView(
    Guid Id, Guid ProjectId, Guid? ApplicationId, Guid? FormId, string? FormName, Guid? TestCaseId, string Title, string Category,
    string Reason, string Steps, string ExpectedResult, HumanTaskStatus Status, string? Comments,
    IReadOnlyList<HumanTaskEvidence> Evidence, string Origin, Guid? CompletedByUserId, DateTimeOffset? CompletedAt, DateTimeOffset CreatedAt);

public sealed record HumanTaskEvidence(string StorageKey, string Name, string ContentType, long SizeBytes, DateTimeOffset UploadedAt);

public sealed record CreateHumanTaskRequest(Guid ProjectId, Guid? ApplicationId, string Title, TestCategory Category,
    string Reason, string Steps, string ExpectedResult, Guid? TestCaseId);

public sealed record RecordHumanVerdictRequest(HumanTaskStatus Status, string? Comments);

public interface IHumanVerificationService
{
    Task<IReadOnlyList<HumanTaskView>> ListAsync(Guid projectId, Guid? applicationId, HumanTaskStatus? status, CancellationToken ct = default);
    Task<Result<HumanTaskView>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<HumanTaskView>> CreateAsync(CreateHumanTaskRequest request, CancellationToken ct = default);
    Task<Result<HumanTaskView>> RecordVerdictAsync(Guid id, RecordHumanVerdictRequest request, CancellationToken ct = default);
    Task<Result<HumanTaskView>> AttachEvidenceAsync(Guid id, string fileName, string contentType, Stream content, CancellationToken ct = default);
}

/// <summary>The checks only a person can make, done and recorded like any other result.
///
/// A task carries why a machine could not decide it, what to do and what should happen. Its
/// verdict is a person's, recorded with who gave it and when, with evidence they attach. A
/// verdict is never changed by regeneration or by anything else the platform does.</summary>
public sealed class HumanVerificationService : IHumanVerificationService
{
    private static readonly string[] AllowedEvidence = { "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "video/webm", "video/mp4" };
    private const long MaxEvidenceBytes = 25 * 1024 * 1024;

    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly IArtifactStore _store;

    public HumanVerificationService(IQaNxtDbContext db, ICurrentUser currentUser, IClock clock, IAuditLogger audit, IArtifactStore store)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _store = store;
    }

    public async Task<IReadOnlyList<HumanTaskView>> ListAsync(Guid projectId, Guid? applicationId, HumanTaskStatus? status, CancellationToken ct = default)
    {
        var query = _db.HumanVerificationTasks.Where(t => t.ProjectId == projectId);
        if (applicationId is not null) query = query.Where(t => t.ApplicationId == applicationId);
        if (status is not null) query = query.Where(t => t.Status == status);
        var tasks = await query.OrderBy(t => t.Status).ThenBy(t => t.Category).ThenBy(t => t.Title).ToListAsync(ct);
        var formIds = tasks.Where(t => t.ApplicationFormId != null).Select(t => t.ApplicationFormId!.Value).Distinct().ToList();
        var names = await _db.ApplicationForms.Where(f => formIds.Contains(f.Id)).ToDictionaryAsync(f => f.Id, f => f.Name, ct);
        return tasks.Select(t => View(t, t.ApplicationFormId is { } id && names.TryGetValue(id, out var n) ? n : null)).ToList();
    }

    public async Task<Result<HumanTaskView>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var task = await _db.HumanVerificationTasks.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (task is null) return Error.NotFound("The verification task");
        var name = task.ApplicationFormId is null ? null : await _db.ApplicationForms.Where(f => f.Id == task.ApplicationFormId).Select(f => f.Name).FirstOrDefaultAsync(ct);
        return Result<HumanTaskView>.Success(View(task, name));
    }

    public async Task<Result<HumanTaskView>> CreateAsync(CreateHumanTaskRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Title)) return Error.Validation("A task needs a title.");
        if (!await _db.Projects.AnyAsync(p => p.Id == request.ProjectId, ct)) return Error.NotFound("The project");
        var task = new HumanVerificationTask
        {
            ProjectId = request.ProjectId, ApplicationId = request.ApplicationId, TestCaseId = request.TestCaseId,
            Title = Truncate(request.Title.Trim(), 300), Category = request.Category, Reason = Truncate(request.Reason ?? string.Empty, 2000),
            Steps = Truncate(request.Steps ?? string.Empty, 4000), ExpectedResult = Truncate(request.ExpectedResult ?? string.Empty, 2000),
            Origin = "manual", CreatedAt = _clock.UtcNow
        };
        _db.HumanVerificationTasks.Add(task);
        await _db.SaveChangesAsync(ct);
        return Result<HumanTaskView>.Success(View(task, null));
    }

    public async Task<Result<HumanTaskView>> RecordVerdictAsync(Guid id, RecordHumanVerdictRequest request, CancellationToken ct = default)
    {
        var task = await _db.HumanVerificationTasks.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (task is null) return Error.NotFound("The verification task");
        if (request.Status is HumanTaskStatus.Failed && string.IsNullOrWhiteSpace(request.Comments))
            return Error.Validation("Say what was wrong. A failed verification without a comment cannot be acted on.");

        task.Status = request.Status;
        task.Comments = request.Comments is null ? task.Comments : Truncate(request.Comments.Trim(), 4000);
        task.CompletedByUserId = request.Status == HumanTaskStatus.Pending ? null : _currentUser.UserId;
        task.CompletedAt = request.Status == HumanTaskStatus.Pending ? null : _clock.UtcNow;
        await _db.SaveChangesAsync(ct);
        await _audit.LogAsync(AuditAction.TestCaseUpdated, nameof(HumanVerificationTask), task.Id,
            $"Human verification \"{task.Title}\" recorded as {request.Status}.", projectId: task.ProjectId, ct: ct);
        return await GetAsync(id, ct);
    }

    public async Task<Result<HumanTaskView>> AttachEvidenceAsync(Guid id, string fileName, string contentType, Stream content, CancellationToken ct = default)
    {
        var task = await _db.HumanVerificationTasks.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (task is null) return Error.NotFound("The verification task");
        if (!AllowedEvidence.Contains(contentType)) return Error.Validation($"Evidence must be an image, PDF, plain text or video; {contentType} is not accepted.");

        using var buffer = new MemoryStream();
        await content.CopyToAsync(buffer, ct);
        if (buffer.Length == 0) return Error.Validation("The file is empty.");
        if (buffer.Length > MaxEvidenceBytes) return Error.Validation("Evidence files are limited to 25 MB.");
        buffer.Position = 0;

        var stored = await _store.PutAsync(task.OrganizationId, Path.GetFileName(fileName), contentType, buffer, ct);
        var evidence = Evidence(task).ToList();
        evidence.Add(new HumanTaskEvidence(stored.StorageKey, Path.GetFileName(fileName), contentType, buffer.Length, _clock.UtcNow));
        task.EvidenceJson = JsonSerializer.Serialize(evidence);
        await _db.SaveChangesAsync(ct);
        return await GetAsync(id, ct);
    }

    private static IReadOnlyList<HumanTaskEvidence> Evidence(HumanVerificationTask task)
    {
        if (string.IsNullOrWhiteSpace(task.EvidenceJson)) return Array.Empty<HumanTaskEvidence>();
        try { return JsonSerializer.Deserialize<List<HumanTaskEvidence>>(task.EvidenceJson) ?? new List<HumanTaskEvidence>(); }
        catch (JsonException) { return Array.Empty<HumanTaskEvidence>(); }
    }

    private static HumanTaskView View(HumanVerificationTask t, string? formName) => new(
        t.Id, t.ProjectId, t.ApplicationId, t.ApplicationFormId, formName, t.TestCaseId, t.Title, Forms.TestingProfile.CategoryKey(t.Category),
        t.Reason, t.Steps, t.ExpectedResult, t.Status, t.Comments, Evidence(t), t.Origin, t.CompletedByUserId, t.CompletedAt, t.CreatedAt);

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
