using System.Security.Cryptography;
using System.Text;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Domain.Applications;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Applications;

public sealed record CaptureBaselinesRequest(
    Guid ApplicationId,
    /// <summary>Restricts capture to these inventory entries; empty means every endpoint
    /// that has a usable response sample.</summary>
    Guid[]? ApiEndpointIds = null,
    /// <summary>Replaces an existing baseline rather than leaving it alone. Recording why
    /// is required, because accepting a new contract is a decision.</summary>
    bool Replace = false,
    string? Note = null);

public sealed record CapturedBaseline(
    Guid ContractId, string Method, string UrlTemplate, int Version, int FieldCount, int? StatusCode);

public sealed record CaptureBaselinesResult(
    int Captured, int Replaced, int Skipped,
    IReadOnlyList<CapturedBaseline> Baselines,
    IReadOnlyList<string> Notes);

public sealed record ContractCheckResult(
    Guid? TestRunId,
    Guid? DiscoveryRunId,
    int EndpointsObserved,
    int EndpointsWithBaseline,
    int EndpointsWithoutBaseline,
    int BreakingCount,
    int PotentiallyBreakingCount,
    int NonBreakingCount,
    IReadOnlyList<ContractChangeSummary> Changes,
    IReadOnlyList<string> Notes);

public sealed record ContractChangeSummary(
    Guid Id, string Method, string UrlTemplate, ContractChangeKind Kind,
    string Path, string? BaselineType, string? ObservedType, string Description,
    bool IsAcknowledged);

public sealed record ApiInventoryEntry(
    Guid Id, string Method, string UrlTemplate, string SampleUrl, int TimesObserved,
    int? LastStatusCode, int AverageDurationMs, bool RequiresAuthentication,
    string? ResponseContentType, DateTimeOffset LastSeenAt,
    bool HasBaseline, int? BaselineVersion, int? BaselineFieldCount,
    int TestCount, int OpenBreakingChangeCount);

public sealed record ApiInventory(
    Guid ApplicationId, string ApplicationName,
    int EndpointCount, int CoveredEndpointCount, int BaselinedEndpointCount,
    IReadOnlyList<ApiInventoryEntry> Endpoints);

public interface IApiContractService
{
    Task<Result<ApiInventory>> InventoryAsync(Guid applicationId, CancellationToken ct = default);
    Task<Result<CaptureBaselinesResult>> CaptureBaselinesAsync(CaptureBaselinesRequest request, CancellationToken ct = default);
    Task<Result<ContractCheckResult>> CheckRunAsync(Guid testRunId, CancellationToken ct = default);
    Task<Result<ContractCheckResult>> CheckDiscoveryAsync(Guid discoveryRunId, CancellationToken ct = default);
    Task<Result<ContractCheckResult>> ChangesForRunAsync(Guid testRunId, CancellationToken ct = default);
    Task<Result> AcknowledgeAsync(Guid changeId, string note, CancellationToken ct = default);
}

/// <summary>API contracts: what an endpoint's response looked like when someone accepted it,
/// and what has moved since.
///
/// The baseline is an observation, not a specification. AIRA infers it from a response the
/// application actually gave — while crawling, or while an API test called it — which is why
/// contract testing works on an API that has no OpenAPI document and never will. A team with
/// a specification can declare a baseline instead; the comparison does not care.
///
/// What it compares against is evidence a run already produced. That is the part worth
/// stating: nothing here sends a request. A run records every response it received, so the
/// contract check reads that record. It therefore covers API tests and the calls the UI made
/// while being driven, needs no second pass against the application, and — because the
/// evidence is stored — the decision a quality gate made about a release stays explainable
/// after the application has moved on.</summary>
public sealed class ApiContractService : IApiContractService
{
    /// <summary>Content types a response shape can be inferred from. An HTML error page is
    /// not a contract, and inferring one from it would produce a baseline that fails for
    /// ever.</summary>
    private static bool IsJson(string? contentType) =>
        contentType is not null && contentType.Contains("json", StringComparison.OrdinalIgnoreCase);

    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ILogger<ApiContractService> _logger;

    public ApiContractService(
        IAiraDbContext db, ICurrentUser user, IClock clock, IAuditLogger audit,
        ILogger<ApiContractService> logger)
    {
        _db = db;
        _user = user;
        _clock = clock;
        _audit = audit;
        _logger = logger;
    }

    public async Task<Result<ApiInventory>> InventoryAsync(Guid applicationId, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null) return Error.NotFound("The application");

        var endpoints = await _db.ApiEndpoints
            .Where(e => e.ApplicationId == applicationId)
            .OrderByDescending(e => e.TimesObserved)
            .ToListAsync(ct);

        var baselines = await _db.ApiContracts
            .Where(c => c.ApplicationId == applicationId && c.IsBaseline)
            .Select(c => new { c.Method, c.UrlTemplate, c.Version, c.ResponseSchemaJson })
            .ToListAsync(ct);

        var baselineByKey = baselines.ToDictionary(
            b => Key(b.Method, b.UrlTemplate),
            b => new { b.Version, Fields = ApiSchemaShape.FromJson(b.ResponseSchemaJson)?.FieldCount ?? 0 },
            StringComparer.OrdinalIgnoreCase);

        var openBreaking = await _db.ApiContractChanges
            .Where(c => c.ApplicationId == applicationId
                        && c.Kind == ContractChangeKind.Breaking && !c.IsAcknowledged)
            .GroupBy(c => new { c.Method, c.UrlTemplate })
            .Select(g => new { g.Key.Method, g.Key.UrlTemplate, Count = g.Count() })
            .ToListAsync(ct);

        var breakingByKey = openBreaking.ToDictionary(
            c => Key(c.Method, c.UrlTemplate), c => c.Count, StringComparer.OrdinalIgnoreCase);

        // Coverage: which endpoints an API test actually calls. Read from the stored steps
        // rather than from a tag, so it is what the tests do rather than what they claim.
        var testCounts = await CountTestsPerEndpointAsync(applicationId, endpoints, ct);

        var entries = endpoints.Select(endpoint =>
        {
            var key = Key(endpoint.Method, endpoint.UrlTemplate);
            baselineByKey.TryGetValue(key, out var baseline);
            return new ApiInventoryEntry(
                endpoint.Id, endpoint.Method, endpoint.UrlTemplate, endpoint.SampleUrl,
                endpoint.TimesObserved, endpoint.LastStatusCode, endpoint.AverageDurationMs,
                endpoint.RequiresAuthentication, endpoint.ResponseContentType, endpoint.LastSeenAt,
                HasBaseline: baseline is not null,
                BaselineVersion: baseline?.Version,
                BaselineFieldCount: baseline?.Fields,
                TestCount: testCounts.GetValueOrDefault(key, 0),
                OpenBreakingChangeCount: breakingByKey.GetValueOrDefault(key, 0));
        }).ToList();

        return Result<ApiInventory>.Success(new ApiInventory(
            applicationId, application.Name,
            entries.Count,
            entries.Count(e => e.TestCount > 0),
            entries.Count(e => e.HasBaseline),
            entries));
    }

    public async Task<Result<CaptureBaselinesResult>> CaptureBaselinesAsync(
        CaptureBaselinesRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");

        if (request.Replace && string.IsNullOrWhiteSpace(request.Note))
        {
            return Error.Validation(
                "Replacing a contract baseline needs a note saying why the new shape is acceptable. "
                + "Accepting a contract change is a decision, and it has to be attributable.");
        }

        var query = _db.ApiEndpoints.Where(e => e.ApplicationId == request.ApplicationId);
        if (request.ApiEndpointIds is { Length: > 0 })
            query = query.Where(e => request.ApiEndpointIds.Contains(e.Id));

        var endpoints = await query.ToListAsync(ct);
        if (endpoints.Count == 0)
        {
            return Error.Validation(
                "There are no discovered API endpoints to baseline. Run discovery against the "
                + "application first, or declare a contract explicitly.");
        }

        var existing = await _db.ApiContracts
            .Where(c => c.ApplicationId == request.ApplicationId && c.IsBaseline)
            .ToListAsync(ct);
        var existingByKey = existing.ToDictionary(
            c => Key(c.Method, c.UrlTemplate), StringComparer.OrdinalIgnoreCase);

        var notes = new List<string>();
        var captured = new List<CapturedBaseline>();
        var replaced = 0;
        var skipped = 0;

        foreach (var endpoint in endpoints)
        {
            var key = Key(endpoint.Method, endpoint.UrlTemplate);

            if (!IsJson(endpoint.ResponseContentType))
            {
                skipped++;
                notes.Add($"{endpoint.Method} {endpoint.UrlTemplate}: the observed response is "
                    + $"{endpoint.ResponseContentType ?? "of no recorded type"}, which no shape can be "
                    + "inferred from. Skipped rather than baselined as empty.");
                continue;
            }

            var shape = ApiSchemaShape.Infer(endpoint.ResponseSampleJson);
            if (shape is null || shape.FieldCount == 0)
            {
                skipped++;
                notes.Add($"{endpoint.Method} {endpoint.UrlTemplate}: no usable response sample was "
                    + "recorded, so there is nothing to baseline.");
                continue;
            }

            if (existingByKey.TryGetValue(key, out var current))
            {
                if (!request.Replace)
                {
                    skipped++;
                    notes.Add($"{endpoint.Method} {endpoint.UrlTemplate}: already has baseline "
                        + $"v{current.Version}. Pass replace to accept a new shape.");
                    continue;
                }
                current.IsBaseline = false;
                replaced++;
            }

            var contract = new ApiContract
            {
                OrganizationId = application.OrganizationId,
                ApplicationId = application.Id,
                ApiEndpointId = endpoint.Id,
                Method = endpoint.Method,
                UrlTemplate = endpoint.UrlTemplate,
                StatusCode = endpoint.LastStatusCode,
                ResponseSchemaJson = shape.ToJson(),
                RequestSchemaJson = ApiSchemaShape.Infer(endpoint.RequestSampleJson)?.ToJson(),
                ResponseContentType = endpoint.ResponseContentType,
                SourceSampleSha256 = Sha256(endpoint.ResponseSampleJson),
                Source = ApiContractSource.Discovery,
                Version = (current?.Version ?? 0) + 1,
                IsBaseline = true,
                AcceptedByUserId = _user.UserId,
                AcceptedAt = _clock.UtcNow,
                Note = request.Note,
                CreatedAt = _clock.UtcNow
            };
            _db.ApiContracts.Add(contract);
            captured.Add(new CapturedBaseline(
                contract.Id, contract.Method, contract.UrlTemplate, contract.Version,
                shape.FieldCount, contract.StatusCode));
        }

        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(ApiContract), application.Id,
            $"API contract baselines captured for {application.Name}: {captured.Count} stored "
            + $"({replaced} replacing an earlier version), {skipped} skipped."
            + (request.Note is null ? string.Empty : $" Note: {request.Note}"),
            projectId: application.ProjectId, ct: ct);

        return Result<CaptureBaselinesResult>.Success(new CaptureBaselinesResult(
            captured.Count, replaced, skipped, captured, notes));
    }

    public async Task<Result<ContractCheckResult>> CheckRunAsync(Guid testRunId, CancellationToken ct = default)
    {
        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == testRunId, ct);
        if (run is null) return Error.NotFound("The test run");

        var executionIds = await _db.TestExecutions
            .Where(e => e.TestRunId == testRunId)
            .Select(e => e.Id)
            .ToListAsync(ct);

        if (executionIds.Count == 0)
        {
            return Result<ContractCheckResult>.Success(new ContractCheckResult(
                testRunId, null, 0, 0, 0, 0, 0, 0, Array.Empty<ContractChangeSummary>(),
                new[] { "The run has no executions, so there is no evidence to compare." }));
        }

        var events = await _db.NetworkEvents
            .Where(e => e.TestExecutionId != null && executionIds.Contains(e.TestExecutionId.Value))
            .Where(e => e.ResponseBodyExcerpt != null)
            .OrderBy(e => e.OccurredAt)
            .ToListAsync(ct);

        // The application the run tested. A run can span applications in principle; each
        // observation is matched against the baselines of the application whose inventory
        // the endpoint belongs to, which the URL template resolves.
        var applicationIds = await _db.TestExecutions
            .Where(e => e.TestRunId == testRunId)
            .Select(e => e.TestCase!.ApplicationId)
            .Where(id => id != null)
            .Distinct()
            .ToListAsync(ct);

        return await CompareObservationsAsync(
            applicationIds.Where(id => id is not null).Select(id => id!.Value).ToList(),
            events.Select(Observation.From).Where(o => o is not null).Select(o => o!).ToList(),
            testRunId: testRunId, discoveryRunId: null, ct);
    }

    public async Task<Result<ContractCheckResult>> CheckDiscoveryAsync(
        Guid discoveryRunId, CancellationToken ct = default)
    {
        var run = await _db.DiscoveryRuns.FirstOrDefaultAsync(r => r.Id == discoveryRunId, ct);
        if (run is null) return Error.NotFound("The discovery run");

        // Discovery writes what it saw straight onto the inventory, so the freshest
        // observation of each endpoint is the inventory row itself.
        var endpoints = await _db.ApiEndpoints
            .Where(e => e.ApplicationId == run.ApplicationId)
            .ToListAsync(ct);

        var observations = endpoints
            .Where(e => IsJson(e.ResponseContentType) && e.ResponseSampleJson is not null)
            .Select(e => new Observation(e.Method, e.UrlTemplate, e.LastStatusCode, e.ResponseSampleJson!))
            .ToList();

        return await CompareObservationsAsync(
            new[] { run.ApplicationId }, observations,
            testRunId: null, discoveryRunId: discoveryRunId, ct);
    }

    public async Task<Result<ContractCheckResult>> ChangesForRunAsync(Guid testRunId, CancellationToken ct = default)
    {
        var changes = await _db.ApiContractChanges
            .Where(c => c.TestRunId == testRunId)
            .OrderByDescending(c => c.Kind)
            .ThenBy(c => c.UrlTemplate)
            .ThenBy(c => c.Path)
            .ToListAsync(ct);

        var endpointsObserved = changes.Select(c => Key(c.Method, c.UrlTemplate)).Distinct().Count();

        return Result<ContractCheckResult>.Success(new ContractCheckResult(
            testRunId, null, endpointsObserved, endpointsObserved, 0,
            changes.Count(c => c.Kind == ContractChangeKind.Breaking),
            changes.Count(c => c.Kind == ContractChangeKind.PotentiallyBreaking),
            changes.Count(c => c.Kind == ContractChangeKind.NonBreaking),
            changes.Select(Summarize).ToList(),
            Array.Empty<string>()));
    }

    public async Task<Result> AcknowledgeAsync(Guid changeId, string note, CancellationToken ct = default)
    {
        var change = await _db.ApiContractChanges.FirstOrDefaultAsync(c => c.Id == changeId, ct);
        if (change is null) return Result.Failure(Error.NotFound("The contract change"));

        if (string.IsNullOrWhiteSpace(note) || note.Trim().Length < 10)
        {
            return Result.Failure(Error.Validation(
                "Acknowledging a contract change needs a note of at least 10 characters saying "
                + "why it is acceptable."));
        }

        change.IsAcknowledged = true;
        change.AcknowledgedByUserId = _user.UserId;
        change.AcknowledgedAt = _clock.UtcNow;
        change.AcknowledgementNote = note.Trim();
        await _db.SaveChangesAsync(ct);

        // A breaking change someone decided was fine is exactly the kind of decision that
        // gets asked about later.
        await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(ApiContractChange), change.Id,
            $"{change.Kind} contract change acknowledged on {change.Method} {change.UrlTemplate} "
            + $"at {change.Path}: {note.Trim()}",
            ct: ct);

        _logger.LogWarning(
            "Contract change {ChangeId} ({Kind} on {Method} {Url} at {Path}) was acknowledged.",
            change.Id, change.Kind, change.Method, change.UrlTemplate, change.Path);

        return Result.Success();
    }

    /// <summary>The comparison itself, shared by the run and discovery paths.</summary>
    private async Task<Result<ContractCheckResult>> CompareObservationsAsync(
        IReadOnlyCollection<Guid> applicationIds,
        IReadOnlyList<Observation> observations,
        Guid? testRunId,
        Guid? discoveryRunId,
        CancellationToken ct)
    {
        var notes = new List<string>();

        var baselines = await _db.ApiContracts
            .Where(c => applicationIds.Contains(c.ApplicationId) && c.IsBaseline)
            .ToListAsync(ct);

        if (baselines.Count == 0)
        {
            notes.Add("No contract baselines are stored for this application, so nothing could be "
                + "compared. Capture baselines first; until then a contract check reports nothing "
                + "rather than reporting that everything is unchanged.");
        }

        var baselineByKey = baselines.ToDictionary(
            c => Key(c.Method, c.UrlTemplate), StringComparer.OrdinalIgnoreCase);

        // Previously detected differences, so a change that persists across runs is not
        // re-reported as new and an acknowledgement is not silently lost.
        var acknowledged = await _db.ApiContractChanges
            .Where(c => applicationIds.Contains(c.ApplicationId) && c.IsAcknowledged)
            .Select(c => new { c.Method, c.UrlTemplate, c.Path, c.BaselineType, c.ObservedType })
            .ToListAsync(ct);
        var acknowledgedKeys = acknowledged
            .Select(a => $"{Key(a.Method, a.UrlTemplate)}|{a.Path}|{a.BaselineType}|{a.ObservedType}")
            .ToHashSet(StringComparer.Ordinal);

        // One observation per endpoint: the last response seen for it in this run. An
        // endpoint called five times with the same shape is one contract, and reporting the
        // same difference five times would bury it.
        var latest = new Dictionary<string, Observation>(StringComparer.OrdinalIgnoreCase);
        foreach (var observation in observations)
        {
            var key = MatchKey(observation, baselineByKey.Keys);
            if (key is null) continue;
            latest[key] = observation;
        }

        var withoutBaseline = observations
            .Select(o => Key(o.Method, o.NormalizedPath))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count(key => !baselineByKey.ContainsKey(key));

        var changes = new List<ApiContractChange>();
        var summaries = new List<ContractChangeSummary>();
        var now = _clock.UtcNow;

        foreach (var (key, observation) in latest)
        {
            var baseline = baselineByKey[key];
            var baselineShape = ApiSchemaShape.FromJson(baseline.ResponseSchemaJson);
            if (baselineShape is null)
            {
                notes.Add($"{baseline.Method} {baseline.UrlTemplate}: the stored baseline could not be "
                    + "read, so it was not compared.");
                continue;
            }

            var observedShape = ApiSchemaShape.Infer(observation.Body);
            if (observedShape is null)
            {
                // The response was not JSON at all. That is itself worth recording — an
                // endpoint that used to answer JSON and now answers something else has
                // broken every caller — but it is not a field-level difference.
                var difference = new ApiContractChange
                {
                    OrganizationId = baseline.OrganizationId,
                    ApplicationId = baseline.ApplicationId,
                    ApiEndpointId = baseline.ApiEndpointId,
                    BaselineContractId = baseline.Id,
                    Method = baseline.Method,
                    UrlTemplate = baseline.UrlTemplate,
                    Kind = ContractChangeKind.Breaking,
                    Path = "$",
                    BaselineType = baselineShape.RootType,
                    ObservedType = "not-json",
                    Description = "The response is no longer JSON, so no caller parsing it as JSON works.",
                    TestRunId = testRunId,
                    DiscoveryRunId = discoveryRunId,
                    DetectedAt = now,
                    CreatedAt = now
                };
                changes.Add(difference);
                continue;
            }

            foreach (var difference in ApiContractComparer.Compare(
                baselineShape, observedShape, baseline.StatusCode, observation.StatusCode))
            {
                var acknowledgementKey =
                    $"{key}|{difference.Path}|{difference.BaselineType}|{difference.ObservedType}";

                changes.Add(new ApiContractChange
                {
                    OrganizationId = baseline.OrganizationId,
                    ApplicationId = baseline.ApplicationId,
                    ApiEndpointId = baseline.ApiEndpointId,
                    BaselineContractId = baseline.Id,
                    Method = baseline.Method,
                    UrlTemplate = baseline.UrlTemplate,
                    Kind = difference.Kind,
                    Path = Truncate(difference.Path, 500),
                    BaselineType = Truncate(difference.BaselineType, 120),
                    ObservedType = Truncate(difference.ObservedType, 120),
                    Description = Truncate(difference.Description, 2000)!,
                    TestRunId = testRunId,
                    DiscoveryRunId = discoveryRunId,
                    // Carried forward, so acknowledging a change once does not mean
                    // acknowledging it on every subsequent release.
                    IsAcknowledged = acknowledgedKeys.Contains(acknowledgementKey),
                    DetectedAt = now,
                    CreatedAt = now
                });
            }
        }

        foreach (var change in changes)
        {
            _db.ApiContractChanges.Add(change);
            summaries.Add(Summarize(change));
        }

        await _db.SaveChangesAsync(ct);

        var breaking = changes.Count(c => c.Kind == ContractChangeKind.Breaking && !c.IsAcknowledged);
        if (breaking > 0)
        {
            _logger.LogWarning(
                "Contract check found {Breaking} breaking change(s) across {Endpoints} endpoint(s).",
                breaking, latest.Count);
        }

        return Result<ContractCheckResult>.Success(new ContractCheckResult(
            testRunId, discoveryRunId,
            EndpointsObserved: observations
                .Select(o => Key(o.Method, o.NormalizedPath))
                .Distinct(StringComparer.OrdinalIgnoreCase).Count(),
            EndpointsWithBaseline: latest.Count,
            EndpointsWithoutBaseline: withoutBaseline,
            BreakingCount: changes.Count(c => c.Kind == ContractChangeKind.Breaking),
            PotentiallyBreakingCount: changes.Count(c => c.Kind == ContractChangeKind.PotentiallyBreaking),
            NonBreakingCount: changes.Count(c => c.Kind == ContractChangeKind.NonBreaking),
            Changes: summaries,
            Notes: notes));
    }

    /// <summary>Which baseline an observed call belongs to.
    ///
    /// The inventory stores templates (<c>/api/accounts/{id}/transactions</c>) and an
    /// observed call has real identifiers in it. An exact match is tried first; failing
    /// that, each template is matched segment by segment with its placeholders treated as
    /// wildcards. Nothing is guessed beyond that: a call that matches no template is
    /// reported as having no baseline rather than attached to the nearest one.</summary>
    private static string? MatchKey(Observation observation, IEnumerable<string> baselineKeys)
    {
        var keys = baselineKeys as IReadOnlyCollection<string> ?? baselineKeys.ToList();
        var exact = Key(observation.Method, observation.NormalizedPath);

        var literal = keys.FirstOrDefault(key => string.Equals(key, exact, StringComparison.OrdinalIgnoreCase));
        if (literal is not null) return literal;

        foreach (var key in keys)
        {
            var separator = key.IndexOf(' ');
            if (separator < 0) continue;
            if (!string.Equals(key[..separator], observation.Method, StringComparison.OrdinalIgnoreCase)) continue;
            if (TemplateMatches(key[(separator + 1)..], observation.NormalizedPath)) return key;
        }
        return null;
    }

    private static bool TemplateMatches(string template, string path)
    {
        var templateSegments = template.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var pathSegments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (templateSegments.Length != pathSegments.Length) return false;

        for (var index = 0; index < templateSegments.Length; index++)
        {
            var templateSegment = templateSegments[index];
            // A placeholder matches any one segment. Anything else has to match exactly.
            if (templateSegment.StartsWith('{') && templateSegment.EndsWith('}')) continue;
            if (templateSegment is ":id" or "*") continue;
            if (!string.Equals(templateSegment, pathSegments[index], StringComparison.OrdinalIgnoreCase))
                return false;
        }
        return true;
    }

    private async Task<Dictionary<string, int>> CountTestsPerEndpointAsync(
        Guid applicationId, IReadOnlyList<ApiEndpoint> endpoints, CancellationToken ct)
    {
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        if (endpoints.Count == 0) return counts;

        var steps = await _db.TestSteps
            .Where(s => s.Action == BrowserActionType.ApiRequest
                        && s.ApiRequestJson != null
                        && _db.TestCases.Any(tc => tc.Id == s.TestCaseId
                                                   && tc.ApplicationId == applicationId
                                                   && tc.DeletedAt == null))
            .Select(s => s.ApiRequestJson!)
            .ToListAsync(ct);

        foreach (var json in steps)
        {
            var descriptor = ApiRequestValidator.Deserialize(json);
            if (descriptor is null) continue;

            var path = NormalizePath(descriptor.Path);
            var method = (descriptor.Method ?? "GET").ToUpperInvariant();

            var match = endpoints.FirstOrDefault(endpoint =>
                string.Equals(endpoint.Method, method, StringComparison.OrdinalIgnoreCase)
                && (string.Equals(NormalizePath(endpoint.UrlTemplate), path, StringComparison.OrdinalIgnoreCase)
                    || TemplateMatches(NormalizePath(endpoint.UrlTemplate), path)));

            if (match is null) continue;
            var key = Key(match.Method, match.UrlTemplate);
            counts[key] = counts.GetValueOrDefault(key, 0) + 1;
        }

        return counts;
    }

    /// <summary>One observed response, whatever produced it.</summary>
    private sealed record Observation(string Method, string Path, int? StatusCode, string Body)
    {
        public string NormalizedPath => NormalizePath(Path);

        /// <summary>Builds an observation from a stored network event, or null when the
        /// event cannot contribute one.</summary>
        public static Observation? From(Domain.Evidence.NetworkEvent stored)
        {
            if (string.IsNullOrWhiteSpace(stored.ResponseBodyExcerpt)) return null;
            // A masked or truncated body cannot be parsed reliably. An excerpt that stops
            // mid-document would infer a shape missing every field after the cut, and every
            // one of those would be reported as removed.
            if (!stored.ResponseBodyExcerpt.TrimEnd().EndsWith('}')
                && !stored.ResponseBodyExcerpt.TrimEnd().EndsWith(']')) return null;

            return new Observation(stored.Method, stored.Url, stored.StatusCode, stored.ResponseBodyExcerpt);
        }
    }

    /// <summary>Reduces a URL or a template to a comparable path: no scheme, no host, no
    /// query, no trailing slash.</summary>
    private static string NormalizePath(string urlOrPath)
    {
        var value = urlOrPath;
        if (Uri.TryCreate(value, UriKind.Absolute, out var absolute)) value = absolute.AbsolutePath;

        var question = value.IndexOf('?');
        if (question >= 0) value = value[..question];

        value = value.TrimEnd('/');
        return value.Length == 0 ? "/" : value;
    }

    private static string Key(string method, string pathOrTemplate) =>
        $"{method.ToUpperInvariant()} {NormalizePath(pathOrTemplate)}";

    private static ContractChangeSummary Summarize(ApiContractChange change) => new(
        change.Id, change.Method, change.UrlTemplate, change.Kind, change.Path,
        change.BaselineType, change.ObservedType, change.Description, change.IsAcknowledged);

    private static string Sha256(string? value)
    {
        if (value is null) return string.Empty;
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    }

    private static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}
