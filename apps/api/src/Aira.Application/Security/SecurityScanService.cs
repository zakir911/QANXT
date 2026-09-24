using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Security;

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

public sealed record AuthorizeSecurityScopeRequest(
    bool Enabled,
    string AuthorizationNote,
    string AllowedDomains,
    string? AllowedApiDomains,
    string? AllowedPaths,
    string? BlockedPaths,
    Guid? EnvironmentId,
    int MaxRequestsPerSecond,
    int MaxConcurrentRequests,
    int MaxScanDurationMinutes,
    bool AllowActiveTesting,
    bool AllowDestructiveTesting,
    bool AllowProduction);

public sealed record SecurityScopeSummary(
    Guid Id, Guid ApplicationId, bool Enabled, string? AuthorizationNote,
    Guid? AuthorizedByUserId, DateTimeOffset? AuthorizedAt,
    string AllowedDomains, string AllowedApiDomains, string AllowedPaths, string BlockedPaths,
    Guid? EnvironmentId, int MaxRequestsPerSecond, int MaxConcurrentRequests,
    int MaxScanDurationMinutes, bool AllowActiveTesting, bool AllowDestructiveTesting,
    bool AllowProduction);

/// <summary>One finding as the engine reports it.</summary>
public sealed record RecordFindingRequest(
    string Category,
    string Title,
    string TestId,
    string? Endpoint,
    string? HttpMethod,
    string? Parameter,
    string? ObservedAsRole,
    SecuritySeverity Severity,
    SecurityConfidence Confidence,
    string? SeverityFactorsJson,
    string? Cwe,
    string? CweConfidence,
    string? OwaspApiCategory,
    string? OwaspWebCategory,
    string? OwaspEdition,
    string Description,
    string Impact,
    string Remediation,
    string ReproductionSteps,
    string? EvidencePath,
    /// <summary>How many request/response exchanges back this finding. Zero is refused.</summary>
    int ExchangeCount);

public sealed record RecordBlockedRequest(
    string Url, string HttpMethod, SecurityRisk Risk, SecurityDenialReason Reason,
    string Explanation, string? TestId);

public sealed record RecordSecurityScanRequest(
    Guid ApplicationId,
    Guid ProjectId,
    Guid? EnvironmentId,
    SecurityProfile Profile,
    int RequestsIssued,
    int TestsExecuted,
    int TestsSkipped,
    int DurationMs,
    IReadOnlyList<RecordFindingRequest> Findings,
    IReadOnlyList<RecordBlockedRequest>? BlockedRequests,
    /// <summary>The checks the scan was configured to run, and the ones that produced a
    /// verdict. The gate reads both, and a scan that reports neither cannot pass.</summary>
    IReadOnlyList<string>? ChecksConfigured,
    IReadOnlyList<string>? ChecksExecuted,
    IReadOnlyList<string>? UntestedAreas);

public sealed record SecurityFindingSummary(
    Guid Id, string Reference, string Fingerprint, string Category, string Title,
    SecuritySeverity Severity, SecurityConfidence Confidence, SecurityFindingStatus Status,
    string? Cwe, string? OwaspWebCategory, string? OwaspApiCategory,
    string? Endpoint, string? Parameter, string? ObservedAsRole,
    DateTimeOffset FirstSeenAt, DateTimeOffset LastSeenAt,
    DateTimeOffset? ResolvedAt, DateTimeOffset? RegressedAt,
    string? DispositionNote, Guid? DispositionByUserId,
    bool IsNew, bool IsRegression, string? EvidencePath);

public sealed record SecurityScanSummary(
    Guid Id, string Reference, Guid ApplicationId, Guid ProjectId, Guid? EnvironmentId,
    SecurityProfile Profile, string Status, string? AuthorizationNote,
    int RequestsIssued, int RequestsBlocked, int TestsExecuted, int TestsSkipped,
    DateTimeOffset StartedAt, DateTimeOffset? CompletedAt, int DurationMs,
    IReadOnlyList<SecurityFindingSummary> Findings,
    SecurityGateResult Gate);

public sealed record TriageFindingRequest(
    SecurityFindingStatus Status, string? Justification);

public interface ISecurityScanService
{
    Task<Result<SecurityScopeSummary>> GetScopeAsync(Guid applicationId, CancellationToken ct = default);
    Task<Result<SecurityScopeSummary>> AuthorizeScopeAsync(
        Guid applicationId, AuthorizeSecurityScopeRequest request, CancellationToken ct = default);

    Task<Result<SecurityScanSummary>> RecordScanAsync(
        RecordSecurityScanRequest request, CancellationToken ct = default);

    Task<IReadOnlyList<SecurityScanSummary>> ListScansAsync(
        Guid? applicationId, int take, CancellationToken ct = default);
    Task<Result<SecurityScanSummary>> GetScanAsync(Guid id, CancellationToken ct = default);

    Task<IReadOnlyList<SecurityFindingSummary>> ListFindingsAsync(
        Guid? applicationId, SecurityFindingStatus? status, CancellationToken ct = default);

    Task<Result<SecurityFindingSummary>> TriageAsync(
        Guid findingId, TriageFindingRequest request, CancellationToken ct = default);
}

/// <summary>
/// Recording what a security scan did, and what it found.
/// </summary>
/// <remarks>
/// <para>
/// The engine that issues the requests lives outside this service — it runs in the worker or
/// in a golden suite, under the scope guard. What happens here is everything that has to
/// survive the scan: the scope somebody authorized, the findings, the requests the scope
/// refused, and the decisions people made afterwards.
/// </para>
/// <para>
/// Three rules shape the whole file, and each one is a refusal:
/// </para>
/// <list type="bullet">
/// <item>A finding arriving with no exchanges behind it is rejected, not stored. The brief
/// forbids calling a vulnerability confirmed without reproducible evidence, and a store that
/// accepted evidence-free findings would make that unenforceable everywhere downstream.</item>
/// <item>A scan cannot be recorded against an application with no enabled scope. Not
/// "warned about" — refused, with the reason. If the scan somehow ran, that is a defect
/// worth surfacing rather than a record worth keeping.</item>
/// <item>Nothing here marks a finding resolved because it was absent. A finding the scan did
/// not report is left alone unless the check that found it demonstrably ran, and even then it
/// becomes a candidate for a person rather than a resolution.</item>
/// </list>
/// </remarks>
public sealed class SecurityScanService : ISecurityScanService
{
    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IAuditLogger _audit;
    private readonly ILogger<SecurityScanService> _logger;

    public SecurityScanService(
        IAiraDbContext db, ICurrentUser user, IAuditLogger audit, ILogger<SecurityScanService> logger)
    {
        _db = db;
        _user = user;
        _audit = audit;
        _logger = logger;
    }

    // -----------------------------------------------------------------------
    // Scope
    // -----------------------------------------------------------------------

    public async Task<Result<SecurityScopeSummary>> GetScopeAsync(Guid applicationId, CancellationToken ct = default)
    {
        var scope = await _db.SecurityScopes.FirstOrDefaultAsync(s => s.ApplicationId == applicationId, ct);
        return scope is null
            // Deliberately a 404 rather than an empty permissive scope. "There is no scope"
            // and "there is a scope that allows nothing" are different facts, and a caller
            // that receives a default-shaped object tends to treat it as configuration to
            // tweak rather than as an authorization nobody has given.
            ? Result<SecurityScopeSummary>.Failure(Error.NotFound("A security scope for this application"))
            : Result<SecurityScopeSummary>.Success(ToSummary(scope));
    }

    public async Task<Result<SecurityScopeSummary>> AuthorizeScopeAsync(
        Guid applicationId, AuthorizeSecurityScopeRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null) return Result<SecurityScopeSummary>.Failure(Error.NotFound("The application"));

        // Enabling without a written authorization is the one thing this endpoint will not do.
        if (request.Enabled && string.IsNullOrWhiteSpace(request.AuthorizationNote))
        {
            return Result<SecurityScopeSummary>.Failure(Error.Validation(
                "A security scope cannot be enabled without a written authorization. State who authorized "
                + "security testing of this application, on whose behalf, and for what period.",
                new Dictionary<string, string[]>
                {
                    ["authorizationNote"] = new[] { "Required to enable a security scope." }
                }));
        }

        if (request.Enabled && string.IsNullOrWhiteSpace(request.AllowedDomains))
        {
            return Result<SecurityScopeSummary>.Failure(Error.Validation(
                "A security scope cannot be enabled with an empty domain allowlist. An empty allowlist "
                + "permits nothing, and saving one as though it were a working scope hides that.",
                new Dictionary<string, string[]>
                {
                    ["allowedDomains"] = new[] { "Name at least one host." }
                }));
        }

        // Production and destructive testing together is refused outright rather than left to
        // the guard. The guard would refuse each request, which is correct and far too late:
        // by then somebody believes they have configured something that works.
        if (request.AllowProduction && request.AllowDestructiveTesting)
        {
            return Result<SecurityScopeSummary>.Failure(Error.SecurityPolicy(
                "Destructive security testing cannot be authorized against a production environment. "
                + "These two permissions are never held together, whatever the pressure to."));
        }

        if (request.AllowProduction && !_user.HasPermission(Permissions.SecurityProduction))
        {
            return Result<SecurityScopeSummary>.Failure(Error.Forbidden(
                "Authorizing security testing against production requires the security:production "
                + "permission, which is held at organization level."));
        }

        if (request.AllowDestructiveTesting && !_user.HasPermission(Permissions.SecurityScanDestructive))
        {
            return Result<SecurityScopeSummary>.Failure(Error.Forbidden(
                "Authorizing destructive security testing requires the security:scan:destructive permission."));
        }

        var scope = await _db.SecurityScopes.FirstOrDefaultAsync(s => s.ApplicationId == applicationId, ct);
        var creating = scope is null;
        scope ??= new SecurityScope { ApplicationId = applicationId };

        scope.Enabled = request.Enabled;
        scope.AllowedDomains = request.AllowedDomains ?? string.Empty;
        scope.AllowedApiDomains = request.AllowedApiDomains ?? string.Empty;
        scope.AllowedPaths = request.AllowedPaths ?? string.Empty;
        scope.BlockedPaths = request.BlockedPaths ?? string.Empty;
        scope.EnvironmentId = request.EnvironmentId;
        scope.MaxRequestsPerSecond = request.MaxRequestsPerSecond;
        scope.MaxConcurrentRequests = request.MaxConcurrentRequests;
        scope.MaxScanDurationMinutes = request.MaxScanDurationMinutes;
        scope.AllowActiveTesting = request.AllowActiveTesting;
        scope.AllowDestructiveTesting = request.AllowDestructiveTesting;
        scope.AllowProduction = request.AllowProduction;
        scope.AuthorizationNote = request.AuthorizationNote;

        if (request.Enabled)
        {
            // Re-stamped on every enable. An authorization from eighteen months ago, carried
            // forward through six edits, is not the authorization anybody would defend.
            scope.AuthorizedByUserId = _user.UserId;
            scope.AuthorizedAt = DateTimeOffset.UtcNow;
        }

        if (creating) _db.SecurityScopes.Add(scope);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(
            request.Enabled ? AuditAction.SecurityScopeAuthorized : AuditAction.SecurityScopeDisabled,
            nameof(SecurityScope), scope.Id,
            request.Enabled
                ? $"Authorized security testing of application {applicationId}"
                : $"Disabled security testing of application {applicationId}",
            new
            {
                scope.Enabled, scope.AllowedDomains, scope.AllowActiveTesting,
                scope.AllowDestructiveTesting, scope.AllowProduction, scope.AuthorizationNote
            }, ct: ct);

        return Result<SecurityScopeSummary>.Success(ToSummary(scope));
    }

    // -----------------------------------------------------------------------
    // Recording a scan
    // -----------------------------------------------------------------------

    public async Task<Result<SecurityScanSummary>> RecordScanAsync(
        RecordSecurityScanRequest request, CancellationToken ct = default)
    {
        var scope = await _db.SecurityScopes
            .FirstOrDefaultAsync(s => s.ApplicationId == request.ApplicationId, ct);

        if (scope is null || !scope.Enabled || string.IsNullOrWhiteSpace(scope.AuthorizationNote))
        {
            return Result<SecurityScanSummary>.Failure(Error.SecurityPolicy(
                "This application has no enabled security scope carrying a written authorization, so a "
                + "security scan against it cannot be recorded. If a scan ran anyway, that is a defect: "
                + "nothing should have been able to issue those requests."));
        }

        // A finding with nothing behind it is refused at the door rather than stored and
        // filtered later. Once it is in the table, every list, count and report has to
        // remember to exclude it, and one of them will not.
        var evidenceless = request.Findings.Where(f => f.ExchangeCount <= 0).ToList();
        if (evidenceless.Count > 0)
        {
            return Result<SecurityScanSummary>.Failure(Error.Validation(
                $"{evidenceless.Count} finding(s) arrived with no request/response exchange behind them: "
                + string.Join(", ", evidenceless.Select(f => f.Category).Distinct())
                + ". A finding with nothing to show is a claim, not a finding.",
                new Dictionary<string, string[]>
                {
                    ["findings"] = evidenceless.Select(f => $"{f.Category} ({f.TestId}) has no evidence.").ToArray()
                }));
        }

        var now = DateTimeOffset.UtcNow;
        var blocked = request.BlockedRequests ?? Array.Empty<RecordBlockedRequest>();

        var scan = new SecurityScan
        {
            ApplicationId = request.ApplicationId,
            ProjectId = request.ProjectId,
            EnvironmentId = request.EnvironmentId,
            Reference = $"SCAN-{now:yyyyMMdd}-{RandomNumberGenerator.GetHexString(6).ToUpperInvariant()}",
            Profile = request.Profile,
            Status = "completed",
            AuthorizationNote = scope.AuthorizationNote,
            ScopeSnapshotJson = JsonSerializer.Serialize(new
            {
                scope.AllowedDomains, scope.AllowedApiDomains, scope.AllowedPaths, scope.BlockedPaths,
                scope.EnvironmentId, scope.MaxRequestsPerSecond, scope.MaxConcurrentRequests,
                scope.MaxScanDurationMinutes, scope.AllowActiveTesting, scope.AllowDestructiveTesting,
                scope.AllowProduction, scope.AuthorizationNote, scope.AuthorizedByUserId, scope.AuthorizedAt,
                checksConfigured = request.ChecksConfigured ?? Array.Empty<string>(),
                checksExecuted = request.ChecksExecuted ?? Array.Empty<string>(),
                untestedAreas = request.UntestedAreas ?? Array.Empty<string>()
            }),
            RequestsIssued = request.RequestsIssued,
            RequestsBlocked = blocked.Count,
            TestsExecuted = request.TestsExecuted,
            TestsSkipped = request.TestsSkipped,
            StartedAt = now.AddMilliseconds(-request.DurationMs),
            CompletedAt = now,
            DurationMs = request.DurationMs,
            CreatedByUserId = _user.UserId
        };
        _db.SecurityScans.Add(scan);

        foreach (var refused in blocked)
        {
            _db.SecurityBlockedRequests.Add(new SecurityBlockedRequest
            {
                SecurityScanId = scan.Id,
                Url = refused.Url, HttpMethod = refused.HttpMethod,
                Risk = refused.Risk, Reason = refused.Reason,
                Explanation = refused.Explanation, TestId = refused.TestId,
                UserId = _user.UserId, OccurredAt = now
            });
        }

        // Existing findings for this application, so the same flaw found again updates its
        // row rather than arriving as a new one.
        var existing = await _db.SecurityFindings
            .Where(f => f.ApplicationId == request.ApplicationId)
            .ToDictionaryAsync(f => f.Fingerprint, ct);

        var summaries = new List<SecurityFindingSummary>();
        var seen = new HashSet<string>();

        foreach (var reported in request.Findings)
        {
            var fingerprint = Fingerprint(
                request.ApplicationId, reported.Category, reported.Endpoint,
                reported.Parameter, reported.ObservedAsRole);
            seen.Add(fingerprint);

            if (existing.TryGetValue(fingerprint, out var finding))
            {
                var wasResolved = finding.Status == SecurityFindingStatus.Resolved;

                finding.SecurityScanId = scan.Id;
                finding.LastSeenAt = now;
                // The severity is taken from this scan, not carried forward. A flaw somebody
                // accepted at Medium that is now Critical must not inherit the old number
                // along with the decision.
                finding.Severity = reported.Severity;
                finding.Confidence = reported.Confidence;
                finding.SeverityFactorsJson = reported.SeverityFactorsJson;
                finding.Title = reported.Title;
                finding.Description = reported.Description;
                finding.Impact = reported.Impact;
                finding.Remediation = reported.Remediation;
                finding.ReproductionSteps = reported.ReproductionSteps;
                finding.EvidencePath = reported.EvidencePath;
                finding.TestId = reported.TestId;
                finding.UpdatedByUserId = _user.UserId;

                if (wasResolved)
                {
                    // Something that was fixed has come back. The disposition does not survive
                    // it: an acceptance of a flaw that was then repaired says nothing about
                    // the flaw reappearing.
                    finding.Status = SecurityFindingStatus.Regressed;
                    finding.RegressedAt = now;
                    finding.ResolvedAt = null;
                    finding.DispositionNote = null;
                    finding.DispositionByUserId = null;
                    finding.DispositionAt = null;
                }
                else if (finding.Status is SecurityFindingStatus.Potential)
                {
                    // Seen in two independent scans. That is reproduction, which is what the
                    // word Confirmed is reserved for.
                    finding.Status = SecurityFindingStatus.Confirmed;
                }
                else if (finding.Status is SecurityFindingStatus.NeedsReview
                         && finding.DispositionByUserId is null)
                {
                    // It was put in NeedsReview by an earlier scan that could not reproduce it,
                    // and this scan has reproduced it. The note saying a check ran and did not
                    // find it is now false, and leaving it there would tell whoever opens this
                    // finding the opposite of what happened.
                    //
                    // Guarded on DispositionByUserId being null so a person's own NeedsReview
                    // decision is never overwritten by a scan. Only the machine-written one is.
                    finding.Status = SecurityFindingStatus.Confirmed;
                    finding.DispositionNote = null;
                }

                summaries.Add(ToSummary(finding, isNew: false, isRegression: wasResolved));
                continue;
            }

            var created = new SecurityFinding
            {
                ProjectId = request.ProjectId,
                ApplicationId = request.ApplicationId,
                SecurityScanId = scan.Id,
                Fingerprint = fingerprint,
                Reference = $"SF-{now:yyyyMMdd}-{RandomNumberGenerator.GetHexString(6).ToUpperInvariant()}",
                Title = reported.Title,
                Category = reported.Category,
                TestId = reported.TestId,
                Endpoint = reported.Endpoint,
                HttpMethod = reported.HttpMethod,
                Parameter = reported.Parameter,
                ObservedAsRole = reported.ObservedAsRole,
                Severity = reported.Severity,
                Confidence = reported.Confidence,
                // Potential, not Confirmed. One scan is a detection; Confirmed is reserved for
                // something reproduced, which the next scan is what establishes.
                Status = SecurityFindingStatus.Potential,
                SeverityFactorsJson = reported.SeverityFactorsJson,
                Cwe = reported.Cwe,
                CweConfidence = reported.CweConfidence,
                OwaspApiCategory = reported.OwaspApiCategory,
                OwaspWebCategory = reported.OwaspWebCategory,
                OwaspEdition = reported.OwaspEdition,
                Description = reported.Description,
                Impact = reported.Impact,
                Remediation = reported.Remediation,
                ReproductionSteps = reported.ReproductionSteps,
                EvidencePath = reported.EvidencePath,
                FirstSeenAt = now,
                LastSeenAt = now,
                CreatedByUserId = _user.UserId
            };
            _db.SecurityFindings.Add(created);
            summaries.Add(ToSummary(created, isNew: true, isRegression: false));
        }

        // Findings this scan did not report. Nothing here resolves one.
        //
        // The most this can say is that the check which found it ran again and did not
        // reproduce it — which is grounds for a person to close it, and is recorded as
        // NeedsReview rather than as Resolved. Where the check did not run, the finding is
        // left exactly as it was: its absence is not evidence of anything, and treating it
        // as a fix is how a security regression gets hidden.
        var executed = new HashSet<string>(request.ChecksExecuted ?? Array.Empty<string>(),
                                           StringComparer.OrdinalIgnoreCase);
        foreach (var (fingerprint, finding) in existing)
        {
            if (seen.Contains(fingerprint)) continue;
            if (finding.Status is SecurityFindingStatus.Resolved or SecurityFindingStatus.FalsePositive
                or SecurityFindingStatus.Accepted) continue;
            if (!executed.Contains(finding.TestId)) continue;

            finding.Status = SecurityFindingStatus.NeedsReview;
            finding.DispositionNote =
                $"The check that found this ({finding.TestId}) ran in scan {scan.Reference} and did not "
                + "reproduce it. That is grounds for a person to mark it resolved; it is not a resolution "
                + "on its own, and nothing automated may close it.";
            finding.UpdatedByUserId = _user.UserId;
        }

        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.SecurityScanRecorded, nameof(SecurityScan), scan.Id,
            $"Recorded security scan {scan.Reference} against application {request.ApplicationId}",
            new
            {
                scan.Reference, scan.Profile, scan.RequestsIssued, scan.RequestsBlocked,
                findings = summaries.Count,
                newFindings = summaries.Count(s => s.IsNew),
                regressions = summaries.Count(s => s.IsRegression)
            }, ct: ct);

        return Result<SecurityScanSummary>.Success(await BuildScanSummaryAsync(scan, ct));
    }

    // -----------------------------------------------------------------------
    // Reading
    // -----------------------------------------------------------------------

    public async Task<IReadOnlyList<SecurityScanSummary>> ListScansAsync(
        Guid? applicationId, int take, CancellationToken ct = default)
    {
        var query = _db.SecurityScans.AsNoTracking().AsQueryable();
        if (applicationId is { } id) query = query.Where(s => s.ApplicationId == id);

        var scans = await query.OrderByDescending(s => s.StartedAt)
            .Take(Math.Clamp(take, 1, 200)).ToListAsync(ct);

        var summaries = new List<SecurityScanSummary>(scans.Count);
        foreach (var scan in scans) summaries.Add(await BuildScanSummaryAsync(scan, ct));
        return summaries;
    }

    public async Task<Result<SecurityScanSummary>> GetScanAsync(Guid id, CancellationToken ct = default)
    {
        var scan = await _db.SecurityScans.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        return scan is null
            ? Result<SecurityScanSummary>.Failure(Error.NotFound("The security scan"))
            : Result<SecurityScanSummary>.Success(await BuildScanSummaryAsync(scan, ct));
    }

    public async Task<IReadOnlyList<SecurityFindingSummary>> ListFindingsAsync(
        Guid? applicationId, SecurityFindingStatus? status, CancellationToken ct = default)
    {
        var query = _db.SecurityFindings.AsNoTracking().AsQueryable();
        if (applicationId is { } id) query = query.Where(f => f.ApplicationId == id);
        if (status is { } s) query = query.Where(f => f.Status == s);

        var findings = await query
            .OrderByDescending(f => f.Severity).ThenByDescending(f => f.LastSeenAt)
            .Take(500).ToListAsync(ct);

        return findings.Select(f => ToSummary(f, isNew: false, isRegression: f.RegressedAt != null)).ToList();
    }

    // -----------------------------------------------------------------------
    // Triage
    // -----------------------------------------------------------------------

    public async Task<Result<SecurityFindingSummary>> TriageAsync(
        Guid findingId, TriageFindingRequest request, CancellationToken ct = default)
    {
        var finding = await _db.SecurityFindings.FirstOrDefaultAsync(f => f.Id == findingId, ct);
        if (finding is null) return Result<SecurityFindingSummary>.Failure(Error.NotFound("The security finding"));

        // The statuses that stop a finding counting against a gate. Each needs a reason and a
        // person, and the refusal is the feature: a suppression with nothing behind it is
        // somebody switching the check off, and a workflow that accepts it quietly is how a
        // security gate becomes decoration.
        var needsAPerson = request.Status is SecurityFindingStatus.FalsePositive
            or SecurityFindingStatus.Accepted or SecurityFindingStatus.Resolved;

        if (needsAPerson)
        {
            if (_user.UserId is null)
            {
                return Result<SecurityFindingSummary>.Failure(Error.Forbidden(
                    $"Marking a finding {request.Status} requires a named person. Nothing automated may "
                    + "set a security finding aside, including AIRA's own self-healing."));
            }
            if (string.IsNullOrWhiteSpace(request.Justification) || request.Justification.Trim().Length < 20)
            {
                return Result<SecurityFindingSummary>.Failure(Error.Validation(
                    $"Marking a finding {request.Status} requires a written justification saying what was "
                    + "checked and what it showed. A suppression with no stated reason is indistinguishable "
                    + "from turning the check off.",
                    new Dictionary<string, string[]>
                    {
                        ["justification"] = new[] { "At least 20 characters describing what was verified." }
                    }));
            }
        }

        var from = finding.Status;
        finding.Status = request.Status;
        finding.DispositionNote = request.Justification;
        finding.DispositionByUserId = needsAPerson ? _user.UserId : null;
        finding.DispositionAt = needsAPerson ? DateTimeOffset.UtcNow : null;
        finding.ResolvedAt = request.Status == SecurityFindingStatus.Resolved
            ? DateTimeOffset.UtcNow : finding.ResolvedAt;
        finding.UpdatedByUserId = _user.UserId;

        await _db.SaveChangesAsync(ct);

        // The audit record is the history. The entity holds the latest answer, and a field
        // holding only the latest answer is not an audit trail.
        await _audit.LogAsync(AuditAction.SecurityFindingTriaged, nameof(SecurityFinding), finding.Id,
            $"{finding.Reference} ({finding.Category}) moved from {from} to {request.Status}",
            new { from, to = request.Status, justification = request.Justification }, ct: ct);

        return Result<SecurityFindingSummary>.Success(
            ToSummary(finding, isNew: false, isRegression: finding.RegressedAt != null));
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// <summary>
    /// A stable identity for a finding across scans.
    /// </summary>
    /// <remarks>
    /// Application, category, endpoint, parameter and the role it was observed as. Not the
    /// severity (the model can revise it), the title (it can be reworded) or any response
    /// value. A fingerprint including those would report a new finding every time anything
    /// was rephrased, and a team that sees a wall of new findings every run stops reading.
    /// </remarks>
    public static string Fingerprint(
        Guid applicationId, string category, string? endpoint, string? parameter, string? observedAsRole)
    {
        var parts = string.Join('\u0000', applicationId, category, endpoint ?? "", parameter ?? "",
                                observedAsRole ?? "");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(parts)))[..32].ToLowerInvariant();
    }

    private async Task<SecurityScanSummary> BuildScanSummaryAsync(SecurityScan scan, CancellationToken ct)
    {
        var findings = await _db.SecurityFindings.AsNoTracking()
            .Where(f => f.SecurityScanId == scan.Id)
            .OrderByDescending(f => f.Severity)
            .ToListAsync(ct);

        var summaries = findings
            .Select(f => ToSummary(f, isNew: f.FirstSeenAt == f.LastSeenAt, isRegression: f.RegressedAt != null))
            .ToList();

        // Checks configured and executed come from the snapshot taken when the scan was
        // recorded, so a gate evaluated later reads the same numbers the scan reported rather
        // than whatever the scope says today.
        var snapshot = ReadSnapshot(scan.ScopeSnapshotJson);

        var gate = SecurityGateEvaluator.Evaluate(
            new SecurityScanCoverage(
                ScanRan: true,
                Profile: scan.Profile,
                RequestsIssued: scan.RequestsIssued,
                RequestsBlocked: scan.RequestsBlocked,
                ChecksConfigured: snapshot.Configured,
                ChecksExecuted: snapshot.Executed,
                UntestedAreas: snapshot.Untested),
            summaries.Select(f => new SecurityGateFinding(
                f.Id.ToString(), f.Category, f.Severity, f.Confidence, f.Status,
                f.IsNew, f.IsRegression, f.DispositionNote, f.DispositionByUserId?.ToString(),
                HasEvidence: true)).ToList());

        return new SecurityScanSummary(
            scan.Id, scan.Reference, scan.ApplicationId, scan.ProjectId, scan.EnvironmentId,
            scan.Profile, scan.Status, scan.AuthorizationNote,
            scan.RequestsIssued, scan.RequestsBlocked, scan.TestsExecuted, scan.TestsSkipped,
            scan.StartedAt, scan.CompletedAt, scan.DurationMs, summaries, gate);
    }

    private (string[] Configured, string[] Executed, string[] Untested) ReadSnapshot(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return (Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
        try
        {
            using var document = JsonDocument.Parse(json);
            string[] Read(string name) =>
                document.RootElement.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Array
                    ? element.EnumerateArray().Select(e => e.GetString() ?? string.Empty).ToArray()
                    : Array.Empty<string>();
            return (Read("checksConfigured"), Read("checksExecuted"), Read("untestedAreas"));
        }
        catch (JsonException error)
        {
            // A snapshot we cannot read means the gate sees no checks, which makes it REVIEW
            // rather than PASS. That is the right direction to fail in.
            _logger.LogWarning(error, "A security scan's scope snapshot could not be parsed.");
            return (Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
        }
    }

    private static SecurityScopeSummary ToSummary(SecurityScope s) => new(
        s.Id, s.ApplicationId, s.Enabled, s.AuthorizationNote, s.AuthorizedByUserId, s.AuthorizedAt,
        s.AllowedDomains, s.AllowedApiDomains, s.AllowedPaths, s.BlockedPaths, s.EnvironmentId,
        s.MaxRequestsPerSecond, s.MaxConcurrentRequests, s.MaxScanDurationMinutes,
        s.AllowActiveTesting, s.AllowDestructiveTesting, s.AllowProduction);

    private static SecurityFindingSummary ToSummary(SecurityFinding f, bool isNew, bool isRegression) => new(
        f.Id, f.Reference, f.Fingerprint, f.Category, f.Title, f.Severity, f.Confidence, f.Status,
        f.Cwe, f.OwaspWebCategory, f.OwaspApiCategory, f.Endpoint, f.Parameter, f.ObservedAsRole,
        f.FirstSeenAt, f.LastSeenAt, f.ResolvedAt, f.RegressedAt,
        f.DispositionNote, f.DispositionByUserId, isNew, isRegression, f.EvidencePath);
}
