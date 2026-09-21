using System.Text.Json;
using Aira.Application.Contracts;
using Aira.Domain.Enums;

namespace Aira.Infrastructure.Ai.Providers;

/// <summary>Derives a test plan from the discovered application model.
///
/// The rules encode what an experienced QA engineer does on first contact with an
/// application: sign-in pages get credential and lock-out coverage, forms get required-field
/// and boundary coverage, lists get view and filter coverage, and every authenticated page
/// gets a smoke check. It works from what discovery actually observed, so the steps it
/// produces reference real locators on real pages.</summary>
internal static class LocalTestPlanner
{
    public static string Generate(JsonElement context)
    {
        var pages = LocalJson.Array(context, "pages").ToList();
        var requirement = LocalJson.String(context, "requirement");
        var scenarios = new List<object>();

        // A single-page application serves one <title> for every route, so naming scenarios
        // after the title alone produced three cases all called "View AIRA Demo Bank" — a
        // suite a reviewer cannot act on. Where a title does not distinguish a page, the
        // route does.
        var titleCounts = pages
            .GroupBy(page => LocalJson.String(page, "title") ?? LocalJson.String(page, "route") ?? "/")
            .ToDictionary(group => group.Key, group => group.Count());

        foreach (var page in pages)
        {
            var kind = LocalJson.String(page, "kind") ?? "unknown";
            var route = LocalJson.String(page, "route") ?? "/";
            var pageTitle = LocalJson.String(page, "title") ?? route;
            var title = titleCounts.TryGetValue(pageTitle, out var shared) && shared > 1
                ? $"{pageTitle} {route}"
                : pageTitle;
            var url = LocalJson.String(page, "url") ?? route;
            var elements = LocalJson.Array(page, "elements").ToList();

            switch (kind)
            {
                case "login":
                    scenarios.AddRange(LoginScenarios(url, title, elements));
                    break;
                case "form":
                    scenarios.AddRange(FormScenarios(url, title, route, elements));
                    break;
                case "list":
                case "report":
                    scenarios.AddRange(ListScenarios(url, title, route, elements));
                    break;
                case "dashboard":
                    scenarios.Add(SmokeScenario(url, title, route, elements, "Critical"));
                    break;
                default:
                    scenarios.Add(SmokeScenario(url, title, route, elements, "Medium"));
                    break;
            }
        }

        // Keep the plan to a reviewable size; the schema caps it at 40 in any case.
        var ordered = scenarios.Take(40).ToList();

        var summary = requirement is null
            ? $"Generated {ordered.Count} scenarios from {pages.Count} discovered pages using AIRA's built-in rules (no model provider configured)."
            : $"Generated {ordered.Count} scenarios covering \"{Truncate(requirement, 200)}\" from {pages.Count} discovered pages using AIRA's built-in rules (no model provider configured).";

        return LocalJson.Serialize(new { summary, scenarios = ordered });
    }

    // ---- Login -------------------------------------------------------------

    private static IEnumerable<object> LoginScenarios(string url, string title, List<JsonElement> elements)
    {
        var username = Find(elements, e => IsTextInput(e) && Mentions(e, "user", "email", "login"));
        var password = Find(elements, e => LocalJson.String(e, "type") == "password" || Mentions(e, "password"));
        var submit = Find(elements, e => IsButton(e));

        if (username is null || password is null || submit is null) yield break;

        var usernameLocator = Locator(username.Value);
        var passwordLocator = Locator(password.Value);
        var submitLocator = Locator(submit.Value);

        yield return new
        {
            name = "Sign in with valid credentials",
            objective = "A registered customer can sign in and reach the authenticated area.",
            category = "positive",
            priority = "critical",
            risk = "critical",
            preconditions = "A valid account exists and its credentials are configured as project secrets.",
            expectedResults = "The customer is signed in and the application leaves the sign-in page.",
            tags = new[] { "authentication", "smoke" },
            testData = new Dictionary<string, string> { ["username"] = "${secret:app_username}", ["password"] = "${secret:app_password}" },
            steps = new object[]
            {
                Step("Open the sign-in page", "navigate", url: url),
                Step("Enter the username", "fill", usernameLocator, value: "${secret:app_username}"),
                Step("Enter the password", "fill", passwordLocator, value: "${secret:app_password}"),
                Step("Submit the sign-in form", "click", submitLocator),
                StepWithAssertion("Confirm the sign-in page has been left", "assertUrl", null,
                    Assertion("urlContains", expected: "/", description: "The browser has navigated away from the sign-in page."),
                    expected: "/")
            }
        };

        yield return new
        {
            name = "Sign in with an incorrect password",
            objective = "An incorrect password is rejected and reported to the customer.",
            category = "negative",
            priority = "high",
            risk = "high",
            preconditions = "A valid account exists.",
            expectedResults = "Sign-in is refused and an error is shown. No session is established.",
            tags = new[] { "authentication", "negative" },
            testData = new Dictionary<string, string> { ["username"] = "${secret:app_username}", ["password"] = "not-the-right-password" },
            steps = new object[]
            {
                Step("Open the sign-in page", "navigate", url: url),
                Step("Enter the username", "fill", usernameLocator, value: "${secret:app_username}"),
                Step("Enter an incorrect password", "fill", passwordLocator, value: "not-the-right-password"),
                Step("Submit the sign-in form", "click", submitLocator),
                StepWithAssertion("Confirm the sign-in form is still shown", "assertVisible", passwordLocator,
                    Assertion("visible", passwordLocator, description: "The password field is still present, so sign-in did not succeed."))
            }
        };

        yield return new
        {
            name = "Sign in with an empty password",
            objective = "The form refuses to submit without a password.",
            category = "validation",
            priority = "medium",
            risk = "medium",
            preconditions = "None.",
            expectedResults = "The form is not submitted and the password field remains focused or flagged.",
            tags = new[] { "authentication", "validation" },
            testData = new Dictionary<string, string>(),
            steps = new object[]
            {
                Step("Open the sign-in page", "navigate", url: url),
                Step("Enter the username", "fill", usernameLocator, value: "${secret:app_username}"),
                Step("Leave the password empty", "fill", passwordLocator, value: ""),
                Step("Submit the sign-in form", "click", submitLocator),
                StepWithAssertion("Confirm the password field is still shown", "assertVisible", passwordLocator,
                    Assertion("visible", passwordLocator, description: "The form was not accepted without a password."))
            }
        };

        yield return new
        {
            name = "Sign in with an unknown username",
            objective = "An unknown account is rejected without revealing whether the username exists.",
            category = "security",
            priority = "high",
            risk = "high",
            preconditions = "None.",
            expectedResults = "Sign-in is refused with a message that does not distinguish an unknown username from a wrong password.",
            tags = new[] { "authentication", "security" },
            testData = new Dictionary<string, string>(),
            steps = new object[]
            {
                Step("Open the sign-in page", "navigate", url: url),
                Step("Enter an unknown username", "fill", usernameLocator, value: "no-such-account-aira"),
                Step("Enter any password", "fill", passwordLocator, value: "not-the-right-password"),
                Step("Submit the sign-in form", "click", submitLocator),
                StepWithAssertion("Confirm sign-in was refused", "assertVisible", passwordLocator,
                    Assertion("visible", passwordLocator, description: "The customer remains on the sign-in form."))
            }
        };
    }

    // ---- Forms -------------------------------------------------------------

    private static IEnumerable<object> FormScenarios(string url, string title, string route, List<JsonElement> elements)
    {
        var inputs = elements.Where(IsTextInput).ToList();
        var submit = Find(elements, IsButton);
        if (submit is null) yield break;

        var submitLocator = Locator(submit.Value);

        var happyPath = new List<object> { Step($"Open {title}", "navigate", url: url) };
        foreach (var input in inputs.Take(6))
        {
            happyPath.Add(Step($"Complete {LabelOf(input)}", "fill", Locator(input), value: SampleFor(input)));
        }
        happyPath.Add(Step("Submit the form", "click", submitLocator));

        // A success signal only exists in the DOM after a successful submission, so a crawl
        // of the healthy application usually never sees one. Where discovery did find a
        // confirmation element, assert it. Where it did not, assert nothing: an earlier
        // version closed by asserting the submit control was still visible, which holds
        // however the application behaved — and would fail a well-behaved form that
        // navigates away (BUG-0016). The scenario still has value without it, because the
        // fill and click steps fail if the form is broken.
        var successSignal = Find(elements, e =>
            LocalJson.String(e, "ariaRole") is "status"
            || Mentions(e, "success", "confirmation", "confirmed", "receipt", "thank", "complete"));
        if (successSignal is not null)
        {
            happyPath.Add(StepWithAssertion("Confirm the application reported success", "assertVisible",
                Locator(successSignal.Value),
                Assertion("visible", Locator(successSignal.Value),
                    description: "The application confirms the submission was accepted.")));
        }

        yield return new
        {
            name = $"Submit {title} with valid values",
            objective = $"The {title} form accepts a valid submission.",
            category = "positive",
            priority = "high",
            risk = "high",
            preconditions = "The customer is signed in.",
            expectedResults = successSignal is not null
                ? "The form is accepted and the application confirms the outcome."
                : "The form is accepted. Discovery found no confirmation element on this page, so no success "
                  + "assertion was generated — add the application's own success signal before relying on this test.",
            tags = new[] { "form", Slug(route) },
            testData = inputs.Take(6).ToDictionary(i => FieldKey(i), SampleFor),
            steps = happyPath.ToArray()
        };

        var required = inputs.Where(i => LocalJson.Bool(i, "isRequired")).ToList();
        if (required.Count > 0)
        {
            yield return new
            {
                name = $"Submit {title} with required fields empty",
                objective = "Required-field validation is enforced.",
                category = "validation",
                priority = "medium",
                risk = "medium",
                preconditions = "The customer is signed in.",
                expectedResults = "The form is refused and each missing field is reported.",
                tags = new[] { "form", "validation", Slug(route) },
                testData = new Dictionary<string, string>(),
                steps = new object[]
                {
                    Step($"Open {title}", "navigate", url: url),
                    Step("Submit the form without completing it", "click", submitLocator),
                    StepWithAssertion("Confirm the form was not accepted", "assertVisible", submitLocator,
                        Assertion("visible", submitLocator, description: "The form is still shown, so the submission was refused."))
                }
            };
        }

        var numeric = inputs.FirstOrDefault(i =>
            LocalJson.String(i, "type") == "number" || Mentions(i, "amount", "quantity", "total"));
        if (numeric.ValueKind == JsonValueKind.Object)
        {
            yield return new
            {
                name = $"Reject an invalid amount on {title}",
                objective = "Numeric validation rejects a value outside the accepted range.",
                category = "boundary",
                priority = "medium",
                risk = "medium",
                preconditions = "The customer is signed in.",
                expectedResults = "The submission is refused with a validation message.",
                tags = new[] { "form", "boundary", Slug(route) },
                testData = new Dictionary<string, string> { ["amount"] = "-1" },
                steps = new object[]
                {
                    Step($"Open {title}", "navigate", url: url),
                    Step($"Enter a negative value in {LabelOf(numeric)}", "fill", Locator(numeric), value: "-1"),
                    Step("Submit the form", "click", submitLocator),
                    StepWithAssertion("Confirm the submission was refused", "assertVisible", submitLocator,
                        Assertion("visible", submitLocator, description: "The form is still shown, so the value was refused."))
                }
            };
        }
    }

    // ---- Lists and reports --------------------------------------------------

    private static IEnumerable<object> ListScenarios(string url, string title, string route, List<JsonElement> elements)
    {
        var table = elements.FirstOrDefault(e => LocalJson.String(e, "kind") == "table");

        // The control that applies the filter has to be a control that can apply it.
        // Matching on the name alone selected whichever element scored highest for
        // stability — often a date field or the form itself — so the step called "Apply the
        // filter" clicked something that applies nothing, and the assertion that followed
        // judged an unfiltered list (BUG-0016).
        var filterButton = Find(elements, e => IsButton(e) && Mentions(e, "apply", "filter", "search", "submit"))
            ?? Find(elements, e => IsButton(e) && Mentions(e, "go", "update", "refresh"));
        var filter = filterButton ?? default;

        var steps = new List<object>
        {
            Step($"Open {title}", "navigate", url: url)
        };

        if (table.ValueKind == JsonValueKind.Object)
        {
            steps.Add(StepWithAssertion("Confirm the records are listed", "assertVisible", Locator(table),
                Assertion("visible", Locator(table), description: "The list of records is displayed.")));
        }

        yield return new
        {
            name = $"View {title}",
            objective = $"{title} loads and displays its records.",
            category = "positive",
            priority = "high",
            risk = "medium",
            preconditions = "The customer is signed in and has data to display.",
            expectedResults = "The page loads and the records are visible.",
            tags = new[] { "read-only", Slug(route) },
            testData = new Dictionary<string, string>(),
            steps = steps.ToArray()
        };

        // The closing assertion has to be about something the action could change. Asserting
        // that the filter control is still visible — which an earlier version of this
        // generator did, with a comment admitting it was a placeholder — holds whatever the
        // application does, so the whole scenario could never fail (BUG-0016).
        var validationTarget = Find(elements, e =>
            LocalJson.String(e, "ariaRole") is "alert" or "status"
            || Mentions(e, "error", "validation", "invalid", "warning"));
        var emptyState = Find(elements, e => Mentions(e, "empty", "no-results", "no-records", "nothing"));

        // Which field is the start of the range and which is the end is decided by their
        // names, never by their position. Elements arrive ordered by stability score, so
        // taking the first two date inputs filled the *end* with the later date and the
        // *start* with the earlier one — a perfectly valid range — and the scenario then
        // asserted that a correctly populated list was empty. It failed against a healthy
        // application, and only on the runs where the ordering happened to come out that
        // way (BUG-0016).
        var dateInputs = elements.Where(e => LocalJson.String(e, "type") == "date").ToList();
        var rangeStart = Find(dateInputs, e => Mentions(e, "from", "start", "after", "begin"));
        var rangeEnd = Find(dateInputs, e => Mentions(e, "to", "end", "until", "before")
            && !SameElement(e, rangeStart));

        if (filter.ValueKind == JsonValueKind.Object
            && rangeStart is not null && rangeEnd is not null
            && (validationTarget is not null || emptyState is not null || table.ValueKind == JsonValueKind.Object))
        {
            var filterSteps = new List<object>
            {
                Step($"Open {title}", "navigate", url: url),
                Step("Enter a start date after the end date", "fill", Locator(rangeStart.Value), value: "2030-12-31"),
                Step("Enter an end date before the start date", "fill", Locator(rangeEnd.Value), value: "2020-01-01"),
                Step("Apply the filter", "click", Locator(filter))
            };

            // In order of how directly each answers "did the application refuse the range?".
            // The last is the weakest of the three and still falsifiable: a filter that
            // ignored the dates would list records, and the step would fail.
            if (validationTarget is not null)
            {
                filterSteps.Add(StepWithAssertion("Confirm the invalid range is reported", "assertVisible",
                    Locator(validationTarget.Value),
                    Assertion("visible", Locator(validationTarget.Value),
                        description: "The application explains that the range is invalid.")));
            }
            else if (emptyState is not null)
            {
                filterSteps.Add(StepWithAssertion("Confirm no records are listed for an impossible range", "assertVisible",
                    Locator(emptyState.Value),
                    Assertion("visible", Locator(emptyState.Value),
                        description: "The application reports that nothing matched.")));
            }
            else
            {
                filterSteps.Add(StepWithAssertion("Confirm no records are listed for an impossible range", "assertHidden",
                    Locator(table),
                    Assertion("hidden", Locator(table),
                        description: "No records are listed, because no record can fall inside an impossible range.")));
            }

            yield return new
            {
                name = $"Reject an invalid filter range on {title}",
                objective = "An impossible filter range is refused rather than silently returning nothing.",
                category = "negative",
                priority = "medium",
                risk = "medium",
                preconditions = "The customer is signed in.",
                expectedResults = "A validation message explains that the range is invalid.",
                tags = new[] { "filter", "negative", Slug(route) },
                testData = new Dictionary<string, string>(),
                steps = filterSteps.ToArray()
            };
        }
    }

    private static object SmokeScenario(string url, string title, string route, List<JsonElement> elements, string priority)
    {
        var anchor = elements.FirstOrDefault(e => !string.IsNullOrEmpty(LocalJson.String(e, "accessibleName")));
        var steps = new List<object> { Step($"Open {title}", "navigate", url: url) };

        if (anchor.ValueKind == JsonValueKind.Object)
        {
            steps.Add(StepWithAssertion($"Confirm {title} rendered", "assertVisible", Locator(anchor),
                Assertion("visible", Locator(anchor), description: $"{title} displays its expected content.")));
        }

        return new
        {
            name = $"{title} loads",
            objective = $"{title} loads without error for a signed-in customer.",
            category = "positive",
            priority = priority.ToLowerInvariant(),
            risk = priority.ToLowerInvariant(),
            preconditions = "The customer is signed in.",
            expectedResults = "The page loads and displays its expected content.",
            tags = new[] { "smoke", Slug(route) },
            testData = new Dictionary<string, string>(),
            steps = steps.ToArray()
        };
    }

    // ---- Building blocks ----------------------------------------------------

    private static object Step(string description, string action, object? target = null, string? value = null, string? url = null)
        => new { description, action, target, value, url, assertions = System.Array.Empty<object>() };

    private static object StepWithAssertion(string description, string action, object? target,
        object assertion, string? expected = null)
        => new { description, action, target, expected, assertions = new[] { assertion } };

    private static object Assertion(string type, object? target = null, string? expected = null, string description = "")
        => new { type, target, expected, description };

    private static object Locator(JsonElement element, bool forceRole = false)
    {
        var testId = LocalJson.String(element, "testId");
        if (!forceRole && !string.IsNullOrEmpty(testId))
            return new { strategy = "testId", value = testId };

        var role = LocalJson.String(element, "ariaRole");
        var name = LocalJson.String(element, "accessibleName");
        if (!string.IsNullOrEmpty(role) && !string.IsNullOrEmpty(name))
            return new { strategy = "role", value = role, name };

        var label = LocalJson.String(element, "label");
        if (!string.IsNullOrEmpty(label))
            return new { strategy = "label", value = label };

        var placeholder = LocalJson.String(element, "placeholder");
        if (!string.IsNullOrEmpty(placeholder))
            return new { strategy = "placeholder", value = placeholder };

        return new { strategy = "css", value = LocalJson.String(element, "cssSelector") ?? "body" };
    }

    private static bool IsTextInput(JsonElement element)
    {
        var kind = LocalJson.String(element, "kind");
        return kind is "textInput" or "passwordInput" or "numberInput" or "dateInput" or "textArea";
    }

    private static bool IsButton(JsonElement element)
        => LocalJson.String(element, "kind") == "button"
        || LocalJson.String(element, "ariaRole") == "button";

    /// <summary>Whether two discovered elements are the same one. Compared by the signals a
    /// locator would use, because JsonElement has no meaningful equality.</summary>
    private static bool SameElement(JsonElement candidate, JsonElement? other)
    {
        if (other is null) return false;
        var left = LocalJson.String(candidate, "testId") ?? LocalJson.String(candidate, "cssSelector");
        var right = LocalJson.String(other.Value, "testId") ?? LocalJson.String(other.Value, "cssSelector");
        return left is not null && left == right;
    }

    private static bool Mentions(JsonElement element, params string[] terms)
    {
        var haystack = string.Join(' ', new[]
        {
            LocalJson.String(element, "testId"), LocalJson.String(element, "name"),
            LocalJson.String(element, "accessibleName"), LocalJson.String(element, "label"),
            LocalJson.String(element, "placeholder"), LocalJson.String(element, "elementId")
        }.Where(v => !string.IsNullOrEmpty(v))).ToLowerInvariant();

        return terms.Any(term => haystack.Contains(term, StringComparison.Ordinal));
    }

    private static JsonElement? Find(List<JsonElement> elements, Func<JsonElement, bool> predicate)
    {
        foreach (var element in elements)
        {
            if (predicate(element)) return element;
        }
        return null;
    }

    private static string LabelOf(JsonElement element)
        => LocalJson.String(element, "label")
        ?? LocalJson.String(element, "accessibleName")
        ?? LocalJson.String(element, "placeholder")
        ?? LocalJson.String(element, "name")
        ?? "the field";

    private static string FieldKey(JsonElement element)
        => (LocalJson.String(element, "name") ?? LocalJson.String(element, "testId") ?? LabelOf(element))
            .Replace(' ', '_').ToLowerInvariant();

    /// <summary>Type-appropriate sample values, so a generated test is runnable rather than
    /// a template full of placeholders.</summary>
    private static string SampleFor(JsonElement element)
    {
        var type = LocalJson.String(element, "type");
        if (type == "password") return "${secret:app_password}";
        if (type == "email" || Mentions(element, "email")) return "aira.test@example.test";
        if (type == "number" || Mentions(element, "amount")) return "10.00";
        if (type == "date") return DateTime.UtcNow.ToString("yyyy-MM-dd");
        if (type == "tel" || Mentions(element, "phone")) return "+44 20 7946 0000";
        if (Mentions(element, "reference")) return "AIRA-TEST";
        if (Mentions(element, "user", "login")) return "${secret:app_username}";
        return "AIRA test value";
    }

    private static string Slug(string route)
    {
        var cleaned = new string(route.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray()).ToLowerInvariant();
        return string.IsNullOrEmpty(cleaned) ? "root" : cleaned[..Math.Min(cleaned.Length, 40)];
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
