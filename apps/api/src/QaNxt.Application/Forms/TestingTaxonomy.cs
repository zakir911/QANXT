using QaNxt.Domain.Enums;

namespace QaNxt.Application.Forms;

/// <summary>What each testing category means, in one place, so the console, the reports and
/// the generator describe it the same way.
///
/// <c>Automation</c> is honest about how much of a category a machine can do: "automated"
/// where the engine decides the verdict, "partial" where it decides part and a person the
/// rest, "human" where only a person can.</summary>
public static class TestingTaxonomy
{
    public sealed record Entry(TestCategory Category, string Name, string Group, string Description, string Automation);

    public static readonly IReadOnlyList<Entry> All = new Entry[]
    {
        new(TestCategory.Smoke, "Smoke", "Functional", "The form renders with its fields and can be submitted.", "automated"),
        new(TestCategory.Functional, "Functional", "Functional", "Valid submissions are accepted: every field, and the required fields alone.", "automated"),
        new(TestCategory.Negative, "Negative", "Functional", "Required fields are enforced: empty, each one alone, whitespace only, cleared after typing.", "automated"),
        new(TestCategory.Validation, "Validation", "Functional", "Declared formats are enforced: email, URL, pattern, step, accepted file types.", "automated"),
        new(TestCategory.Boundary, "Boundary values", "Functional", "Declared limits at min-1, min, min+1, max-1, max, max+1, with zero, negatives and precision. Undeclared limits are reported as unknown, never invented.", "automated"),
        new(TestCategory.Equivalence, "Equivalence partitions", "Functional", "A representative of each valid partition: every option, both states of an optional box, a second valid value.", "automated"),
        new(TestCategory.InputValidation, "Input handling", "Functional", "Spaces, tabs, line breaks, Unicode, emoji, HTML and encoded characters, malformed encoding, very long and null-like input never cause an error.", "automated"),
        new(TestCategory.CrossField, "Cross-field rules", "Functional", "Confirmation fields must match; ranges must be in order — where the relationship is visible in the form.", "partial"),
        new(TestCategory.Dynamic, "Conditional and dynamic fields", "Functional", "Fields appear, disappear and become required with the answers that need them; dependent lists are rebuilt and never keep a stale choice.", "automated"),
        new(TestCategory.MultiStep, "Multi-step forms", "Functional", "Steps refuse to advance when incomplete, advance when complete, keep answers when going back, and enforce the last step.", "partial"),
        new(TestCategory.Workflow, "Workflows", "Functional", "Journeys across forms, from recordings. Business rules beyond the page are verified by a person.", "partial"),
        new(TestCategory.StateTransition, "State transitions", "Functional", "Empty → invalid → valid → submitted, and the form stays usable after reloads and returns.", "automated"),
        new(TestCategory.ErrorHandling, "Error handling", "Reliability", "Errors are reported on the field they concern; network failure is reported to the user.", "automated"),
        new(TestCategory.Recovery, "Recovery", "Reliability", "After an error, correcting and resubmitting works; a refreshed wizard still works.", "automated"),
        new(TestCategory.Reliability, "Reliability and duplicates", "Reliability", "A quick second press, a refresh or the back button never submits twice.", "automated"),
        new(TestCategory.Exploratory, "Exploratory", "Reliability", "Deterministic exploration: session loss before submit, repeated invalid submits, leaving and returning, unusual combinations.", "automated"),
        new(TestCategory.Security, "Security", "Non-functional", "Reflected markup, anti-forgery tokens, password masking; brute force and enumeration need a person; access control is tested by the security engine.", "partial"),
        new(TestCategory.Accessibility, "Accessibility", "Non-functional", "axe-core rules in normal and error states, error association, keyboard order and keyboard submission. Screen-reader experience and focus visibility need a person.", "partial"),
        new(TestCategory.Api, "API", "Non-functional", "The form reaches its endpoint with what was typed, and the server validates, not only the browser.", "automated"),
        new(TestCategory.Performance, "Performance", "Non-functional", "Page load and submission response within budget. Load, stress, spike and endurance testing are outside the browser worker.", "partial"),
        new(TestCategory.Responsive, "Responsive", "Non-functional", "No sideways scrolling and every field shown at each configured viewport.", "automated"),
        new(TestCategory.Compatibility, "Browser compatibility", "Non-functional", "A valid submission in each configured browser; a run in another browser skips the test rather than passing it.", "automated"),
        new(TestCategory.Visual, "Visual", "Non-functional", "The form, its error state and its mobile layout against approved baselines; a difference asks for review.", "automated"),
        new(TestCategory.Usability, "Usability", "Non-functional", "Heuristics read from the structure (placeholder labels, generic actions, missing autocomplete), reported separately from failures, plus a human review.", "partial"),
        new(TestCategory.DataIntegrity, "Data integrity", "Non-functional", "Whether the record stored is the record submitted. QA NXT has no access to the application's database, so this is a person's check unless an API exposes it.", "human"),
        new(TestCategory.Regression, "Regression", "Lifecycle", "Tests made from confirmed defects, kept permanently, plus anything tagged regression.", "automated")
    };
}
