using QaNxt.Domain.Enums;

namespace QaNxt.Application.Diagnosis;

public sealed record ClassificationInput(
    ExecutionStatus Status,
    string ErrorMessage,
    bool HealingAttempted,
    int? HealingConfidence,
    int ConsoleErrorCount,
    int ServerErrorCount,
    int AuthErrorCount,
    int NetworkFailureCount,
    /// <summary>The action that failed, as the engine named it — "assertText", "click".
    /// Structured, because identifying an assertion by the prose of its error message
    /// drifts the moment the message is reworded, which is how assertion failures came to
    /// be classified as Unknown (BUG-0012).</summary>
    string? FailingAction = null,
    /// <summary>What the API was doing when this step failed. Absent for an execution
    /// recorded before the evidence carried the link between a request and the step that
    /// made it.</summary>
    ApiCorrelation? Api = null);

public sealed record DeterministicVerdict(
    FailureCategory Category,
    int Confidence,
    string Summary,
    string LikelyCause,
    string Evidence,
    string SuggestedAction,
    bool IsLikelyApplicationDefect,
    bool IsHealable);

/// <summary>Classifies a failure from its evidence, without a model.
///
/// This runs on every failure and is the platform's first answer. Its confidence is what
/// decides whether a model is consulted at all: when the evidence is unambiguous — a 500
/// response, a connection refused, a locator that matched nothing — the rules are more
/// reliable than a model would be, and cost nothing.
///
/// The ordering of the rules is the design: strongest evidence first, so the most defensible
/// verdict wins rather than the first one that happens to match.</summary>
public static class DeterministicFailureClassifier
{
    public static DeterministicVerdict Classify(ClassificationInput input)
    {
        var message = input.ErrorMessage ?? string.Empty;
        var lowered = message.ToLowerInvariant();

        if (input.Status == ExecutionStatus.Blocked)
        {
            return new DeterministicVerdict(
                FailureCategory.EnvironmentDefect, 85,
                "The test could not start because its preconditions were not met.",
                "Sign-in or another precondition failed, so no step ran. This says nothing about the application's correctness.",
                message,
                "Check the application's credentials, its login configuration and that the environment is reachable.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        // ---- What the API was doing when this step failed ------------------
        //
        // These run before the counts below because they are the stronger statement. "The
        // application returned server errors somewhere during these twenty steps" and "the
        // step that failed asked for /api/accounts and was answered 500" are different
        // findings, and only the second tells someone where to look. The join that makes
        // this possible was a column nothing wrote until BUG-0020.

        var api = input.Api ?? ApiCorrelation.None;

        if (api.FailedDuringFailingStep.FirstOrDefault(c => c.IsServerError) is { } serverError)
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 95,
                $"The step failed because the API call it made returned {serverError.StatusCode}.",
                $"{serverError.Describe()} — the fault is in the application or a service it "
                + "depends on, not in the test.",
                $"The failing step made {api.DuringFailingStep.Count} API call(s); "
                + $"{Cite(api.FailedDuringFailingStep)}. Engine message: {message}",
                "Take this request to the team that owns the endpoint. Re-running will not help "
                + "until the service is fixed.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        if (api.FailedDuringFailingStep.FirstOrDefault(c => c.IsTransportFailure) is { } transportFailure)
        {
            return new DeterministicVerdict(
                FailureCategory.NetworkIssue, 90,
                "The step failed because the API call it made never completed.",
                $"{transportFailure.Describe()} — the request did not reach the service, or the "
                + "service did not answer.",
                $"{Cite(api.FailedDuringFailingStep)}. Engine message: {message}",
                "Confirm the service is running and reachable from the worker, then re-run.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        // Gated exactly as the whole-execution rule below is. A single-page application asks
        // "is anyone signed in?" as it loads and is answered 401 when nobody is; on a step
        // whose locator matched nothing, that 401 is the sign-in page working rather than a
        // symptom (BUG-0015). The call is still named in the locator verdict further down.
        if (!IsLocatorMiss(lowered)
            && api.FailedDuringFailingStep.FirstOrDefault(c => c.IsAuthError) is { } authFailure)
        {
            return new DeterministicVerdict(
                FailureCategory.AuthenticationIssue, 90,
                $"The step failed because the API call it made was refused with {authFailure.StatusCode}.",
                $"{authFailure.Describe()} — the session was not accepted, or the account lacks "
                + "a permission this endpoint requires.",
                $"{Cite(api.FailedDuringFailingStep)}. Engine message: {message}",
                "Check the test account's permissions and this environment's session lifetime.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        if (!IsLocatorMiss(lowered)
            && api.FailedDuringFailingStep.FirstOrDefault(c => c.IsClientError) is { } clientError)
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 85,
                $"The step failed because the API call it made was rejected with {clientError.StatusCode}.",
                $"{clientError.Describe()} — either the request the application sent was wrong, "
                + "or the data the test used is not acceptable to this endpoint.",
                $"{Cite(api.FailedDuringFailingStep)}. Engine message: {message}",
                "Read the request in the network evidence. A 4xx here is usually the application "
                + "sending something the service will not accept.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        // The same findings, one step earlier. A click starts a fetch and moves on; the
        // assertion that follows is what notices the page is empty. The causal link is
        // inferred rather than direct, so the confidence is a little lower and the wording
        // says which step made the call.
        if (api.FailedDuringPrecedingStep.FirstOrDefault(c => c.IsServerError) is { } precedingServerError)
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 90,
                $"The step before this one made an API call that returned {precedingServerError.StatusCode}.",
                $"{precedingServerError.Describe()} — the page had nothing to render, so the step "
                + "that followed found nothing. The fault is in the application or a service it "
                + "depends on, not in the test.",
                $"{Cite(api.FailedDuringPrecedingStep)}, made by step "
                + $"{api.FailingActionOrder - 1}. Engine message: {message}",
                "Take this request to the team that owns the endpoint. The failing assertion is "
                + "the symptom; this call is the cause.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        if (api.FailedDuringPrecedingStep.FirstOrDefault(c => c.IsTransportFailure) is { } precedingTransport)
        {
            return new DeterministicVerdict(
                FailureCategory.NetworkIssue, 85,
                "The step before this one made an API call that never completed.",
                $"{precedingTransport.Describe()} — the request did not reach the service, so the "
                + "page had nothing to render.",
                $"{Cite(api.FailedDuringPrecedingStep)}, made by step "
                + $"{api.FailingActionOrder - 1}. Engine message: {message}",
                "Confirm the service is running and reachable from the worker, then re-run.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        if (!IsLocatorMiss(lowered)
            && api.FailedDuringPrecedingStep.FirstOrDefault(c => c.IsAuthError) is { } precedingAuth)
        {
            return new DeterministicVerdict(
                FailureCategory.AuthenticationIssue, 85,
                $"The step before this one made an API call that was refused with {precedingAuth.StatusCode}.",
                $"{precedingAuth.Describe()} — the session was not accepted, so the page had "
                + "nothing to render.",
                $"{Cite(api.FailedDuringPrecedingStep)}, made by step "
                + $"{api.FailingActionOrder - 1}. Engine message: {message}",
                "Check the test account's permissions and this environment's session lifetime.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        if (!IsLocatorMiss(lowered)
            && api.FailedDuringPrecedingStep.FirstOrDefault(c => c.IsClientError) is { } precedingClient)
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 80,
                $"The step before this one made an API call that was rejected with {precedingClient.StatusCode}.",
                $"{precedingClient.Describe()} — either the request the application sent was wrong, "
                + "or the data the test used is not acceptable to this endpoint.",
                $"{Cite(api.FailedDuringPrecedingStep)}, made by step "
                + $"{api.FailingActionOrder - 1}. Engine message: {message}",
                "Read the request in the network evidence before looking at the failing step.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        // The interesting negative. The data arrived correctly and the page still showed
        // something else, which points at the front end rather than the service — and
        // saves whoever reads this from starting with the API.
        if (api.EveryCallAroundTheFailingStepSucceeded && IsAssertionFailure(input.FailingAction, lowered))
        {
            var behind = api.CallsBehindTheNegative;
            var whose = api.DuringFailingStep.Count > 0 ? "the failing step" : "the step before it";
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 80,
                "The API answered correctly and the page showed something else.",
                $"Every API call {whose} made succeeded ({Cite(behind)}), "
                + "so the data was right and what was rendered from it was not. The defect is in "
                + "the front end rather than the service.",
                $"{behind.Count} API call(s) during {whose}, all successful. "
                + $"Engine message: {message}",
                "Compare the response body in the network evidence with what the failure "
                + "screenshot shows. Start with the rendering, not the endpoint.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        if (input.ServerErrorCount > 0)
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 90,
                "The application returned server errors during this execution.",
                $"{input.ServerErrorCount} request(s) failed with a 5xx status. The fault is in the application or a service it depends on. "
                + "These were not made by the step that failed, so they are a cause rather than the immediate one.",
                $"{input.ServerErrorCount} server error response(s) recorded in the network evidence"
                + (api.FailedElsewhere.Count > 0 ? $": {Cite(api.FailedElsewhere)}." : "."),
                "Take the network evidence to the application team. Re-running will not help until the service is fixed.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        // The recorded network evidence decides this, not the wording of the step's error.
        // A page that catches a dropped request and renders "failed" produces an assertion
        // message with nothing network-ish in it, while the network log holds the actual
        // cause — and the platform was reporting an application defect for a connection
        // that never completed (BUG-0012).
        if (input.NetworkFailureCount > 0)
        {
            return new DeterministicVerdict(
                FailureCategory.NetworkIssue, 85,
                "The application could not be reached.",
                "A network-level failure stopped the browser from loading the application.",
                $"{input.NetworkFailureCount} request(s) failed at the network layer. Engine message: {message}",
                "Confirm the environment is running and reachable from the worker, then re-run.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        // Not when the engine has already said the step's locator matched nothing. A
        // single-page application asks "is anyone signed in?" as it loads and is answered
        // 401 when nobody is; that answer is the sign-in page working, not a symptom. Left
        // ungated, this rule blamed the session for every failure on a signed-out page,
        // including a button that had simply been removed (BUG-0015).
        if (input.AuthErrorCount > 0 && !IsLocatorMiss(lowered))
        {
            return new DeterministicVerdict(
                FailureCategory.AuthenticationIssue, 85,
                "The session was not authorised.",
                "The application rejected requests as unauthenticated or forbidden — the session expired, or the account lacks a required permission.",
                $"{input.AuthErrorCount} request(s) returned 401 or 403.",
                "Check the test account's permissions and this environment's session lifetime.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        if (input.HealingAttempted && input.HealingConfidence is > 0)
        {
            var confidence = input.HealingConfidence.Value;
            return new DeterministicVerdict(
                FailureCategory.LocatorChange, Math.Min(90, confidence + 5),
                "The element this step targets has changed.",
                $"The stored locator no longer matches, but a closely resembling element was found ({confidence}% similarity). The markup changed, not the behaviour.",
                $"A healing candidate scored {confidence}% against the element's recorded signals.",
                confidence >= 85
                    ? "Review and approve the healing proposal to update the locator."
                    : "Review the healing proposal carefully — at this confidence it is a suggestion, not a certainty.",
                IsLikelyApplicationDefect: false, IsHealable: true);
        }

        if (lowered.Contains("matched") && lowered.Contains("elements"))
        {
            return new DeterministicVerdict(
                FailureCategory.TestDefect, 85,
                "The step's locator matched more than one element.",
                "The locator is ambiguous on this page, so the engine refused to guess which element was meant.",
                message,
                "Narrow the locator — scope it to a container, or set an explicit index.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        if (IsLocatorMiss(lowered))
        {
            // Any 401s are still put in front of the reader. A session that really did
            // expire produces this same symptom — the page becomes the sign-in page and
            // the element vanishes — and they deserve both facts rather than one of them
            // chosen for them.
            var refusedDuringThisStep = api.FailedDuringFailingStep.Where(c => c.IsAuthError).ToList();
            var authNote = input.AuthErrorCount > 0
                ? $" {input.AuthErrorCount} request(s) also returned 401 or 403, which is ordinary on a signed-out page but would also follow a session that expired mid-test."
                  + (refusedDuringThisStep.Count > 0
                      ? $" The failing step itself made {Cite(refusedDuringThisStep)}."
                      : string.Empty)
                : string.Empty;

            return new DeterministicVerdict(
                FailureCategory.LocatorChange, 65,
                "The step could not find the element it needed.",
                "The element is not on the page. Either the UI changed, or an earlier step left the application somewhere unexpected.",
                $"{message}{authNote}",
                "Compare the failure screenshot with the expected page before changing the locator.",
                IsLikelyApplicationDefect: false, IsHealable: true);
        }

        if (input.ConsoleErrorCount > 0 && (lowered.Contains("timeout") || lowered.Contains("timed out")))
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 70,
                "The page did not finish rendering, and JavaScript errors were logged.",
                "The step timed out on a page that logged uncaught JavaScript errors — the front end probably failed to render.",
                $"{input.ConsoleErrorCount} console error(s) recorded. Engine message: {message}",
                "Investigate the JavaScript errors; they are the more likely cause than the timeout itself.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        if (lowered.Contains("timeout") || lowered.Contains("timed out"))
        {
            return new DeterministicVerdict(
                FailureCategory.TimingIssue, 60,
                "The step timed out.",
                "The page did not reach the expected state in time. Usually a slow environment or a missing wait rather than a defect.",
                message,
                "Re-run to check reproducibility. If it recurs, wait for the state the step depends on rather than raising the timeout.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        if (IsAssertionFailure(input.FailingAction, lowered))
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 70,
                "An assertion did not hold.",
                "The application produced a different value from the one the test expects — either its behaviour changed, or the expectation is stale.",
                message,
                "Compare expected and actual in the failure message. If the new value is correct, update the expectation deliberately.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        if (input.ConsoleErrorCount > 0)
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 60,
                "The step failed on a page logging JavaScript errors.",
                "Uncaught JavaScript errors were recorded during this execution and are a plausible cause.",
                $"{input.ConsoleErrorCount} console error(s) recorded.",
                "Investigate the JavaScript errors first.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        // Deliberately low confidence: this is where a model earns its cost.
        return new DeterministicVerdict(
            FailureCategory.Unknown, 25,
            "The execution failed.",
            "The available evidence does not identify a cause.",
            string.IsNullOrWhiteSpace(message) ? "No error message was recorded." : message,
            "Review the failure screenshot, DOM snapshot and trace for this execution.",
            IsLikelyApplicationDefect: false, IsHealable: false);
    }

    /// <summary>Names the calls a verdict is talking about, so a reader can find them.
    /// At most three: a verdict that lists twenty requests is not a verdict.</summary>
    private static string Cite(IReadOnlyList<CorrelatedApiCall> calls)
    {
        if (calls.Count == 0) return "no API calls";
        var named = string.Join("; ", calls.Take(3).Select(c => c.Describe()));
        return calls.Count > 3 ? $"{named}; and {calls.Count - 3} more" : named;
    }

    /// <summary>True when the step that failed was an assertion.
    ///
    /// The action name is the reliable signal; the message patterns are a fallback for
    /// executions recorded before the engine reported one, and for assertions evaluated
    /// outside a step.</summary>
    private static bool IsAssertionFailure(string? failingAction, string loweredMessage)
    {
        if (!string.IsNullOrEmpty(failingAction)
            && failingAction.StartsWith("assert", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return loweredMessage.Contains("expected the text")
            || loweredMessage.Contains("expected the value")
            || loweredMessage.Contains("expected the element")
            || loweredMessage.Contains("expected the url")
            || loweredMessage.Contains("expected attribute")
            || loweredMessage.Contains("assertion")
            || loweredMessage.Contains("but it read")
            || loweredMessage.Contains("but found");
    }

    /// <summary>True when the engine reported that the step's locator matched no element.
    ///
    /// This is the most specific statement available about the step that actually failed,
    /// which is why it outranks counts of responses recorded anywhere in the execution.</summary>
    private static bool IsLocatorMiss(string loweredMessage)
        => loweredMessage.Contains("no element matched")
            || loweredMessage.Contains("waiting for locator")
            || loweredMessage.Contains("not found");
}
