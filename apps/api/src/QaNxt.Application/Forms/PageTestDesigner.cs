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
    TestingProfile Profile);

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
