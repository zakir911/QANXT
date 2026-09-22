using Aira.Application.Testing;

namespace Aira.Application.Diagnosis;

/// <summary>One request observed during an execution, reduced to what a diagnosis needs.</summary>
public sealed record CorrelatedApiCall(
    string Method,
    string Url,
    int? StatusCode,
    int DurationMs,
    bool IsFailed,
    string? FailureText,
    int? ActionOrder)
{
    /// <summary>The path, without scheme, host or query. What a person reads in a report.</summary>
    public string Path
    {
        get
        {
            if (Uri.TryCreate(Url, UriKind.Absolute, out var absolute)) return absolute.AbsolutePath;
            var question = Url.IndexOf('?');
            return question >= 0 ? Url[..question] : Url;
        }
    }

    public bool IsServerError => StatusCode >= 500;
    public bool IsAuthError => StatusCode is 401 or 403;
    public bool IsClientError => StatusCode is >= 400 and < 500;
    /// <summary>The request never produced a response at all — DNS, refused, TLS, timeout.</summary>
    public bool IsTransportFailure => IsFailed && StatusCode is null;

    /// <summary>How a report should name this call: <c>GET /api/accounts → 500 in 12ms</c>.</summary>
    public string Describe() => IsTransportFailure
        ? $"{Method} {Path} did not complete ({FailureText ?? "no response"})"
        : $"{Method} {Path} → {StatusCode} in {DurationMs}ms";
}

/// <summary>What the API was doing when a UI step failed.
///
/// The join is the action order the worker records on every request. It existed as a column
/// long before anything wrote it, and nothing did — so until
/// <see href="../../../../verification/bugs/BUG-0020/bug.md">BUG-0020</see> was fixed, a
/// diagnosis could count 5xx responses across a whole execution but could not say which
/// step made them. Counting is the weaker statement: "the application returned server
/// errors somewhere during these twenty steps" and "the step that failed asked for
/// /api/accounts and was answered 500" are different findings, and only the second tells
/// someone where to look.</summary>
public sealed record ApiCorrelation(
    int? FailingActionOrder,
    /// <summary>Requests the failing step itself made.</summary>
    IReadOnlyList<CorrelatedApiCall> DuringFailingStep,
    /// <summary>Of those, the ones that failed.</summary>
    IReadOnlyList<CorrelatedApiCall> FailedDuringFailingStep,
    /// <summary>Failed requests made by the step immediately before the failing one.
    ///
    /// This is where most UI failures actually come from. A click starts a fetch and moves
    /// on; the assertion one step later is what notices that the page is empty. Attributing
    /// only to the failing step would therefore find nothing in exactly the case the
    /// feature exists for — which is what the first run of COR-002 showed.</summary>
    IReadOnlyList<CorrelatedApiCall> FailedDuringPrecedingStep,
    /// <summary>Failed requests attributed to some other step, or to none.</summary>
    IReadOnlyList<CorrelatedApiCall> FailedElsewhere)
{
    public static readonly ApiCorrelation None = new(
        null, Array.Empty<CorrelatedApiCall>(), Array.Empty<CorrelatedApiCall>(),
        Array.Empty<CorrelatedApiCall>(), Array.Empty<CorrelatedApiCall>());

    /// <summary>True when the failing step made API calls and every one of them worked.
    ///
    /// This is the interesting negative: the data arrived correctly and the page still
    /// showed something else, which points at the front end rather than the service.</summary>
    public bool EveryCallDuringFailingStepSucceeded =>
        DuringFailingStep.Count > 0 && FailedDuringFailingStep.Count == 0;

    /// <summary>Builds the correlation from a completion report.
    ///
    /// Only calls the application made are considered: document loads, images and
    /// stylesheets are not what a diagnosis means by "the API".</summary>
    public static ApiCorrelation Build(ExecutionCompletionPayload completion, int? failingActionOrder)
    {
        var calls = completion.NetworkEvents
            .Where(IsApiCall)
            .Select(e => new CorrelatedApiCall(
                e.Method, e.Url, e.StatusCode, e.DurationMs, e.IsFailed, e.FailureText, e.ActionOrder))
            .ToList();

        if (calls.Count == 0) return None with { FailingActionOrder = failingActionOrder };


        var during = failingActionOrder is null
            ? Array.Empty<CorrelatedApiCall>()
            : calls.Where(c => c.ActionOrder == failingActionOrder).ToArray();

        var failedDuring = during.Where(Failed).ToArray();

        var failedPreceding = failingActionOrder is null or <= 1
            ? Array.Empty<CorrelatedApiCall>()
            : calls.Where(c => c.ActionOrder == failingActionOrder - 1).Where(Failed).ToArray();

        var failedElsewhere = calls
            .Where(Failed)
            .Where(c => failingActionOrder is null
                        || (c.ActionOrder != failingActionOrder && c.ActionOrder != failingActionOrder - 1))
            .ToArray();

        return new ApiCorrelation(
            failingActionOrder, during, failedDuring, failedPreceding, failedElsewhere);
    }

    private static bool Failed(CorrelatedApiCall call) => call.IsFailed || call.StatusCode >= 400;

    /// <summary>XHR, fetch and the requests AIRA's own API tests make. A document navigation
    /// is a page load rather than an API call, and treating it as one would make every
    /// redirect look like a service fault.</summary>
    private static bool IsApiCall(NetworkEventPayload e) =>
        e.ResourceType is "xhr" or "fetch" or "apiTest"
        || (e.ResourceType is null && e.Url.Contains("/api/", StringComparison.OrdinalIgnoreCase));
}
