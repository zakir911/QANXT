using Aira.Domain.Agent;
using Aira.Domain.Enums;

namespace Aira.Application.Agent;

/// <summary>Everything the planner is allowed to look at.</summary>
/// <remarks>
/// A record rather than a set of service calls so that planning is a pure function of its
/// inputs. The same application, the same coverage and the same context produce the same plan,
/// every time — which is the only way an operator can argue with one.
/// </remarks>
public sealed record PlanningInputs(
    string Objective,
    int Pages,
    int Endpoints,
    int Journeys,
    int Roles,
    int Forms,
    int UploadWorkflows,
    /// <summary>Gaps, by dimension, from the gap analysis.</summary>
    IReadOnlyDictionary<TestDimension, int> Gaps,
    /// <summary>Tests that already exist, by dimension.</summary>
    IReadOnlyDictionary<TestDimension, int> ExistingTests,
    /// <summary>Areas a person called critical.</summary>
    IReadOnlyList<string> CriticalAreas,
    /// <summary>Areas a person said never to touch.</summary>
    IReadOnlyList<string> ExcludedAreas,
    /// <summary>Whether the application carries an enabled security scope.</summary>
    bool SecurityAuthorized,
    /// <summary>Confirmed findings that came back before, which regression must re-check.</summary>
    int OpenSecurityFindings,
    /// <summary>Tests that failed in the last run.</summary>
    int RecentFailures,
    /// <summary>Average seconds a test of each kind has taken on this application, where known.</summary>
    IReadOnlyDictionary<TestDimension, int> ObservedSecondsPerTest);

public sealed record PlannedCategory(
    AgentPlanCategory Category,
    int TestCount,
    int ToGenerate,
    string Why,
    RiskLevel Risk,
    string Coverage,
    int EstimatedSeconds,
    bool EstimateFromHistory,
    string PotentialImpact);

public sealed record ProposedPlan(
    IReadOnlyList<PlannedCategory> Categories,
    string Summary,
    IReadOnlyList<string> NotCovered)
{
    public int TotalTests => Categories.Sum(c => c.TestCount);
    public int TotalSeconds => Categories.Sum(c => c.EstimatedSeconds);
}

/// <summary>
/// What to test, and why, before anything runs.
/// </summary>
/// <remarks>
/// <para>
/// Deterministic on purpose. Every number below traces to something countable — pages
/// discovered, endpoints discovered, gaps found, findings still open — and every category
/// carries the sentence that put it there. A plan produced by a model would be more fluent and
/// an operator could not tell whether it had reasoned or guessed, which is the wrong trade for
/// the one screen where somebody approves work against a live environment.
/// </para>
/// <para>
/// Two things the planner will not do. It will not propose a category for an area a person
/// excluded, and it will not propose security testing against an application with no
/// authorization — the security engine would refuse it anyway, and a plan that lists work
/// which cannot happen is a plan that overstates its own coverage.
/// </para>
/// </remarks>
public static class AgentPlanModel
{
    /// <summary>
    /// Pessimistic fallbacks, in seconds per test, where this application has no history.
    /// </summary>
    /// <remarks>
    /// Deliberately generous. An estimate that comes in under is a pleasant surprise; one that
    /// comes in over is the reason somebody stops trusting the number and stops reading it.
    /// </remarks>
    private static readonly Dictionary<TestDimension, int> DefaultSecondsPerTest = new()
    {
        [TestDimension.Ui] = 30,
        [TestDimension.Api] = 5,
        [TestDimension.Security] = 20,
        [TestDimension.Accessibility] = 15,
        [TestDimension.Visual] = 20
    };

    public static ProposedPlan Build(PlanningInputs inputs)
    {
        var categories = new List<PlannedCategory>();
        var notCovered = new List<string>();

        var uiGaps = inputs.Gaps.GetValueOrDefault(TestDimension.Ui);
        var apiGaps = inputs.Gaps.GetValueOrDefault(TestDimension.Api);

        // ---- Smoke -----------------------------------------------------------
        // One per page, always. The cheapest thing that distinguishes "the application is up
        // and broadly working" from "everything failed and we spent an hour finding out why".
        if (inputs.Pages > 0)
            categories.Add(Category(
                AgentPlanCategory.Smoke, inputs.Pages, Math.Max(0, inputs.Pages - inputs.ExistingTests.GetValueOrDefault(TestDimension.Ui)),
                $"One reachability check per discovered page ({inputs.Pages}). Cheap, and it "
                + "separates an application that is down from a suite that is broken.",
                RiskLevel.Low, $"{inputs.Pages} page(s) reachable and rendering",
                TestDimension.Ui, inputs.Pages, inputs,
                "Read-only navigation. Nothing is submitted."));

        // ---- Critical journeys -----------------------------------------------
        //
        // A person naming what matters is enough on its own. Journeys are recorded by the
        // recorder and by generation, not by discovery, so a freshly crawled application has
        // none — and the first version of this only proposed journey tests when some were
        // already stored. An operator could write "payment is critical", watch the plan come
        // back with no journey category at all, and have no way to tell that their instruction
        // had gone nowhere. Found by a golden test against a freshly discovered lab.
        if (inputs.Journeys > 0 || inputs.CriticalAreas.Count > 0)
        {
            var fromAPerson = inputs.CriticalAreas.Count > 0;
            var critical = fromAPerson
                ? Math.Max(inputs.CriticalAreas.Count, Math.Min(inputs.Journeys, 8))
                : Math.Min(inputs.Journeys, 8);

            var why = (fromAPerson, inputs.Journeys) switch
            {
                (true, 0) =>
                    $"No journey has been recorded for this application yet, and a person named "
                    + $"{inputs.CriticalAreas.Count} area(s) as business-critical: "
                    + $"{string.Join(", ", inputs.CriticalAreas.Take(5))}. These are covered "
                    + "from what discovery walked, which is weaker than a recorded journey and "
                    + "better than ignoring what somebody told us matters.",
                (true, _) =>
                    $"{inputs.Journeys} journey(s) known, and a person named "
                    + $"{inputs.CriticalAreas.Count} area(s) as business-critical: "
                    + $"{string.Join(", ", inputs.CriticalAreas.Take(5))}.",
                _ =>
                    $"{inputs.Journeys} journey(s) known. Nobody has said which matter most, so "
                    + "the most connected ones are covered and this is a guess rather than a "
                    + "priority."
            };

            categories.Add(Category(
                AgentPlanCategory.CriticalJourney, critical * 2, critical,
                why,
                fromAPerson ? RiskLevel.Critical : RiskLevel.High,
                inputs.Journeys == 0
                    ? $"{critical} area(s) a person named, happy path and one failure path each"
                    : $"{critical} journey(s), happy path and one failure path each",
                TestDimension.Ui, critical * 2, inputs,
                "Drives real forms. Creates records in the environment under test."));

            if (inputs.Journeys == 0)
                notCovered.Add(
                    "No journey has been recorded for this application, so nothing here follows "
                    + "a path a real user was seen to take. The journey tests are assembled from "
                    + "pages discovery walked.");
        }
        else
        {
            notCovered.Add(
                "Business journeys. None are recorded and nobody has named any, so this plan "
                + "covers pages and endpoints rather than the things people use the application "
                + "to do.");
        }

        // ---- API --------------------------------------------------------------
        if (inputs.Endpoints > 0)
            categories.Add(Category(
                AgentPlanCategory.Api, inputs.Endpoints, apiGaps,
                $"{inputs.Endpoints} endpoint(s) discovered, {apiGaps} with no API test. "
                + "An endpoint the UI happens to exercise is not an endpoint that is tested.",
                RiskLevel.High, $"{inputs.Endpoints} endpoint(s): status, shape and contract",
                TestDimension.Api, inputs.Endpoints, inputs,
                "Issues requests directly. State-changing verbs are exercised where the "
                + "contract declares them."));

        // ---- Security ----------------------------------------------------------
        if (inputs.SecurityAuthorized)
        {
            var securityTests = EstimateSecurityChecks(inputs);
            categories.Add(Category(
                AgentPlanCategory.Security, securityTests, 0,
                $"The application carries an enabled security scope. {inputs.Forms} form(s), "
                + $"{inputs.UploadWorkflows} upload workflow(s), {inputs.Roles} role(s) and "
                + $"{inputs.Endpoints} endpoint(s) imply {securityTests} check(s).",
                RiskLevel.High, $"{securityTests} check(s) within the authorized scope",
                TestDimension.Security, securityTests, inputs,
                "Sends crafted requests within the scope. Destructive checks are excluded "
                + "unless separately authorized."));

            if (inputs.OpenSecurityFindings > 0)
                categories.Add(Category(
                    AgentPlanCategory.Regression, inputs.OpenSecurityFindings, 0,
                    $"{inputs.OpenSecurityFindings} security finding(s) are open on this "
                    + "application. A finding that was fixed and comes back is a regression, "
                    + "and it is the cheapest serious thing to catch.",
                    RiskLevel.Critical, "Re-checks every open finding",
                    TestDimension.Security, inputs.OpenSecurityFindings, inputs,
                    "Repeats the request that established each finding."));
        }
        else
        {
            // Named rather than silently dropped. A plan with no security row reads as an
            // application with no security concerns.
            notCovered.Add(
                "Security testing. This application has no enabled security scope, so nothing "
                + "may be scanned. That is an absence of authorization, not an absence of risk.");
        }

        // ---- Accessibility and visual -------------------------------------------
        if (inputs.Pages > 0)
        {
            var a11yGaps = inputs.Gaps.GetValueOrDefault(TestDimension.Accessibility);
            categories.Add(Category(
                AgentPlanCategory.Accessibility, Math.Min(inputs.Pages, 20), a11yGaps,
                $"{a11yGaps} page(s) have no accessibility check. Automated checks find a "
                + "minority of real barriers and are worth running for that minority.",
                RiskLevel.Medium, $"{Math.Min(inputs.Pages, 20)} page(s), axe-core rules",
                TestDimension.Accessibility, Math.Min(inputs.Pages, 20), inputs,
                "Read-only inspection of the rendered page."));

            categories.Add(Category(
                AgentPlanCategory.Visual, Math.Min(inputs.Pages, 10), 0,
                "Baselines for the most connected pages, so an unintended visual change has "
                + "something to be different from.",
                RiskLevel.Low, $"{Math.Min(inputs.Pages, 10)} page(s) baselined",
                TestDimension.Visual, Math.Min(inputs.Pages, 10), inputs,
                "Screenshots only. A first run establishes baselines rather than failing."));
        }

        // ---- Regression ----------------------------------------------------------
        if (inputs.RecentFailures > 0)
            categories.Add(Category(
                AgentPlanCategory.Regression, inputs.RecentFailures, 0,
                $"{inputs.RecentFailures} test(s) failed in the last run. Re-running them is "
                + "how a fix is confirmed and how a flake is told from a defect.",
                RiskLevel.High, $"{inputs.RecentFailures} previously failing test(s)",
                TestDimension.Ui, inputs.RecentFailures, inputs,
                "Repeats what already ran."));

        // ---- What this does not cover ---------------------------------------------
        if (inputs.ExcludedAreas.Count > 0)
            notCovered.Add(
                $"{inputs.ExcludedAreas.Count} area(s) a person excluded: "
                + $"{string.Join(", ", inputs.ExcludedAreas.Take(10))}. Nothing in this plan "
                + "touches them.");

        notCovered.Add(
            "Anything discovery did not reach. The plan is drawn from the application map, and "
            + "an application is larger than its crawl.");

        if (inputs.Roles > 1)
            notCovered.Add(
                $"{inputs.Roles} role(s) are known, and cross-role authorization is only covered "
                + "where the security scope permits testing it.");

        return new ProposedPlan(categories, Summarise(inputs, categories, notCovered), notCovered);
    }

    /// <summary>
    /// How many security checks the surface implies.
    /// </summary>
    /// <remarks>
    /// A deliberately rough count: the security engine derives the real set from its own
    /// attack-surface model, and this is only here so the plan can say roughly how much work
    /// it is proposing. It is labelled an estimate wherever it is shown.
    /// </remarks>
    private static int EstimateSecurityChecks(PlanningInputs inputs)
        => Math.Max(1,
            inputs.Pages * 3                    // headers, cookies, sensitive data per page
            + inputs.Forms * 2                  // reflected and stored input handling
            + inputs.Endpoints * 2              // authorization and data exposure per endpoint
            + inputs.UploadWorkflows * 2        // upload handling
            + (inputs.Roles > 1 ? inputs.Roles : 0));

    private static PlannedCategory Category(
        AgentPlanCategory category, int testCount, int toGenerate, string why, RiskLevel risk,
        string coverage, TestDimension dimension, int testsForEstimate, PlanningInputs inputs,
        string impact)
    {
        var observed = inputs.ObservedSecondsPerTest.GetValueOrDefault(dimension);
        var fromHistory = observed > 0;
        var perTest = fromHistory ? observed : DefaultSecondsPerTest.GetValueOrDefault(dimension, 30);

        return new PlannedCategory(
            category, testCount, toGenerate, why, risk, coverage,
            testsForEstimate * perTest, fromHistory, impact);
    }

    private static string Summarise(
        PlanningInputs inputs, IReadOnlyList<PlannedCategory> categories,
        IReadOnlyList<string> notCovered)
    {
        var total = categories.Sum(c => c.TestCount);
        var generate = categories.Sum(c => c.ToGenerate);
        var minutes = Math.Max(1, (int)Math.Round(categories.Sum(c => c.EstimatedSeconds) / 60.0));
        var anyHistory = categories.Any(c => c.EstimateFromHistory);

        return
            $"{total} test(s) across {categories.Count} category(ies) for \"{inputs.Objective}\", "
            + $"{generate} of which do not exist yet. Roughly {minutes} minute(s) — an estimate "
            + (anyHistory
                ? "from how long these tests have taken on this application before."
                : "from defaults, because this application has no execution history yet.")
            + $" {notCovered.Count} area(s) are explicitly not covered; they are listed rather "
            + "than left to be inferred from absence.";
    }
}
