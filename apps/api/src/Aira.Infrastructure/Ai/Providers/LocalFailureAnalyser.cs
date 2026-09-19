using System.Text.Json;

namespace Aira.Infrastructure.Ai.Providers;

/// <summary>Explains a failure from its evidence, without a model.
///
/// The rules here are the ones a test engineer applies when reading a failure: what the
/// engine said, what the network did, what the console logged, and whether a plausible
/// replacement element was found on the page. Most real failures are diagnosable from
/// exactly those four signals, which is why this runs first and a model is consulted only
/// when they do not settle it.</summary>
internal static class LocalFailureAnalyser
{
    public static string Analyse(JsonElement context)
    {
        var message = LocalJson.String(context, "errorMessage") ?? string.Empty;
        var lowered = message.ToLowerInvariant();
        var stepDescription = LocalJson.String(context, "stepDescription") ?? "the step";
        var locator = LocalJson.String(context, "locatorDescription");
        var healingConfidence = LocalJson.Int(context, "healingConfidence");
        var healedTo = LocalJson.String(context, "healedLocatorDescription");
        var consoleErrors = LocalJson.Array(context, "consoleErrors").ToList();
        var networkFailures = LocalJson.Array(context, "networkFailures").ToList();
        var status = LocalJson.String(context, "status") ?? "failed";

        // Ordered most-specific first: the first rule that matches is the one whose
        // evidence is strongest, not merely the one that happens to be listed earliest.

        if (status == "blocked")
        {
            return Result(
                summary: "The test could not start because its preconditions were not met.",
                likelyCause: message.Contains("login", StringComparison.OrdinalIgnoreCase) || message.Contains("sign", StringComparison.OrdinalIgnoreCase)
                    ? "Signing in to the application failed, so no step ever ran. The stored credentials, the login configuration, or the environment itself is wrong."
                    : "A precondition of the test was not satisfied, so no step ran.",
                evidence: message,
                suggestedAction: "Check the application's credentials and login configuration, then confirm the environment is reachable. No application defect is implied by this result.",
                category: "environmentDefect", confidence: 80, isDefect: false, isHealable: false);
        }

        var serverErrors = networkFailures
            .Where(f => LocalJson.Int(f, "statusCode") >= 500)
            .ToList();
        if (serverErrors.Count > 0)
        {
            var first = serverErrors[0];
            return Result(
                summary: $"{stepDescription} failed while the application was returning server errors.",
                likelyCause: $"The application returned {LocalJson.Int(first, "statusCode")} for {LocalJson.String(first, "url")}. The failure is in the application or a service it depends on, not in the test.",
                evidence: $"{serverErrors.Count} request(s) failed with a 5xx status during this execution. First: {LocalJson.String(first, "method")} {LocalJson.String(first, "url")} -> {LocalJson.Int(first, "statusCode")}.",
                suggestedAction: "Raise this with the application team, attaching the network evidence from this execution. Re-running is unlikely to help until the service is fixed.",
                category: "applicationDefect", confidence: 90, isDefect: true, isHealable: false);
        }

        var authFailures = networkFailures
            .Where(f => LocalJson.Int(f, "statusCode") is 401 or 403)
            .ToList();
        if (authFailures.Count > 0)
        {
            return Result(
                summary: $"{stepDescription} failed because the session was not authorised.",
                likelyCause: "The application rejected the request as unauthenticated or forbidden. The session expired mid-test, or the account lacks the permission this journey needs.",
                evidence: $"{authFailures.Count} request(s) returned 401 or 403 during this execution.",
                suggestedAction: "Confirm the test account's permissions and the session lifetime for this environment. If the session expired, the test may need to re-authenticate mid-journey.",
                category: "authenticationIssue", confidence: 85, isDefect: false, isHealable: false);
        }

        if (healedTo is not null && healingConfidence > 0)
        {
            return Result(
                summary: $"The element {stepDescription} targets has changed.",
                likelyCause: $"The stored locator ({locator}) no longer matches anything, but an element closely resembling the original was found: {healedTo}. The application's markup changed rather than its behaviour.",
                evidence: $"A healing candidate scored {healingConfidence}% against the original element's recorded signals.",
                suggestedAction: healingConfidence >= 85
                    ? $"Review and approve the healing proposal to update the locator to {healedTo}."
                    : $"Review the healing proposal carefully: at {healingConfidence}% confidence it is a suggestion, not a certainty.",
                category: "locatorChange", confidence: Math.Min(95, healingConfidence + 5), isDefect: false, isHealable: true);
        }

        if (lowered.Contains("no element matched") || lowered.Contains("not found") || lowered.Contains("waiting for locator"))
        {
            return Result(
                summary: $"{stepDescription} could not find the element it needed.",
                likelyCause: "The element is absent from the page. Either the UI changed and the locator is stale, or an earlier step left the application somewhere other than the expected page.",
                evidence: message,
                suggestedAction: "Compare the failure screenshot with the expected page. If the page is right but the element moved, update the locator; if the page is wrong, the failure is earlier in the journey.",
                category: "locatorChange", confidence: 65, isDefect: false, isHealable: true);
        }

        if (lowered.Contains("matched") && lowered.Contains("elements"))
        {
            return Result(
                summary: $"{stepDescription} matched more than one element.",
                likelyCause: "The locator is ambiguous on this page. The application may now render several controls that satisfy it.",
                evidence: message,
                suggestedAction: "Narrow the locator — scope it to a container, or set an explicit index — so the step targets exactly one element.",
                category: "testDefect", confidence: 85, isDefect: false, isHealable: false);
        }

        if (lowered.Contains("timeout") || lowered.Contains("timed out"))
        {
            return Result(
                summary: $"{stepDescription} timed out.",
                likelyCause: consoleErrors.Count > 0
                    ? "The page did not reach the expected state in time, and JavaScript errors were logged — the page may have failed to finish rendering."
                    : "The page did not reach the expected state within the timeout. This is usually a slow environment or a missing wait, rather than a defect.",
                evidence: consoleErrors.Count > 0
                    ? $"{message}\nConsole errors observed: {string.Join("; ", consoleErrors.Take(3).Select(e => LocalJson.String(e, "message")))}"
                    : message,
                suggestedAction: consoleErrors.Count > 0
                    ? "Investigate the console errors first; they are the more likely cause."
                    : "Re-run to see whether it is reproducible. If it recurs, raise the step timeout or add an explicit wait for the state the step depends on.",
                category: consoleErrors.Count > 0 ? "applicationDefect" : "timingIssue",
                confidence: consoleErrors.Count > 0 ? 70 : 60,
                isDefect: consoleErrors.Count > 0, isHealable: false);
        }

        if (lowered.Contains("expected the text") || lowered.Contains("expected the value") || lowered.Contains("assertion"))
        {
            return Result(
                summary: $"An assertion failed on {stepDescription}.",
                likelyCause: "The application produced a different value from the one the test expects. Either the application's behaviour changed, or the expectation is out of date.",
                evidence: message,
                suggestedAction: "Compare the expected and actual values in the failure message. If the application's new value is correct, update the expectation deliberately — never silently.",
                category: "applicationDefect", confidence: 70, isDefect: true, isHealable: false);
        }

        if (lowered.Contains("net::") || lowered.Contains("econnrefused") || lowered.Contains("dns"))
        {
            return Result(
                summary: "The application could not be reached.",
                likelyCause: "A network-level failure prevented the browser from loading the application. The environment is probably down or unreachable from the worker.",
                evidence: message,
                suggestedAction: "Confirm the environment is running and reachable from the worker, then re-run. This result says nothing about the application's correctness.",
                category: "networkIssue", confidence: 85, isDefect: false, isHealable: false);
        }

        if (consoleErrors.Count > 0)
        {
            return Result(
                summary: $"{stepDescription} failed on a page that logged JavaScript errors.",
                likelyCause: "Uncaught JavaScript errors were logged during this execution. The failure is plausibly a consequence of a broken front-end.",
                evidence: string.Join("\n", consoleErrors.Take(5).Select(e => $"[{LocalJson.String(e, "level")}] {LocalJson.String(e, "message")}")),
                suggestedAction: "Investigate the JavaScript errors; they are the most likely cause of the step failing.",
                category: "applicationDefect", confidence: 65, isDefect: true, isHealable: false);
        }

        // Nothing matched. Say so plainly rather than inventing a cause.
        return Result(
            summary: $"{stepDescription} failed.",
            likelyCause: "The available evidence does not identify a cause. The engine error is reproduced verbatim below.",
            evidence: string.IsNullOrWhiteSpace(message) ? "No error message was recorded." : message,
            suggestedAction: "Review the failure screenshot, DOM snapshot and trace for this execution. Configure a model provider for a deeper analysis of failures like this one.",
            category: "unknown", confidence: 30, isDefect: false, isHealable: false);
    }

    private static string Result(string summary, string likelyCause, string evidence, string suggestedAction,
        string category, int confidence, bool isDefect, bool isHealable)
        => LocalJson.Serialize(new
        {
            summary,
            likelyCause,
            evidence = Truncate(evidence, 4000),
            suggestedAction,
            category,
            confidence,
            isLikelyApplicationDefect = isDefect,
            isHealable
        });

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
