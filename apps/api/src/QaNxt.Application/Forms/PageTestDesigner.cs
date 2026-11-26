using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Forms;

/// <summary>A discovered page, as the page designer needs it.</summary>
public sealed record DesignPage(
    Guid Id, string Url, string Route, string Title, PageKind Kind, bool RequiresAuthentication, int? HttpStatus,
    IReadOnlyList<DesignElement> Elements);

/// <summary>A discovered element with the locator discovery recorded for it.</summary>
public sealed record DesignElement(Guid Id, ElementKind Kind, string Name, bool Visible, LocatorDescriptor Locator);

/// <summary>One click on the way to a page: from which page, on which control.</summary>
public sealed record NavigationHop(DesignPage From, DesignElement Control, DesignPage To);

public sealed record PageDesignContext(
    DesignPage Page,
    /// <summary>The clicks from the first page after sign-in to this one, as discovery made
    /// them; empty when discovery reached the page only by its address.</summary>
    IReadOnlyList<NavigationHop> Path,
    bool HasSignIn,
    /// <summary>Names shown on the sign-in page, which therefore prove nothing about being signed in.</summary>
    IReadOnlySet<string> SignInPageNames,
    TestingProfile Profile,
    /// <summary>Business rules the application's owner stated, already read into blocks. Empty
    /// when no rules file is configured, which is the normal case: everything else the designer
    /// emits asks a question the application answers about itself.</summary>
    IReadOnlyList<BusinessRuleBlock>? BusinessRules = null);

public sealed record PageDesign(IReadOnlyList<DesignedTest> Tests, IReadOnlyList<DesignedGap> Gaps);

/// <summary>Designs the page-level tests for one discovered page: that it opens and shows its
/// content, that a user reaches it through the application's own navigation, that a
/// signed-out visitor cannot see it, and the page-wide accessibility, load-time and
/// screen-size checks.
///
/// The form engine covers what a page's forms do; this covers every page, including the
/// many with no form at all, which used to get no test. Like the form engine it is
/// deterministic, invents no locator (every assertion targets an element discovery saw),
/// and asserts nothing whose text is likely to change between visits.</summary>
public static class PageTestDesigner
{
    // Text with digits is usually data (a balance, a date, a count), and greetings carry the
    // user's name: neither identifies the page from one visit to the next.
    private static readonly Regex Volatile = new(@"\d|welcome|hello|hi,|good (morning|afternoon|evening)|loading|please wait", RegexOptions.IgnoreCase);
    // Pages a bank or shop shows to anyone; a signed-out visitor seeing them is not a defect.
    private static readonly Regex PublicPage = new(@"contact|locate|locator|branch|atm|about|privacy|cookie|terms|faq|help|support|register|sign ?up|forgot|reset|disclaimer|sitemap|career|news|press|legal|security tips|grievance",
        RegexOptions.IgnoreCase);

    public static PageDesign Design(PageDesignContext ctx)
    {
        var tests = new List<DesignedTest>();
        var gaps = new List<DesignedGap>();
        var page = ctx.Page;
        var profile = ctx.Profile;
        var name = PageName(page);
        var landmarks = Landmarks(page, ctx.SignInPageNames);
        var open = new DesignedStep(BrowserActionType.Navigate, $"Open {name}", Url: page.Url);
        var atRoute = new DesignedStep(BrowserActionType.AssertUrl, $"Confirm the address is {page.Route}", Expected: UrlFragment(page));

        DesignedTest Test(TestCategory category, string technique, string title, string objective, string expected,
            IReadOnlyList<DesignedStep> steps, TestPriority priority, string preconditions, string? evidence = null) => new()
        {
            Key = Key(page.Id, category, technique),
            Name = Truncate($"{name}: {title}", 300),
            Category = category,
            Technique = technique,
            Priority = priority,
            Risk = priority switch
            {
                TestPriority.Critical => RiskLevel.Critical, TestPriority.High => RiskLevel.High,
                TestPriority.Low => RiskLevel.Low, _ => RiskLevel.Medium
            },
            Objective = objective,
            Preconditions = preconditions,
            Expected = expected,
            Steps = steps,
            CoverageKeys = new[] { $"page:{page.Id:N}", $"category:{TestingProfile.CategoryKey(category)}" },
            EvidenceRequirements = evidence ?? "Screenshot on failure, network log, console log.",
            Tags = new[] { "page", $"page-kind:{page.Kind.ToString().ToLowerInvariant()}" }
        };

        var signedIn = ctx.HasSignIn && page.RequiresAuthentication ? "The test account is signed in. " : string.Empty;

        // ---- Opens and shows its content --------------------------------------------------
        if (profile.Includes(TestCategory.Smoke))
        {
            var steps = new List<DesignedStep> { open, new(BrowserActionType.AssertNoServerError, "Confirm the page answered without a server error"), atRoute };
            steps.AddRange(landmarks.Select(l => new DesignedStep(BrowserActionType.AssertVisible, $"Confirm \"{l.Name}\" is shown", l.Locator)));
            tests.Add(Test(TestCategory.Smoke, "page-opens", "opens and shows its content",
                $"{name} loads at {page.Route} and shows what discovery saw on it.",
                landmarks.Count > 0
                    ? $"The page opens without a server error and shows {string.Join(", ", landmarks.Select(l => $"\"{l.Name}\""))}."
                    : "The page opens without a server error at its address.",
                steps, page.Kind == PageKind.Dashboard ? TestPriority.Critical : TestPriority.High, $"{signedIn}{name} exists at {page.Route}."));
            if (landmarks.Count == 0)
                gaps.Add(new DesignedGap(TestCategory.Smoke, null, $"{name}: content check",
                    "Discovery saw no stable heading or control on this page to look for, so the test checks only that it opens.",
                    "Add a test id or a heading to the page, or add an assertion to the test by hand.", CoverageGapStatus.PartiallyCovered));
        }

        // ---- Reached through the application's own navigation (end to end) ---------------
        if (profile.Includes(TestCategory.Workflow))
        {
            if (ctx.Path.Count > 0)
            {
                var start = ctx.Path[0].From;
                var steps = new List<DesignedStep> { new(BrowserActionType.Navigate, $"Open {PageName(start)}", Url: start.Url) };
                foreach (var hop in ctx.Path)
                    steps.Add(new(BrowserActionType.Click, $"Press \"{hop.Control.Name}\" on {PageName(hop.From)}", hop.Control.Locator));
                steps.Add(atRoute);
                steps.AddRange(landmarks.Select(l => new DesignedStep(BrowserActionType.AssertVisible, $"Confirm \"{l.Name}\" is shown", l.Locator)));
                var route = string.Join(" → ", ctx.Path.Select(h => $"\"{h.Control.Name}\""));
                tests.Add(Test(TestCategory.Workflow, "navigation", $"is reached from {PageName(start)} through {route}",
                    $"A user reaches {name} by clicking through the application, as discovery did, rather than by typing its address.",
                    $"Each control is there and leads on; {name} opens at {page.Route}.",
                    steps, TestPriority.High, $"{signedIn}The journey starts on {PageName(start)}."));
            }
            else if (page.Kind != PageKind.Login)
            {
                gaps.Add(new DesignedGap(TestCategory.Workflow, null, $"{name}: navigation to the page",
                    "Discovery reached this page by its address (a listed route, the sitemap or the start page), not by clicking, so no click path is known.",
                    "If users reach it through a menu, set \"How discovery explores\" to also click navigation controls and discover again.", CoverageGapStatus.PartiallyCovered));
            }
        }

        // ---- Not shown to a signed-out visitor --------------------------------------------
        var looksPublic = PublicPage.IsMatch(page.Route) || PublicPage.IsMatch(page.Title);
        if (profile.Includes(TestCategory.Security) && ctx.HasSignIn && page.RequiresAuthentication && !looksPublic && landmarks.Count > 0)
        {
            var steps = new List<DesignedStep>
            {
                open,
                new(BrowserActionType.ClearCookies, "Sign out by clearing the session (cookies and storage)"),
                new(BrowserActionType.Navigate, $"Open {name} again, signed out", Url: page.Url)
            };
            steps.AddRange(landmarks.Select(l => new DesignedStep(BrowserActionType.AssertHidden, $"Confirm \"{l.Name}\" is not shown", l.Locator)));
            tests.Add(Test(TestCategory.Security, "access-control", "is not shown to a signed-out visitor",
                $"{name} is behind the sign-in: a visitor without a session is sent away or refused, not shown the page.",
                "Without a session the page's content is not shown.", steps, TestPriority.High,
                $"{signedIn}The page is meant for signed-in users only."));
        }

        // ---- Page-wide checks ----------------------------------------------------------------
        if (profile.Includes(TestCategory.Accessibility))
        {
            var descriptor = JsonSerializer.Serialize(new { failOn = "serious" }, JsonDefaults.Options);
            tests.Add(Test(TestCategory.Accessibility, "axe-page", "has no serious automated accessibility violations",
                "The page passes the automated WCAG rules axe-core can check. Automated rules cover part of accessibility, not all of it.",
                "No serious or critical violation is reported for the page.",
                new List<DesignedStep> { open, new(BrowserActionType.CheckAccessibility, "Run the accessibility rules on the page", Value: descriptor) },
                TestPriority.Medium, $"{signedIn}{name} exists at {page.Route}.", "axe-core results (violations, incomplete, passes), screenshot."));
        }

        if (profile.Includes(TestCategory.Performance))
        {
            var budget = profile.PageLoadBudgetMs.ToString(System.Globalization.CultureInfo.InvariantCulture);
            tests.Add(Test(TestCategory.Performance, "page-load", $"loads within {profile.PageLoadBudgetMs} ms",
                "The page is ready within the configured budget.", $"The page loads in under {profile.PageLoadBudgetMs} ms.",
                new List<DesignedStep> { open, new(BrowserActionType.AssertLoadTimeUnder, $"Confirm the page loaded within {profile.PageLoadBudgetMs} ms", Value: budget) },
                TestPriority.Medium, $"{signedIn}{name} exists at {page.Route}.", "Navigation timing."));
        }

        if (profile.Includes(TestCategory.Accessibility))
        {
            // axe-core runs separately and does not ask this. It checks that colours
            // contrast well enough, which is a different question from whether a colour is
            // the only thing saying what a row is: a status column of green, amber and red
            // squares passes every contrast rule and says nothing without colour vision.
            tests.Add(Test(TestCategory.Accessibility, "colour-only", "does not say anything with colour alone",
                "Nothing on the page is distinguished only by colour.",
                "Every mark that distinguishes one row from another also carries text, a label or a title.",
                new List<DesignedStep> { open, new(BrowserActionType.AssertNotColourOnly, "Confirm nothing is distinguished by colour alone") },
                TestPriority.Medium, $"{signedIn}{name} exists at {page.Route}.",
                "DOM snapshot on failure, screenshot on failure."));
        }

        // Rules the owner stated about this screen. One test each, named after the rule and
        // described in the owner's own words, so a failure reads as "the fuel surcharge applies
        // to the net amount, not the gross" rather than as an arithmetic complaint.
        //
        // Unlike every other test here, these are not derived from the application: they are the
        // one input no amount of crawling produces. Emitted regardless of what the page contains,
        // because the owner said this screen is where the rule applies, and a rule whose fields
        // turn out not to be on the screen must report that rather than quietly not run.
        foreach (var rule in BusinessRuleFile.For(ctx.BusinessRules ?? Array.Empty<BusinessRuleBlock>(), page.Route))
        {
            var says = rule.Means.Length > 0 ? rule.Means : $"the rule {rule.Id} holds";
            var submits = rule.Kind == BusinessRuleKind.Submission;
            tests.Add(Test(
                // A submission rule disbelieves the form's own submit button and asks the
                // endpoint directly, which is the same question the form engine's server-side
                // checks ask, so it sits in the same category as those rather than with the
                // read-only arithmetic.
                submits ? TestCategory.Security : TestCategory.DataIntegrity,
                $"business-rule-{rule.Id}",
                $"obeys {rule.Id}", says,
                submits
                    ? "The endpoint refuses the submission the rule names, or the step reports what it did with it instead."
                    : "The figures the screen shows satisfy the rule, or the step reports which of its fields the screen does not show.",
                new List<DesignedStep> { open, new(BrowserActionType.AssertBusinessRule, says, Value: rule.Text) },
                TestPriority.High, $"{signedIn}{name} exists at {page.Route}.",
                submits
                    ? "The submission as sent, the status and location the endpoint answered with, and what that reads as; DOM snapshot on failure."
                    : "The rule as written, the figures read off the screen and the arithmetic; DOM snapshot on failure."));
        }

        // A page that prints a table is making arithmetic claims about its own contents, and
        // those are checkable without knowing anything about the business. Emitted only
        // where discovery recorded a table: on a page with none, these steps would pass
        // because there was nothing to check, and a pass that means nothing is worse than
        // an absent test — it reads as coverage.
        if (profile.Includes(TestCategory.DataIntegrity)
            && page.Elements.Any(element => element.Kind == ElementKind.Table))
        {
            tests.Add(Test(TestCategory.DataIntegrity, "totals-add-up", "totals the lines it shows",
                "Every total the page prints equals the sum of the lines above it.",
                "No total differs from the sum of its lines by more than per-line rounding.",
                new List<DesignedStep> { open, new(BrowserActionType.AssertTotalsAddUp, "Confirm each total equals the sum of its lines") },
                TestPriority.High, $"{signedIn}{name} exists at {page.Route} and shows a table.",
                "The stated total, the computed sum and the difference; DOM snapshot on failure."));

            tests.Add(Test(TestCategory.DataIntegrity, "count-matches", "counts the rows it shows",
                "A count the page states matches the rows it renders.",
                "The stated count equals the number of rows shown, or the page says which range it is showing.",
                new List<DesignedStep> { open, new(BrowserActionType.AssertDisplayedCountMatches, "Confirm the stated count matches the rows shown") },
                TestPriority.Medium, $"{signedIn}{name} exists at {page.Route} and shows a table.",
                "The claim as written, the rows counted; DOM snapshot on failure."));

            // The same claim, with a filter applied.
            //
            // The count oracle's own error message names the defect it exists for — "the
            // usual cause is counting before filtering, which leaves the heading and the
            // pager advertising rows the filter has already removed" — and it was only ever
            // pointed at the unfiltered page, where the heading and the rows legitimately
            // disagree because of pagination. So the one arrangement in which the defect is
            // visible was never visited.
            //
            // A filter that matches nothing is the probe, because it needs no knowledge of
            // the data: whatever the collection holds, a search for this token returns none
            // of it, and the page must then say zero rather than go on advertising the
            // whole population.
            var filterField = page.Elements.FirstOrDefault(element =>
                element.Visible
                && element.Kind is ElementKind.TextInput
                && !string.IsNullOrWhiteSpace(element.Name)
                && LooksLikeAFilter(element.Name));

            if (filterField is not null)
            {
                var probe = WithQuery(page.Url, filterField.Name, NoSuchValue);
                tests.Add(Test(TestCategory.DataIntegrity, "count-matches-filtered",
                    $"counts the rows it shows when \"{filterField.Name}\" matches nothing",
                    "A count the page states still matches the rows it renders once a filter has "
                    + "removed them all.",
                    "The page states no rows, or says so in words. It does not go on stating the "
                    + "unfiltered count.",
                    new List<DesignedStep>
                    {
                        new(BrowserActionType.Navigate, $"Open {name} filtered to nothing", Url: probe),
                        new(BrowserActionType.AssertDisplayedCountMatches,
                            "Confirm the stated count matches the rows shown")
                    },
                    TestPriority.Medium,
                    $"{signedIn}{name} exists at {page.Route}, shows a table, and filters from the "
                    + "query string.",
                    "The claim as written, the rows counted; DOM snapshot on failure."));
            }
            else
            {
                gaps.Add(new DesignedGap(TestCategory.DataIntegrity, null,
                    $"{name}: the count under a filter",
                    "Discovery recorded no text filter on this listing, so there is no way from here "
                    + "to put it in the one state where a count computed before filtering shows: the "
                    + "unfiltered page is allowed to state more rows than it renders, because that is "
                    + "what a pager is for.",
                    "Add a test id to the listing's search field, or add a test by hand that applies a "
                    + "filter the application supports and then checks the count.",
                    CoverageGapStatus.PartiallyCovered));
            }

            tests.Add(Test(TestCategory.DataIntegrity, "percentage-lines", "derives each percentage line from a figure above it",
                "A line labelled with a percentage is that percentage of a figure the page has already stated.",
                "Every percentage line matches its rate applied to a figure printed before it.",
                new List<DesignedStep> { open, new(BrowserActionType.AssertPercentageLineConsistent, "Confirm each percentage line derives from a figure above it") },
                TestPriority.High, $"{signedIn}{name} exists at {page.Route} and shows a table.",
                "The line, its rate, the figure it does match and where that figure appears."));
        }

        if (profile.Includes(TestCategory.Responsive))
        {
            foreach (var viewport in profile.Viewports.Skip(1))
            {
                var steps = new List<DesignedStep>
                {
                    new(BrowserActionType.SetViewport, $"Use a {viewport.Name} screen ({viewport.Size})", Value: viewport.Size),
                    open, new(BrowserActionType.AssertNoHorizontalScroll, "Confirm nothing scrolls sideways")
                };
                tests.Add(Test(TestCategory.Responsive, $"viewport:{viewport.Name}", $"fits a {viewport.Name} screen ({viewport.Size})",
                    $"The page is usable at {viewport.Size} without sideways scrolling.", "Nothing on the page makes it scroll sideways.",
                    steps, TestPriority.Medium, $"{signedIn}{name} exists at {page.Route}."));
            }
        }

        return new PageDesign(tests, gaps);
    }

    /// <summary>A value no application's data contains, for filtering a listing to nothing.
    ///
    /// Fixed rather than random, so a failure is reproducible by pasting the URL.</summary>
    private const string NoSuchValue = "qanxt-no-such-value-7f3a";

    /// <summary>Whether a field's name says it narrows a listing.
    ///
    /// Deliberately short. A field that is not a filter produces a URL the application
    /// ignores, the page renders unfiltered, and the check then passes without having
    /// established anything — a pass that means nothing, which reads as coverage.</summary>
    private static bool LooksLikeAFilter(string name)
    {
        var reduced = new string(name.Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        return reduced is "q" or "query" or "search" or "searchterm" or "term" or "filter"
            or "keyword" or "keywords" or "find" or "text" or "name" or "reference" or "ref";
    }

    /// <summary>The page's address with one query parameter set, replacing any already there.</summary>
    private static string WithQuery(string url, string parameter, string value)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return url;

        var pairs = parsed.Query.TrimStart('?')
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(pair => !pair.StartsWith($"{Uri.EscapeDataString(parameter)}=", StringComparison.OrdinalIgnoreCase)
                        && !pair.StartsWith($"{parameter}=", StringComparison.OrdinalIgnoreCase))
            .Append($"{Uri.EscapeDataString(parameter)}={Uri.EscapeDataString(value)}");

        return new UriBuilder(parsed) { Query = string.Join('&', pairs) }.Uri.ToString();
    }

    /// <summary>Up to three things that identify the page: its headings first, then named
    /// navigation, tabs and buttons, leaving out anything that reads like data or a greeting
    /// and anything the sign-in page shows too.</summary>
    private static IReadOnlyList<DesignElement> Landmarks(DesignPage page, IReadOnlySet<string> signInNames)
    {
        static int Rank(ElementKind kind) => kind switch
        {
            ElementKind.Heading => 0, ElementKind.Tab => 1, ElementKind.Navigation => 2, ElementKind.Table => 2,
            ElementKind.Button => 3, ElementKind.Link => 4, _ => 9
        };
        return page.Elements
            .Where(e => e.Visible && Rank(e.Kind) < 9)
            .Where(e => e.Name.Length is >= 3 and <= 60 && !Volatile.IsMatch(e.Name) && !signInNames.Contains(e.Name.Trim()))
            .GroupBy(e => e.Name.Trim(), StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() == 1) // a name used twice on the page cannot be pointed at
            .Select(g => g.First())
            .OrderBy(e => Rank(e.Kind))
            .Take(3)
            .ToList();
    }

    public static string PageName(DesignPage page)
    {
        var title = page.Title.Trim();
        var route = string.IsNullOrWhiteSpace(page.Route) ? "/" : page.Route;
        return string.IsNullOrEmpty(title) ? route : $"{title} ({route})";
    }

    /// <summary>The part of the address the test checks: the path, which survives a query
    /// string or fragment the application adds.</summary>
    private static string UrlFragment(DesignPage page)
        => Uri.TryCreate(page.Url, UriKind.Absolute, out var uri) && uri.AbsolutePath.Length > 1 ? uri.AbsolutePath : page.Route;

    private static string Key(Guid pageId, TestCategory category, string technique)
    {
        var raw = $"page:{pageId:N}|{TestingProfile.CategoryKey(category)}|{technique}";
        return "page:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))[..32].ToLowerInvariant();
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
