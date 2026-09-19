using Aira.Domain.Enums;

namespace Aira.Application.Diagnosis;

public sealed record ClassificationInput(
    ExecutionStatus Status,
    string ErrorMessage,
    bool HealingAttempted,
    int? HealingConfidence,
    int ConsoleErrorCount,
    int ServerErrorCount,
    int AuthErrorCount,
    int NetworkFailureCount);

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

        if (input.ServerErrorCount > 0)
        {
            return new DeterministicVerdict(
                FailureCategory.ApplicationDefect, 90,
                "The application returned server errors during this execution.",
                $"{input.ServerErrorCount} request(s) failed with a 5xx status. The fault is in the application or a service it depends on.",
                $"{input.ServerErrorCount} server error response(s) recorded in the network evidence.",
                "Take the network evidence to the application team. Re-running will not help until the service is fixed.",
                IsLikelyApplicationDefect: true, IsHealable: false);
        }

        if (input.NetworkFailureCount > 0 && (lowered.Contains("net::") || lowered.Contains("econnrefused") || lowered.Contains("timeout")))
        {
            return new DeterministicVerdict(
                FailureCategory.NetworkIssue, 85,
                "The application could not be reached.",
                "A network-level failure stopped the browser from loading the application.",
                $"{input.NetworkFailureCount} request(s) failed at the network layer. Engine message: {message}",
                "Confirm the environment is running and reachable from the worker, then re-run.",
                IsLikelyApplicationDefect: false, IsHealable: false);
        }

        if (input.AuthErrorCount > 0)
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

        if (lowered.Contains("no element matched") || lowered.Contains("waiting for locator") || lowered.Contains("not found"))
        {
            return new DeterministicVerdict(
                FailureCategory.LocatorChange, 65,
                "The step could not find the element it needed.",
                "The element is not on the page. Either the UI changed, or an earlier step left the application somewhere unexpected.",
                message,
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

        if (lowered.Contains("expected the text") || lowered.Contains("expected the value")
            || lowered.Contains("expected attribute") || lowered.Contains("assertion"))
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
}
