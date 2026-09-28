using QaNxt.Domain.Enums;

namespace QaNxt.Application.Agent;

/// <summary>What an exploratory pass is allowed to do.</summary>
/// <remarks>
/// Every field is a ceiling rather than a target. Exploration is the one part of the agent
/// that has no plan to work to — that is the point of it — so the only thing keeping it from
/// running until the budget is gone is this.
/// </remarks>
public sealed record ExploratoryBounds(
    int MaxPages,
    int MaxActions,
    int MaxMinutes,
    int MaxCandidateJourneys,
    int MaxCandidateTests,
    /// <summary>Whether anything may be submitted. Off means look, do not touch.</summary>
    bool MaySubmitForms,
    /// <summary>Whether anything irreversible may be attempted. Never true by default.</summary>
    bool MayBeDestructive)
{
    public static ExploratoryBounds Default { get; } = new(
        MaxPages: 25, MaxActions: 150, MaxMinutes: 10,
        MaxCandidateJourneys: 10, MaxCandidateTests: 20,
        MaySubmitForms: false, MayBeDestructive: false);
}

/// <summary>Something exploration found.</summary>
public sealed record ExploratoryObservation(
    string Kind,
    string Where,
    string What,
    /// <summary>How well established this is. Exploration produces inferences by default.</summary>
    Domain.Agent.ApplicationMemoryProvenance Provenance);

public sealed record ExploratoryReport(
    int PagesExplored,
    int FormsExplored,
    int ApisObserved,
    IReadOnlyList<ExploratoryObservation> Observations,
    IReadOnlyList<string> CandidateJourneys,
    IReadOnlyList<string> CandidateTests,
    IReadOnlyList<string> PotentialDefects,
    IReadOnlyList<string> PotentialSecurityIssues,
    IReadOnlyList<string> NotExplored,
    string Summary,
    /// <summary>Which bound stopped it, if one did.</summary>
    string? StoppedBy);

/// <summary>
/// What an exploratory pass may do, and how its findings must be described.
/// </summary>
/// <remarks>
/// <para>
/// Exploration is where an autonomous agent is most useful and most dangerous. Useful because
/// it reaches what the existing tests do not; dangerous because it is the one mode with no
/// plan, acting on an application nobody is watching it touch.
/// </para>
/// <para>
/// Two rules carry the weight. <strong>Nothing exploration produces is a fact.</strong> A form
/// that looks like registration is an inference, and it is recorded as one — a candidate
/// journey, not a journey; a potential defect, not a defect. Every one of them is a proposal
/// for a person, and a candidate that no person has approved never enters the permanent
/// regression suite.
/// </para>
/// <para>
/// <strong>What it did not reach is part of the report.</strong> An exploration that stopped
/// at its page limit and says "explored 25 pages" reads as thorough. The same report saying it
/// stopped at 25 of an unknown number reads accurately, and the difference decides whether
/// somebody runs it again.
/// </para>
/// </remarks>
public static class ExploratoryModel
{
    /// <summary>
    /// Whether an action is one exploration may take.
    /// </summary>
    /// <remarks>
    /// A closed list rather than a set of things it may not do. An agent exploring an
    /// application it has never seen will find controls nobody anticipated, and a deny-list
    /// only covers what somebody thought of in advance.
    /// </remarks>
    public static bool Permits(ExploratoryBounds bounds, BrowserActionType action)
        => action switch
        {
            BrowserActionType.Navigate => true,
            BrowserActionType.Click => true,
            BrowserActionType.Hover => true,
            BrowserActionType.Scroll => true,
            BrowserActionType.Screenshot => true,
            BrowserActionType.Wait => true,
            BrowserActionType.Fill => bounds.MaySubmitForms,
            BrowserActionType.Select => bounds.MaySubmitForms,
            BrowserActionType.Check => bounds.MaySubmitForms,
            BrowserActionType.Press => bounds.MaySubmitForms,
            BrowserActionType.Upload => bounds.MaySubmitForms && bounds.MayBeDestructive,
            _ => false
        };

    /// <summary>
    /// Assembles the report, including the part about what was not reached.
    /// </summary>
    /// <remarks>
    /// <paramref name="pagesKnown"/> is what discovery had already found. When exploration
    /// stopped short of it, the report says how far short — the difference between "explored
    /// 25 pages" and "explored 25 of 60" is the difference between a reader believing the
    /// application has been walked and knowing it has not.
    /// </remarks>
    public static ExploratoryReport Report(
        ExploratoryBounds bounds,
        int pagesExplored, int pagesKnown, int formsExplored, int apisObserved,
        IReadOnlyList<ExploratoryObservation> observations,
        IReadOnlyList<string> candidateJourneys,
        IReadOnlyList<string> candidateTests,
        IReadOnlyList<string> potentialDefects,
        IReadOnlyList<string> potentialSecurityIssues,
        string? stoppedBy)
    {
        var notExplored = new List<string>();

        if (pagesKnown > pagesExplored)
            notExplored.Add(
                $"{pagesKnown - pagesExplored} page(s) discovery already knows about were not "
                + $"reached in this exploration ({pagesExplored} of {pagesKnown}).");

        if (!bounds.MaySubmitForms)
            notExplored.Add(
                "No form was submitted. What happens after a form is filled in is untested by "
                + "this exploration, which is where most of an application's behaviour lives.");

        if (!bounds.MayBeDestructive)
            notExplored.Add(
                "Nothing irreversible was attempted, so deletion, cancellation and anything "
                + "else that cannot be undone is unexplored.");

        notExplored.Add(
            "Anything behind a control exploration did not happen to click. Exploration walks; "
            + "it does not enumerate.");

        var summary =
            $"Explored {pagesExplored} page(s)"
            + (pagesKnown > 0 ? $" of {pagesKnown} known" : "")
            + $", {formsExplored} form(s), {apisObserved} API call(s) observed. "
            + $"{candidateJourneys.Count} candidate journey(s) and {candidateTests.Count} "
            + $"candidate test(s) were proposed, {potentialDefects.Count} potential defect(s) "
            + $"and {potentialSecurityIssues.Count} potential security issue(s) noted. "
            + "Everything here is a proposal: a candidate journey is not a journey, and a "
            + "potential defect is not a defect until somebody has looked."
            + (stoppedBy is null ? "" : $" Exploration stopped because {stoppedBy}.");

        return new ExploratoryReport(
            pagesExplored, formsExplored, apisObserved,
            observations, candidateJourneys, candidateTests,
            potentialDefects, potentialSecurityIssues, notExplored, summary, stoppedBy);
    }
}
