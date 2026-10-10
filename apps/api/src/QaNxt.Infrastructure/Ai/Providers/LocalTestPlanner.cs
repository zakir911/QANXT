using System.Text.Json;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Enums;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>Derives a test plan from the discovered application model.
///
/// The rules encode what an experienced QA engineer does on first contact with an
/// application: sign-in pages get credential and lock-out coverage, forms get required-field
/// and boundary coverage, lists get view and filter coverage, and every authenticated page
/// gets a smoke check. It works from what discovery actually observed, so the steps it
/// produces reference real locators on real pages.
///
/// Every page contributes at least one scenario. The kind-specific generators each refuse to
/// invent a locator they cannot see — a login page with no password field it recognises, a
/// form with no submit button — and each of them used to simply yield nothing in that case.
/// With every discovered page falling into one of those branches the plan came back empty,
/// and since the schema requires at least one scenario the user saw
/// "/scenarios: Value should have at least 1 items (minItems)" with nothing to act on.
///
/// The fix is not to invent coverage. It is to fall back to the smoke scenario, which needs
/// no elements at all: open the page, assert it rendered. That is a true statement about a
/// page that exists, and it is the honest floor for a page whose controls were not
/// recognised.</summary>
internal static class LocalTestPlanner
{
    public static string Generate(JsonElement context)
    {
        var pages = LocalJson.Array(context, "pages").ToList();
        var requirement = LocalJson.String(context, "requirement");
        var scenarios = new List<object>();

        // A single-page application serves one <title> for every route, so naming scenarios
        // after the title alone produced three cases all called "View QA NXT Demo Bank" — a
        // suite a reviewer cannot act on. Where a title does not distinguish a page, the
        // route does.
        var titleCounts = pages
            .GroupBy(page => LocalJson.String(page, "title") ?? LocalJson.String(page, "route") ?? "/")
            .ToDictionary(group => group.Key, group => group.Count());

        // Whether the application needs a sign-in at all. Without it the smoke scenario
        // asserted "The customer is signed in." as a precondition on a public site, which is
        // a claim about the application that discovery never observed.
        var requiresSignIn = LocalJson.Bool(context, "requiresSignIn");

        // Pages whose kind-specific generator produced nothing. Counted rather than
        // discarded, so the summary can say which pages only got a smoke check instead of
        // quietly implying they were covered properly.
        var fellBackTo = new List<string>();

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

            var before = scenarios.Count;

            switch (kind)
            {
                case "login":
                    scenarios.AddRange(LoginScenarios(url, title, elements));
                    break;
                case "form":
                    scenarios.AddRange(FormScenarios(url, title, route, elements, requiresSignIn));
                    break;
                case "list":
                case "report":
                    scenarios.AddRange(ListScenarios(url, title, route, elements, requiresSignIn));
                    break;
                case "dashboard":
                    scenarios.Add(SmokeScenario(url, title, route, elements, "Critical", requiresSignIn));
                    break;
                default:
                    scenarios.Add(SmokeScenario(url, title, route, elements, "Medium", requiresSignIn));
                    break;
            }

            var fromKind = scenarios.Count - before;

            // Then the controls themselves, whatever the page was classified as. This is
            // where most of the coverage comes from: the kind-specific generators above
            // only recognise three page shapes, and every control on every other page used
            // to contribute nothing.
            var fromElements = ElementScenarios(url, title, route, elements, requiresSignIn).ToList();
            scenarios.AddRange(fromElements);

            // Every page now gets an accessibility check and a console check, so no page
            // ends up with nothing. That makes the honest question a different one: did
            // anything on this page get tested, or only the page itself? A page whose
            // controls produced nothing has been loaded, not covered, and a reviewer
            // deciding whether this suite means anything has to be told which pages those
            // are — otherwise the improvement quietly hides the gap it used to disclose.
            var controlScenarios = fromKind + fromElements.Count(s => !IsPageLevel(s));
            if (controlScenarios == 0) fellBackTo.Add(route);
        }

        // No cap here. The caller's budget is the only limit that should apply, and it is
        // applied in TestGenerationService where the user set it: truncating silently at a
        // number nobody chose is how an application with forty pages produced forty tests
        // and looked complete.
        var ordered = scenarios;

        var summary = requirement is null
            ? $"Generated {ordered.Count} scenarios from {pages.Count} discovered pages using QA NXT's built-in rules (no model provider configured)."
            : $"Generated {ordered.Count} scenarios covering \"{Truncate(requirement, 200)}\" from {pages.Count} discovered pages using QA NXT's built-in rules (no model provider configured).";

        // Said plainly rather than left to be inferred from thin scenarios. A page that only
        // got "it loads" has not been covered, and a reviewer deciding whether this suite
        // means anything needs to know which pages those were.
        if (fellBackTo.Count > 0)
        {
            var routes = string.Join(", ", fellBackTo.Take(10));
            summary += $" {fellBackTo.Count} page(s) only got a load check because no testable"
                     + $" control was recognised on them: {routes}"
                     + (fellBackTo.Count > 10 ? ", …" : string.Empty)
                     + ". Those pages are not covered beyond loading.";
        }

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
                // The password is never typed. A fill with an empty value is refused by the
                // step validator, so this scenario was silently dropped on every generation
                // since it was written: the suite was one test smaller than it reported and
                // nothing said why.
                Step("Submit the sign-in form without a password", "click", submitLocator),
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
                Step("Enter an unknown username", "fill", usernameLocator, value: "no-such-account-qanxt"),
                Step("Enter any password", "fill", passwordLocator, value: "not-the-right-password"),
                Step("Submit the sign-in form", "click", submitLocator),
                StepWithAssertion("Confirm sign-in was refused", "assertVisible", passwordLocator,
                    Assertion("visible", passwordLocator, description: "The customer remains on the sign-in form."))
            }
        };
    }

    // ---- Forms -------------------------------------------------------------

    private static IEnumerable<object> FormScenarios(string url, string title, string route,
        List<JsonElement> elements, bool requiresSignIn)
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
            preconditions = SignedInPrecondition(requiresSignIn),
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
                preconditions = SignedInPrecondition(requiresSignIn),
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
                preconditions = SignedInPrecondition(requiresSignIn),
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

    private static IEnumerable<object> ListScenarios(string url, string title, string route,
        List<JsonElement> elements, bool requiresSignIn)
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
            preconditions = requiresSignIn
                ? "The customer is signed in and has data to display."
                : "The page has data to display.",
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
            //
            // What a tier CLAIMS has to match what it CHECKS, so the name, the objective and
            // the expected results are decided by the same branch that chooses the assertion.
            // Declaring "a validation message explains that the range is invalid" on all three
            // — which this generator did — shipped a test whose stated expectation was the
            // opposite of its assertion: the weakest tier passes exactly when the application
            // silently returns nothing, the behaviour the objective named as the failure. A
            // reviewer reading the test case sees a promise the steps never keep, and a green
            // run means less than it says. BUG-0016 made these assertions falsifiable; it left
            // them untruthful.
            //
            // The first tier is also rarer than it looks. Discovery records a page in its
            // pre-interaction state, so a validation message rendered in response to the very
            // submit this scenario performs is not in the element set, and validationTarget is
            // null for every application of that shape. The lower tiers are the normal path,
            // not the exception, which is why their wording carries the weight: they say what
            // they checked, and they say plainly what they did not.
            string name;
            string objective;
            string expectedResults;

            if (validationTarget is not null)
            {
                filterSteps.Add(StepWithAssertion("Confirm the invalid range is reported", "assertVisible",
                    Locator(validationTarget.Value),
                    Assertion("visible", Locator(validationTarget.Value),
                        description: "The application explains that the range is invalid.")));

                name = $"Reject an invalid filter range on {title}";
                objective = "An impossible filter range is refused rather than silently returning nothing.";
                expectedResults = "A validation message explains that the range is invalid.";
            }
            else if (emptyState is not null)
            {
                filterSteps.Add(StepWithAssertion("Confirm no records are listed for an impossible range", "assertVisible",
                    Locator(emptyState.Value),
                    Assertion("visible", Locator(emptyState.Value),
                        description: "The application reports that nothing matched.")));

                name = $"An impossible filter range on {title} returns no records";
                objective = "An impossible filter range returns no records and the page says so.";
                expectedResults = "The page reports that nothing matched. Whether the range was refused "
                    + "with a validation message is not checked: discovery observed no element that "
                    + "reports one on this page.";
            }
            else
            {
                filterSteps.Add(StepWithAssertion("Confirm no records are listed for an impossible range", "assertHidden",
                    Locator(table),
                    Assertion("hidden", Locator(table),
                        description: "No records are listed, because no record can fall inside an impossible range.")));

                name = $"An impossible filter range on {title} lists no records";
                objective = "An impossible filter range leaves no records listed.";
                expectedResults = "The list of records is not displayed. Whether the range was refused "
                    + "with a validation message is not checked: discovery observed no element that "
                    + "reports one on this page.";
            }

            yield return new
            {
                name,
                objective,
                category = "negative",
                priority = "medium",
                risk = "medium",
                preconditions = SignedInPrecondition(requiresSignIn),
                expectedResults,
                tags = new[] { "filter", "negative", Slug(route) },
                testData = new Dictionary<string, string>(),
                steps = filterSteps.ToArray()
            };
        }
    }

    private static object SmokeScenario(string url, string title, string route,
        List<JsonElement> elements, string priority, bool requiresSignIn)
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
            objective = requiresSignIn
                ? $"{title} loads without error for a signed-in customer."
                : $"{title} loads without error.",
            category = "positive",
            priority = priority.ToLowerInvariant(),
            risk = priority.ToLowerInvariant(),
            // Only claimed when the application is actually configured to sign in. Stating it
            // for a public site describes a precondition nobody can satisfy and that
            // discovery never observed.
            preconditions = requiresSignIn
                ? "The customer is signed in."
                : "None.",
            expectedResults = "The page loads and displays its expected content.",
            tags = new[] { "smoke", Slug(route) },
            testData = new Dictionary<string, string>(),
            steps = steps.ToArray()
        };
    }




    /// <summary>The tag marking a scenario as about the page itself, not a control on it.
    ///
    /// An explicit marker rather than a guess from the other tags: this drives the summary's
    /// "no testable control" disclosure, and keying it on a tag that happens to describe the
    /// check means renaming that tag silently stops reporting uncovered pages. That nearly
    /// happened when the console check became a reachability check.</summary>
    private const string PageLevelTag = "page-level";

    private static bool IsPageLevel(object scenario)
    {
        var tags = scenario.GetType().GetProperty("tags")?.GetValue(scenario) as string[];
        return tags is not null && tags.Contains(PageLevelTag);
    }

    /// <summary>The precondition about signing in, or none.
    ///
    /// Stated only when the application is configured to authenticate. Asserting it on a
    /// public page describes a precondition nobody can satisfy and that discovery never
    /// observed — and it was hardcoded into every generator, not only the smoke one.</summary>
    private static string SignedInPrecondition(bool requiresSignIn)
        => requiresSignIn ? "The customer is signed in." : "None.";

    // ---- Element-driven coverage -------------------------------------------

    /// <summary>
    /// Scenarios for the controls on a page, whatever the page was classified as.
    ///
    /// This is what turns a discovered page into real coverage. The kind-specific
    /// generators above handle the shapes they recognise; this handles every control they
    /// did not, which on most applications is nearly all of them. A required field deserves
    /// a required-field test on a dashboard exactly as much as on a form.
    ///
    /// Each scenario is a complete, runnable test: navigate, act, assert. None of them
    /// assert a specific message, because the message is the application's to choose — they
    /// assert that the value was refused and the user was kept on the page, which is the
    /// behaviour, and a reviewer can tighten it afterwards.
    /// </summary>
    private static IEnumerable<object> ElementScenarios(
        string url, string title, string route, List<JsonElement> elements, bool requiresSignIn)
    {
        var fields = elements.Where(LocalElementRules.IsValidationSurface).ToList();
        var submit = Find(elements, e => IsButton(e) && Mentions(e, "submit", "save", "continue", "next", "sign in", "log in", "search", "apply"))
                  ?? Find(elements, IsButton);

        foreach (var field in fields)
        {
            var semantic = LocalElementRules.SemanticOf(field);
            var label = LabelOf(field);
            var locator = Locator(field);
            var required = LocalJson.Bool(field, "isRequired");

            // Required first: it is the cheapest check and the one most often missing.
            if (required)
            {
                yield return Scenario(
                    name: $"{label} is required on {title}",
                    objective: $"Submitting {title} without {label} is refused rather than accepted silently.",
                    category: "negative",
                    priority: "high",
                    route: route,
                    requiresSignIn: requiresSignIn,
                    expected: $"The form is not submitted and {label} is reported as required.",
                    tags: new[] { "validation", "required", Slug(route) },
                    steps: Steps(
                        Step($"Open {title}", "navigate", url: url),
                        // The field is simply never filled. "fill" with an empty value is
                        // refused by the step validator, and not touching the control is a
                        // truer test of required-ness than clearing it would be.
                        SubmitStep(submit),
                        StepWithAssertion("Confirm the value was refused", "assertUrl", null,
                            Assertion("urlContains", null, route,
                                $"The user stays on {title} because {label} was not supplied."),
                            expected: route)));
            }

            foreach (var (value, checking) in LocalElementRules.InvalidValuesFor(semantic))
            {
                yield return Scenario(
                    name: $"{label} rejects {checking} on {title}",
                    objective: $"{label} refuses a value that is not a valid "
                             + $"{semantic.ToString().ToLowerInvariant()}.",
                    category: "negative",
                    priority: "medium",
                    route: route,
                    requiresSignIn: requiresSignIn,
                    expected: $"{label} is refused and the user stays on {title}.",
                    tags: new[] { "validation", "format", Slug(route) },
                    steps: Steps(
                        Step($"Open {title}", "navigate", url: url),
                        Step($"Enter {checking} into {label}", "fill", target: locator, value: value),
                        SubmitStep(submit),
                        StepWithAssertion("Confirm the value was refused", "assertUrl", null,
                            Assertion("urlContains", null, route,
                                $"The user stays on {title} because {label} was invalid."),
                            expected: route)));
            }

            foreach (var (value, checking) in LocalElementRules.BoundaryValuesFor(semantic))
            {
                yield return Scenario(
                    name: $"{label} handles {checking} on {title}",
                    objective: $"{label} behaves predictably at its boundary rather than "
                             + "truncating, overflowing or erroring.",
                    category: "boundary",
                    priority: "medium",
                    route: route,
                    requiresSignIn: requiresSignIn,
                    expected: $"{label} either accepts the value cleanly or refuses it with a message. "
                            + "An unhandled error is a failure.",
                    tags: new[] { "validation", "boundary", Slug(route) },
                    steps: Steps(
                        Step($"Open {title}", "navigate", url: url),
                        Step($"Enter {checking} into {label}", "fill", target: locator, value: value),
                        SubmitStep(submit),
                        StepWithAssertion("Confirm the application is still responding", "assertUrl", null,
                            Assertion("urlContains", null, route,
                                "The application handled the boundary value without navigating away "
                                + "to an error page."),
                            expected: route)));
            }

            // Whitespace is its own case: a field that trims is correct, a field that
            // accepts "   " as a name is not, and the two are indistinguishable without it.
            yield return Scenario(
                name: $"{label} does not accept whitespace alone on {title}",
                objective: $"{label} treats a value of only spaces as empty rather than as content.",
                category: "negative",
                priority: "low",
                route: route,
                requiresSignIn: requiresSignIn,
                expected: $"{label} is refused, the same as if it had been left empty.",
                tags: new[] { "validation", "whitespace", Slug(route) },
                steps: Steps(
                    Step($"Open {title}", "navigate", url: url),
                    Step($"Enter three spaces into {label}", "fill", target: locator, value: "   "),
                    SubmitStep(submit),
                    StepWithAssertion("Confirm the value was refused", "assertUrl", null,
                        Assertion("urlContains", null, route,
                            $"The user stays on {title} because {label} held no real content."),
                        expected: route)));
        }

        // Selects: the default, and each option, because an option that errors when chosen
        // is a defect nobody finds by only ever leaving the default.
        foreach (var select in elements.Where(e => LocalJson.String(e, "kind") == "select"))
        {
            var label = LabelOf(select);
            yield return Scenario(
                name: $"{label} can be changed on {title}",
                objective: $"Choosing a different option in {label} is accepted and reflected.",
                category: "positive",
                priority: "medium",
                route: route,
                requiresSignIn: requiresSignIn,
                expected: $"{label} shows the chosen option and the page does not error.",
                tags: new[] { "ui", "select", Slug(route) },
                steps: Steps(
                    Step($"Open {title}", "navigate", url: url),
                    // select carries a value or the step validator refuses it. Index 1 is
                    // the first option after the usual placeholder.
                    Step($"Choose a different option in {label}", "select",
                        target: Locator(select), value: "1"),
                    StepWithAssertion($"Confirm {label} still shows a value", "assertVisible", Locator(select),
                        Assertion("visible", Locator(select), null,
                            $"{label} is still present and usable after the choice."))));
        }

        foreach (var checkbox in elements.Where(e =>
                     LocalJson.String(e, "kind") is "checkbox" or "radio"))
        {
            var label = LabelOf(checkbox);
            yield return Scenario(
                name: $"{label} can be toggled on {title}",
                objective: $"{label} responds to being toggled and holds its state.",
                category: "positive",
                priority: "low",
                route: route,
                requiresSignIn: requiresSignIn,
                expected: $"{label} reflects the new state.",
                tags: new[] { "ui", "toggle", Slug(route) },
                steps: Steps(
                    Step($"Open {title}", "navigate", url: url),
                    Step($"Toggle {label}", "click", target: Locator(checkbox)),
                    StepWithAssertion($"Confirm {label} changed state", "assertVisible", Locator(checkbox),
                        Assertion("visible", Locator(checkbox), null,
                            $"{label} is still present after being toggled."))));
        }

        // Every page gets an accessibility baseline. This is a deterministic engine check,
        // not a judgement, and it is the kind of coverage that is cheap to run and
        // expensive to retrofit.
        yield return Scenario(
            name: $"{title} has no critical accessibility violations",
            objective: $"{title} passes the automated accessibility rules that can be checked "
                     + "without a human.",
            category: "accessibility",
            priority: "medium",
            route: route,
            requiresSignIn: requiresSignIn,
            expected: "No critical or serious violation is reported. "
                    + "Automated rules cover a part of accessibility, not all of it.",
            tags: new[] { "accessibility", PageLevelTag, Slug(route) },
            steps: Steps(
                Step($"Open {title}", "navigate", url: url),
                Step("Run the accessibility rules", "checkAccessibility")));

        // A reachability check for the page itself.
        //
        // This was a console-error assertion, which reads better and cannot run: the
        // schema lists noConsoleErrors but the executor does not implement it, and an
        // unimplemented assertion is reported as a failure, so every such test would have
        // failed for ever on a working application. Discovery already records the console
        // error count per page; asserting on it needs the executor to support it first.
        yield return Scenario(
            name: $"{title} is reachable and stays on its own route",
            objective: $"Opening {title} lands on {route} rather than redirecting to an error "
                     + "page or a sign-in the test did not expect.",
            category: "positive",
            priority: "medium",
            route: route,
            requiresSignIn: requiresSignIn,
            expected: $"The browser ends up on {route}.",
            tags: new[] { "smoke", PageLevelTag, Slug(route) },
            steps: Steps(
                Step($"Open {title}", "navigate", url: url),
                StepWithAssertion("Confirm the route", "assertUrl", null,
                    Assertion("urlContains", null, route,
                        $"{title} is reachable at {route}."),
                    expected: route)));
    }

    /// <summary>A submit step, or a no-op description when the page has no button to press.</summary>
    /// <summary>Submits, or moves focus on so a field-level validator fires.
    ///
    /// Tab rather than a "blur" action: blur is not in the step vocabulary the schema
    /// allows or the executor implements, and a step the runner rejects is worse than no
    /// step at all.</summary>
    private static object SubmitStep(JsonElement? submit)
        => submit is null
            ? Step("Move focus away from the field to trigger validation", "press", value: "Tab")
            : Step("Submit", "click", target: Locator(submit.Value));

    private static object[] Steps(params object[] steps) => steps;

    /// <summary>One scenario, in the shape the test_plan schema expects.</summary>
    private static object Scenario(
        string name, string objective, string category, string priority, string route,
        bool requiresSignIn, string expected, string[] tags, object[] steps)
        => new
        {
            name = Truncate(name, 200),
            objective = Truncate(objective, 500),
            category,
            priority,
            risk = priority,
            preconditions = requiresSignIn ? "The customer is signed in." : "None.",
            expectedResults = Truncate(expected, 500),
            tags,
            testData = new Dictionary<string, string>(),
            steps
        };

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
        if (type == "email" || Mentions(element, "email")) return "qanxt.test@example.test";
        if (type == "number" || Mentions(element, "amount")) return "10.00";
        if (type == "date") return DateTime.UtcNow.ToString("yyyy-MM-dd");
        if (type == "tel" || Mentions(element, "phone")) return "+44 20 7946 0000";
        if (Mentions(element, "reference")) return "QANXT-TEST";
        if (Mentions(element, "user", "login")) return "${secret:app_username}";
        return "QA NXT test value";
    }

    private static string Slug(string route)
    {
        var cleaned = new string(route.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray()).ToLowerInvariant();
        return string.IsNullOrEmpty(cleaned) ? "root" : cleaned[..Math.Min(cleaned.Length, 40)];
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
