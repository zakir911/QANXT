using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Forms;

// ---- What the designer produces -------------------------------------------------------

public sealed record DesignedStep(
    BrowserActionType Action,
    string Description,
    LocatorDescriptor? Target = null,
    string? Value = null,
    string? Url = null,
    string? Expected = null,
    string? Attribute = null,
    int? Count = null,
    /// <summary>A planned assertion attached to the step, beyond the verb's own check.</summary>
    AssertionType? ExtraAssertion = null,
    string? ExtraExpected = null,
    bool ExtraNegate = false);

public sealed record DesignedTest
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    public required TestCategory Category { get; init; }
    public required string Technique { get; init; }
    public TestPriority Priority { get; init; } = TestPriority.Medium;
    public RiskLevel Risk { get; init; } = RiskLevel.Medium;
    public string Objective { get; init; } = string.Empty;
    public string Preconditions { get; init; } = "None.";
    public string Expected { get; init; } = string.Empty;
    public string? FieldKey { get; init; }
    public required IReadOnlyList<DesignedStep> Steps { get; init; }
    public IReadOnlyList<string> CoverageKeys { get; init; } = Array.Empty<string>();
    public IReadOnlyDictionary<string, string> TestData { get; init; } = new Dictionary<string, string>();
    public string EvidenceRequirements { get; init; } = "Screenshot on failure, network log, console log.";
    public IReadOnlyList<string> Tags { get; init; } = Array.Empty<string>();
}

public sealed record DesignedGap(
    TestCategory Category, string? FieldKey, string Missing, string Reason, string Action, CoverageGapStatus Status);

public sealed record DesignedHumanTask(
    string Key, TestCategory Category, string Title, string Reason, string Steps, string Expected);

public sealed record DesignedFinding(
    FormFindingKind Kind, string Code, string? FieldKey, string Message, string Severity);

/// <summary>Everything one form's analysis produced, and which categories apply to it at all.
/// A category that does not apply (no wizard, no dependencies) is N/A and must not count
/// against the form's score; a category that applies and could not be tested is a gap.</summary>
public sealed record FormDesign(
    IReadOnlyList<DesignedTest> Tests,
    IReadOnlyList<DesignedGap> Gaps,
    IReadOnlyList<DesignedHumanTask> HumanTasks,
    IReadOnlyList<DesignedFinding> Findings,
    IReadOnlySet<TestCategory> Applicable);

/// <summary>An API call discovery saw this form's page make.</summary>
public sealed record CorrelatedEndpoint(string Method, string Path);

public sealed record FormDesignContext(
    Guid FormId,
    DiscoveredFormModel Form,
    string PageUrl,
    string Route,
    string FormName,
    bool HasCredentials,
    IReadOnlyList<CorrelatedEndpoint> Endpoints,
    TestingProfile Profile);

/// <summary>Designs a form's test suite from what discovery observed about it.
///
/// Deterministic: the same form and profile always produce the same tests, with the same
/// keys, in the same order. No model is involved and nothing is invented — every test
/// traces to a field, a declared constraint, an observed dependency or a property of the
/// form, and every coverage key a test carries names that thing.
///
/// What it cannot do it says: a field whose limits are not declared gets an "unknown
/// boundary" gap rather than an invented limit, a pattern it cannot satisfy is a gap, a
/// rule only a server knows is a gap, and a judgement only a person can make is a human
/// verification task. There is no cap on the number of tests; the form decides it.</summary>
public static class FormTestDesigner
{
    private const string Omit = "\u0000omit";

    public static FormDesign Design(FormDesignContext ctx)
    {
        var design = new Builder(ctx);
        design.Run();
        return design.Result();
    }

    private sealed class Builder
    {
        private readonly FormDesignContext _ctx;
        private readonly DiscoveredFormModel _form;
        private readonly TestingProfile _profile;
        private readonly List<DesignedTest> _tests = new();
        private readonly List<DesignedGap> _gaps = new();
        private readonly List<DesignedHumanTask> _human = new();
        private readonly List<DesignedFinding> _findings = new();
        private readonly HashSet<TestCategory> _applicable = new();
        private readonly HashSet<string> _keys = new(StringComparer.Ordinal);

        private readonly List<FormFieldModel> _fields;
        private readonly FormButtonModel? _submit;
        private readonly FormButtonModel? _next;
        private readonly FormButtonModel? _previous;
        private readonly bool _transactional;
        private readonly bool _credentialForm;

        public Builder(FormDesignContext ctx)
        {
            _ctx = ctx;
            _form = ctx.Form;
            _profile = ctx.Profile;
            // A radio group's locator names every option in it; anything that targets the group
            // as one field (an assertion, a focus check) targets its first option.
            _fields = _form.Fields.Where(f => !f.ReadOnly && !f.Disabled)
                .Select(f => f.ControlType == "radio" && f.Locator.Nth is null ? f with { Locator = f.Locator with { Nth = 0 } } : f)
                .ToList();
            _submit = _form.Buttons.FirstOrDefault(b => b.Role == "submit")
                   ?? _form.Buttons.FirstOrDefault(b => b.Role == "other" && b.Visible)
                   // A one-page form's "Continue" is its submit control, whatever an older
                   // discovery labelled it.
                   ?? (_form.IsMultiStep ? null : _form.Buttons.FirstOrDefault(b => b.Role == "next" && b.Type == "submit"));
            _next = _form.Buttons.FirstOrDefault(b => b.Role == "next");
            _previous = _form.Buttons.FirstOrDefault(b => b.Role == "previous");
            _transactional = !string.Equals(_form.Method, "get", StringComparison.OrdinalIgnoreCase) || !_form.HasFormElement || _form.Action is null;
            var passwords = _fields.Count(f => f.ControlType == "password");
            _credentialForm = passwords == 1 && _fields.Count <= 3
                && (_fields.Any(f => f.Autocomplete is "current-password") || _fields.Any(f => Mentions(f, "user", "login", "email")));
        }

        public FormDesign Result() => new(_tests, _gaps, _human, _findings, _applicable);

        /// <summary>Whether a submission can be expected to succeed. Not for a sign-in form
        /// with no credentials configured: there is no valid submission to make.</summary>
        private bool CanSucceed => !_credentialForm || _ctx.HasCredentials;

        public void Run()
        {
            if (_submit is null)
            {
                _gaps.Add(new DesignedGap(TestCategory.Functional, null, "a control that submits the form",
                    "Discovery found no submit control for this form, so nothing can be submitted.",
                    "Check the form in the browser; if it submits on change or through a control outside it, add a test by hand.",
                    CoverageGapStatus.NotCovered));
                _applicable.Add(TestCategory.Functional);
            }

            Smoke();
            Functional();
            Required();
            Validation();
            Boundary();
            Equivalence();
            InputValidation();
            CrossField();
            Dynamic();
            MultiStep();
            Reliability();
            ErrorHandlingAndRecovery();
            StateTransition();
            Security();
            Accessibility();
            Api();
            Performance();
            Responsive();
            Compatibility();
            Visual();
            Exploratory();
            Usability();
            DataIntegrityAndWorkflow();
        }

        // ---- Infrastructure ------------------------------------------------------------

        private bool Wanted(TestCategory category)
        {
            if (!_profile.Includes(category)) return false;
            _applicable.Add(category);
            return true;
        }

        private void Add(DesignedTest test)
        {
            if (!_keys.Add(test.Key)) return;
            _tests.Add(test);
        }

        private string Key(TestCategory category, string technique, string? field = null)
            => $"form:{_ctx.FormId:N}|{TestingProfile.CategoryKey(category)}|{technique}" + (field is null ? string.Empty : $"|{field}");

        private string Title => _ctx.FormName;

        private DesignedTest Test(TestCategory category, string technique, string name, string objective, string expected,
            IReadOnlyList<DesignedStep> steps, string? field = null, TestPriority priority = TestPriority.Medium,
            IEnumerable<string>? coverage = null, IReadOnlyDictionary<string, string>? data = null, string? evidence = null)
        {
            var keys = new List<string> { $"form:{_ctx.FormId:N}", $"category:{TestingProfile.CategoryKey(category)}" };
            if (field is not null) keys.Add($"field:{_ctx.FormId:N}/{field}");
            if (coverage is not null) keys.AddRange(coverage);
            return new DesignedTest
            {
                Key = Key(category, technique, field),
                Name = Truncate($"{Title}: {name}", 300),
                Category = category,
                Technique = technique,
                Priority = priority,
                Risk = priority switch
                {
                    TestPriority.Critical => RiskLevel.Critical, TestPriority.High => RiskLevel.High,
                    TestPriority.Low => RiskLevel.Low, _ => RiskLevel.Medium
                },
                Objective = objective,
                Preconditions = $"{Title} is reachable at {_ctx.Route}.",
                Expected = expected,
                FieldKey = field,
                Steps = steps,
                CoverageKeys = keys.Distinct().ToList(),
                TestData = data ?? new Dictionary<string, string>(),
                EvidenceRequirements = evidence ?? "Screenshot on failure, network log, console log, DOM snapshot on failure.",
                Tags = new[] { "form", Slug(_ctx.Route), TestingProfile.CategoryKey(category) }
            };
        }

        private void Gap(TestCategory category, string? field, string missing, string reason, string action,
            CoverageGapStatus status = CoverageGapStatus.NotCovered)
        {
            if (_gaps.Any(g => g.Category == category && g.FieldKey == field && g.Missing == missing)) return;
            _gaps.Add(new DesignedGap(category, field, missing, reason, action, status));
        }

        private void Human(TestCategory category, string technique, string title, string reason, string steps, string expected)
            => _human.Add(new DesignedHumanTask(Key(category, technique), category, Truncate($"{Title}: {title}", 300), reason, steps, expected));

        private DesignedStep Open() => new(BrowserActionType.Navigate, $"Open {Title}", Url: _ctx.PageUrl);
        private DesignedStep SubmitStep(string? value = null) => new(BrowserActionType.Click,
            value is null ? $"Press \"{_submit!.Label}\"" : $"Press \"{_submit!.Label}\" repeatedly", _submit!.Locator, Value: value);
        private DesignedStep Rejected(string why) => new(BrowserActionType.AssertFormRejected, why, _form.Locator);
        private DesignedStep Accepted(string why) => new(BrowserActionType.AssertFormAccepted, why, _form.Locator);
        private DesignedStep NoServerError() => new(BrowserActionType.AssertNoServerError, "Confirm the application handled it without a server error or leaked detail");

        private static bool Mentions(FormFieldModel field, params string[] terms)
        {
            var haystack = $"{field.Name} {field.Label} {field.AccessibleName} {field.Placeholder} {field.ElementId} {field.Autocomplete}".ToLowerInvariant();
            return terms.Any(t => haystack.Contains(t, StringComparison.Ordinal));
        }

        private bool IsStepHidden(FormFieldModel field) => _form.IsMultiStep && field.Group != _form.VisibleGroup;
        private bool IsConditional(FormFieldModel field) => !field.Visible && !IsStepHidden(field);

        // ---- Filling a form validly -----------------------------------------------------

        private sealed record Fill(List<DesignedStep> Steps, Dictionary<string, string> Data, string? Failure);

        /// <summary>The steps that fill the form with values it should accept, field by field,
        /// step by step for a wizard. <paramref name="overrides"/> replaces a field's value
        /// (<see cref="Omit"/> leaves it untouched); <paramref name="reveal"/> forces a trigger
        /// value so a conditional field appears. Optional fields are filled only when
        /// <paramref name="includeOptional"/> says so.</summary>
        private Fill FillValid(IReadOnlyDictionary<string, string>? overrides = null, bool includeOptional = true,
            int throughGroup = int.MaxValue, bool clickNextAfterLastGroup = false)
        {
            overrides ??= new Dictionary<string, string>();
            // A value given for a conditional field means that field has to be shown first:
            // its trigger is set to the answer the probe saw reveal it. Without this a test
            // of the referral code typed nothing, because the field it meant was hidden.
            var withTriggers = new Dictionary<string, string>(overrides, StringComparer.Ordinal);
            foreach (var (key, value) in overrides)
            {
                if (value == Omit) continue;
                var conditional = _fields.FirstOrDefault(f => f.Identity == key);
                if (conditional is null || !IsConditional(conditional)) continue;
                var reveal = _form.Dependencies.FirstOrDefault(d => d.Shows.Contains(key));
                if (reveal is not null && !withTriggers.ContainsKey(reveal.Trigger)) withTriggers[reveal.Trigger] = reveal.TriggerValue;
            }
            overrides = withTriggers;
            var steps = new List<DesignedStep>();
            var data = new Dictionary<string, string>(StringComparer.Ordinal);
            var revealed = new HashSet<string>(StringComparer.Ordinal);
            var groups = _form.IsMultiStep ? _fields.Select(f => f.Group).Distinct().OrderBy(g => g).ToList() : new List<int> { 0 };

            foreach (var group in groups)
            {
                if (group > throughGroup) break;
                foreach (var field in _fields.Where(f => !_form.IsMultiStep || f.Group == group))
                {
                    if (IsConditional(field) && !revealed.Contains(field.Identity)) continue;
                    var hasOverride = overrides.TryGetValue(field.Identity, out var forced);
                    if (hasOverride && forced == Omit) continue;

                    var optional = !field.Required;
                    if (!hasOverride && optional && !includeOptional) continue;
                    if (!hasOverride && field.ControlType is "checkbox" or "switch" && optional) continue;

                    string? value = forced;
                    if (!hasOverride)
                    {
                        var synthesis = SynthesiseFor(field, revealed, data);
                        if (!synthesis.Ok)
                        {
                            if (optional) continue;
                            return new Fill(steps, data, $"{field.DisplayName}: {synthesis.Reason}");
                        }
                        value = synthesis.Value;
                    }

                    steps.Add(SetStep(field, value!));
                    data[field.Identity] = value!;
                    foreach (var dependency in _form.Dependencies.Where(d => d.Trigger == field.Identity && d.TriggerValue == TriggerValueOf(field, value!)))
                        foreach (var shown in dependency.Shows) revealed.Add(shown);
                }

                var isLast = group == groups.Last() || group == throughGroup;
                if (_form.IsMultiStep && _next is not null && (!isLast || clickNextAfterLastGroup) && group < groups.Last())
                    steps.Add(new DesignedStep(BrowserActionType.Click, $"Press \"{_next.Label}\"", _next.Locator));
            }
            return new Fill(steps, data, null);
        }

        private static string TriggerValueOf(FormFieldModel field, string value)
            => field.ControlType is "checkbox" or "switch" ? (value == "off" ? "off" : "on") : value;

        private ValueSynthesizer.Synthesis SynthesiseFor(FormFieldModel field, HashSet<string> revealed, Dictionary<string, string> chosen)
        {
            // A sign-in form is filled with the application's configured credentials. Without
            // them it is filled with credentials that cannot be valid, which is enough for
            // every test that expects a refusal; tests that expect acceptance check
            // CanSucceed and are not generated.
            if (_credentialForm && field.ControlType == "password")
                return ValueSynthesizer.Synthesis.Of(_ctx.HasCredentials ? "${secret:app_password}" : "Not-the-Passw0rd!");
            if (_credentialForm && field.ControlType != "password" && field.Required && ValueSynthesizer.IsTextLike(field))
                return ValueSynthesizer.Synthesis.Of(_ctx.HasCredentials ? "${secret:app_username}" : "qa-nxt-unknown-user");

            switch (field.ControlType)
            {
                case "select":
                case "multiselect":
                {
                    // A select repopulated by another field takes its options from what the
                    // probe saw for the value that field was given.
                    var parent = _form.Dependencies.FirstOrDefault(d => d.OptionsOf.ContainsKey(field.Identity)
                        && chosen.TryGetValue(d.Trigger, out var parentValue) && parentValue == d.TriggerValue);
                    var options = parent is not null
                        ? parent.OptionsOf[field.Identity].Where(o => !IsPlaceholderLabel(o)).ToList()
                        : field.Options.Where(o => !o.Disabled && o.Value.Length > 0).Select(o => o.Value).ToList();
                    return options.Count > 0 ? ValueSynthesizer.Synthesis.Of(options[0])
                        : ValueSynthesizer.Synthesis.Cannot("It has no option with a value to choose.");
                }
                case "radio":
                {
                    var option = field.Options.FirstOrDefault(o => !o.Disabled);
                    return option is not null ? ValueSynthesizer.Synthesis.Of(option.Value) : ValueSynthesizer.Synthesis.Cannot("It has no option.");
                }
                case "checkbox":
                case "switch":
                    return ValueSynthesizer.Synthesis.Of("on");
                case "file":
                    return ValueSynthesizer.ValidUpload(field);
                case "range":
                    return ValueSynthesizer.Synthesis.Cannot("A slider cannot be typed into.");
                default:
                    return ValueSynthesizer.Valid(field);
            }
        }

        private static bool IsPlaceholderLabel(string label)
            => label.Length == 0 || Regex.IsMatch(label, @"^(choose|select|please|--|—|\.\.\.|…)", RegexOptions.IgnoreCase);

        /// <summary>The step that puts a value into a field, in whatever way the control takes one.</summary>
        private DesignedStep SetStep(FormFieldModel field, string value) => field.ControlType switch
        {
            "select" or "multiselect" => new(BrowserActionType.Select, $"Choose \"{value}\" in {field.DisplayName}", field.Locator, value),
            "radio" => new(BrowserActionType.Check, $"Choose \"{value}\" in {field.DisplayName}", RadioOption(field, value)),
            "checkbox" or "switch" => value == "off"
                ? new(BrowserActionType.Uncheck, $"Clear {field.DisplayName}", field.Locator)
                : new(BrowserActionType.Check, $"Tick {field.DisplayName}", field.Locator),
            "file" => new(BrowserActionType.Upload, $"Attach a generated file to {field.DisplayName}", field.Locator, value),
            _ => new(BrowserActionType.Fill, $"Enter {Describe(value)} in {field.DisplayName}", field.Locator, value)
        };

        private static LocatorDescriptor RadioOption(FormFieldModel field, string value)
            => new() { Strategy = LocatorStrategy.Css, Value = $"{field.Locator.Value}[value=\"{value.Replace("\"", "\\\"")}\"]" };

        private static string Describe(string value)
        {
            if (value.StartsWith("${secret:", StringComparison.Ordinal)) return "the configured credential";
            if (value.Length > 40) return $"a {value.Length}-character value";
            if (value.Length == 0) return "nothing";
            if (value.Trim().Length == 0) return $"{value.Length} space(s)";
            return $"\"{value}\"";
        }

        // ---- Smoke and functional -------------------------------------------------------

        private void Smoke()
        {
            if (!Wanted(TestCategory.Smoke)) return;
            var steps = new List<DesignedStep> { Open() };
            foreach (var field in _fields.Where(f => f.Visible && f.ControlType != "radio"))
                steps.Add(new(BrowserActionType.AssertVisible, $"Confirm {field.DisplayName} is shown", field.Locator));
            if (_submit is not null && _submit.Visible)
                steps.Add(new(BrowserActionType.AssertEnabled, $"Confirm \"{_submit.Label}\" can be pressed", _submit.Locator));
            if (steps.Count == 1) steps.Add(new(BrowserActionType.AssertVisible, "Confirm the form is shown", _form.Locator));
            Add(Test(TestCategory.Smoke, "renders", "renders with its fields and an enabled submit control",
                "Every field discovery found is shown and the form can be submitted.",
                "All fields are visible and the submit control is enabled.", steps, priority: TestPriority.High));
        }

        private void Functional()
        {
            if (_submit is null || !Wanted(TestCategory.Functional)) return;
            var full = FillValid();
            if (!CanSucceed)
            {
                Gap(TestCategory.Functional, null, "a successful sign-in",
                    "This is a sign-in form and the application has no credentials configured in QA NXT, so a valid submission cannot be made.",
                    "Configure the application's credentials, then generate again.", CoverageGapStatus.HumanRequired);
                Human(TestCategory.Functional, "credential-sign-in", "sign in with valid credentials",
                    "The application has no credentials configured in QA NXT, so a successful sign-in cannot be automated.",
                    $"Open {_ctx.PageUrl}. Sign in with a valid account.", "You are signed in and taken to the signed-in area.");
                return;
            }
            if (full.Failure is not null)
            {
                Gap(TestCategory.Functional, null, "a valid submission",
                    $"No valid value could be produced for {full.Failure}", "Add a valid test-data value for the field, or a test by hand.",
                    CoverageGapStatus.NotCovered);
                return;
            }

            var priority = _transactional ? TestPriority.Critical : TestPriority.High;
            Add(Test(TestCategory.Functional, "happy-path", "accepts a complete valid submission",
                "A submission with every field validly completed is accepted.",
                "The form is accepted: a confirmation is shown or the application moves on, with no error.",
                new List<DesignedStep> { Open() }.Concat(full.Steps).Append(SubmitStep()).Append(Accepted("Confirm the submission was accepted")).Append(NoServerError()).ToList(),
                priority: priority, data: full.Data, coverage: _fields.Select(f => $"field:{_ctx.FormId:N}/{f.Identity}")));

            if (_fields.Any(f => !f.Required && !IsConditional(f)))
            {
                var minimal = FillValid(includeOptional: false);
                if (minimal.Failure is null)
                {
                    Add(Test(TestCategory.Functional, "required-only", "accepts a submission with only the required fields",
                        "Optional fields really are optional.",
                        "The form is accepted with every optional field left empty.",
                        new List<DesignedStep> { Open() }.Concat(minimal.Steps).Append(SubmitStep()).Append(Accepted("Confirm the submission was accepted")).ToList(),
                        priority: TestPriority.High, data: minimal.Data));
                }
            }
        }

        // ---- Required fields ------------------------------------------------------------

        private void Required()
        {
            if (_submit is null) return;
            var required = _fields.Where(f => f.Required && !IsConditional(f)).ToList();
            if (required.Count == 0 || !Wanted(TestCategory.Negative)) return;

            // A wizard refuses an empty first step at "Next"; that is the multi-step test's job.
            if (!_form.IsMultiStep)
                Add(Test(TestCategory.Negative, "submit-empty", "refuses an empty submission",
                    "Submitting without completing the required fields is refused.",
                    "The form is not accepted and says what is missing.",
                    new List<DesignedStep> { Open(), SubmitStep(), Rejected("Confirm the submission was refused") },
                    priority: TestPriority.High, coverage: required.Select(f => $"rule:{_ctx.FormId:N}/{f.Identity}/required")));

            foreach (var field in required)
            {
                var fill = Omitting(field, Omit)!;
                if (fill.Failure is not null) { FillGap(TestCategory.Negative, field, fill.Failure); continue; }
                Add(Test(TestCategory.Negative, "required", $"refuses a submission without {field.DisplayName}",
                    $"{field.DisplayName} is required: leaving only it empty is refused.",
                    $"The form is not accepted and {field.DisplayName} is reported as missing.",
                    fill.Steps.Append(Rejected($"Confirm the submission without {field.DisplayName} was refused")).ToList(),
                    field.Identity, TestPriority.High, new[] { $"rule:{_ctx.FormId:N}/{field.Identity}/required" }, fill.Data));

                if (ValueSynthesizer.IsTextLike(field) && field.ControlType != "password")
                {
                    var spaces = Omitting(field, "   ")!;
                    if (spaces.Failure is null)
                    {
                        Add(Test(TestCategory.Negative, "whitespace-only", $"refuses {field.DisplayName} containing only spaces",
                            $"Spaces alone are not a value for {field.DisplayName}.",
                            $"The form is not accepted; {field.DisplayName} is treated as empty.",
                            spaces.Steps.Append(Rejected("Confirm the whitespace-only value was refused")).ToList(),
                            field.Identity, TestPriority.Medium, new[] { $"rule:{_ctx.FormId:N}/{field.Identity}/whitespace" }, spaces.Data));
                    }

                    var valid = ValueSynthesizer.Valid(field);
                    if (valid.Ok && !_credentialForm)
                    {
                        var cleared = Omitting(field, valid.Value!)!;
                        var index = cleared.Steps.FindIndex(st => st.Target == field.Locator && st.Action == BrowserActionType.Fill);
                        if (cleared.Failure is null && index >= 0)
                        {
                            cleared.Steps.Insert(index + 1, new(BrowserActionType.Clear, $"Clear {field.DisplayName} again", field.Locator));
                            Add(Test(TestCategory.Negative, "required-after-clear", $"refuses {field.DisplayName} after it is typed and cleared",
                                "A required field that was completed and then emptied is still required.",
                                $"The form is not accepted and {field.DisplayName} is reported as missing.",
                                cleared.Steps.Append(Rejected("Confirm the cleared field was refused")).ToList(),
                                field.Identity, TestPriority.Medium, new[] { $"rule:{_ctx.FormId:N}/{field.Identity}/required" }, cleared.Data));
                        }
                    }
                }
            }

            foreach (var field in _fields.Where(f => f.Required && f.ControlType == "select" && f.Options.All(o => o.Value.Length > 0)))
            {
                Gap(TestCategory.Negative, field.Identity, "an empty choice",
                    $"{field.DisplayName} always has an option selected, so leaving it empty cannot be tried in the browser.",
                    "Check the server refuses a request without it, with an API test.", CoverageGapStatus.PartiallyCovered);
            }
        }

        /// <summary>The steps that leave one field out and press the control that should then
        /// refuse: the submit button, or for a field on an earlier wizard step, that step's
        /// "Next" — a wizard stops there, and filling the later steps would never happen.</summary>
        private Fill? Omitting(FormFieldModel field, string replacement)
        {
            var overrides = new Dictionary<string, string> { [field.Identity] = replacement };
            if (!_form.IsMultiStep)
            {
                var fill = FillValid(overrides);
                if (fill.Failure is not null) return fill;
                fill.Steps.Insert(0, Open());
                fill.Steps.Add(SubmitStep());
                return fill;
            }
            var groups = _fields.Select(f => f.Group).Distinct().OrderBy(g => g).ToList();
            var partial = FillValid(overrides, throughGroup: field.Group);
            if (partial.Failure is not null) return partial;
            partial.Steps.Insert(0, Open());
            partial.Steps.Add(field.Group == groups[^1] || _next is null
                ? SubmitStep()
                : new DesignedStep(BrowserActionType.Click, $"Press \"{_next.Label}\"", _next.Locator));
            return partial;
        }

        private DesignedStep SubmitStepOrNext()
            => _form.IsMultiStep && _next is not null && !(_submit?.Visible ?? false)
                ? new DesignedStep(BrowserActionType.Click, $"Press \"{_next.Label}\"", _next.Locator)
                : SubmitStep();

        private void FillGap(TestCategory category, FormFieldModel field, string failure)
            => Gap(category, field.Identity, $"tests of {field.DisplayName}",
                $"The rest of the form could not be completed validly ({failure}), so {field.DisplayName} cannot be tested on its own.",
                "Provide a valid value for the field named, then generate again.");

        // ---- Validation: declared formats -----------------------------------------------

        private void Validation()
        {
            if (_submit is null || !Wanted(TestCategory.Validation)) return;
            foreach (var field in _fields)
            {
                var invalids = new List<(string Value, string What, string Rule)>();
                switch (field.ControlType)
                {
                    case "email":
                        invalids.Add(("plainaddress", "an address with no @", "email"));
                        invalids.Add(("user@", "an address with no domain", "email"));
                        invalids.Add(("user@@example.test", "an address with two @ signs", "email"));
                        break;
                    case "url":
                        invalids.Add(("not a web address", "text that is not a web address", "url"));
                        invalids.Add(("example", "an address with no scheme", "url"));
                        break;
                }
                invalids.AddRange(ValueSynthesizer.PatternViolations(field).Select(v => (v.Value, v.What, "pattern")));

                if (ValueSynthesizer.IsNumeric(field))
                {
                    var limits = ValueSynthesizer.NumericLimitsOf(field);
                    var valid = ValueSynthesizer.Valid(field);
                    if (limits.Step is > 0 && valid.Ok)
                    {
                        var off = decimal.Parse(valid.Value!, System.Globalization.CultureInfo.InvariantCulture) + limits.Step.Value / 2;
                        if ((limits.Max is null || off <= limits.Max) && !limits.OnStep(off))
                            invalids.Add((off.ToString(System.Globalization.CultureInfo.InvariantCulture), $"a value between two of its steps of {limits.Step}", "step"));
                    }
                }

                if (field.ControlType == "file")
                {
                    var accepted = ValueSynthesizer.AcceptedExtensions(field);
                    if (accepted.Count > 0 && !accepted.Contains("exe"))
                    {
                        var steps = FillValid(new Dictionary<string, string> { [field.Identity] = UploadFixture.For("exe", 512) });
                        if (steps.Failure is null)
                        {
                            Add(Test(TestCategory.Validation, "file-type", $"refuses a file type {field.DisplayName} does not accept",
                                $"{field.DisplayName} accepts {field.Constraint("accept")}; anything else is refused.",
                                "The form is not accepted and the file type is reported.",
                                new List<DesignedStep> { Open() }.Concat(steps.Steps).Append(SubmitStep()).Append(Rejected("Confirm the wrong file type was refused")).ToList(),
                                field.Identity, TestPriority.High, new[] { $"rule:{_ctx.FormId:N}/{field.Identity}/accept" }, steps.Data));
                        }
                    }
                    Gap(TestCategory.Boundary, field.Identity, "a maximum file size",
                        "A file size limit is never declared in the page, so it cannot be discovered.",
                        "If the application limits upload size, verify the limit by hand or add it as a business rule.",
                        CoverageGapStatus.Unknown);
                    continue;
                }

                var index = 0;
                foreach (var (value, what, rule) in invalids)
                {
                    index++;
                    var fill = FillValid(new Dictionary<string, string> { [field.Identity] = value });
                    if (fill.Failure is not null) { FillGap(TestCategory.Validation, field, fill.Failure); break; }
                    Add(Test(TestCategory.Validation, $"format-{index}", $"refuses {what} in {field.DisplayName}",
                        $"{field.DisplayName} refuses {what}.",
                        $"The form is not accepted and {field.DisplayName} is reported as invalid.",
                        new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Rejected($"Confirm {what} was refused")).ToList(),
                        field.Identity, TestPriority.High,
                        new[] { $"rule:{_ctx.FormId:N}/{field.Identity}/{rule}" },
                        fill.Data));
                }
            }
        }

        // ---- Boundaries ---------------------------------------------------------------

        private void Boundary()
        {
            if (_submit is null || !Wanted(TestCategory.Boundary)) return;
            foreach (var field in _fields)
            {
                if (ValueSynthesizer.IsTextLike(field) && field.ControlType != "password" || field.ControlType == "password" && !_credentialForm)
                    TextBoundaries(field);
                else if (ValueSynthesizer.IsNumeric(field))
                    NumberBoundaries(field);
                else if (field.ControlType is "date" or "month")
                    DateBoundaries(field);
            }
        }

        private void BoundaryCase(FormFieldModel field, string technique, string value, bool accepted, string what)
        {
            if (accepted && !CanSucceed) return;
            var fill = FillValid(new Dictionary<string, string> { [field.Identity] = value });
            if (fill.Failure is not null) { FillGap(TestCategory.Boundary, field, fill.Failure); return; }
            Add(Test(TestCategory.Boundary, technique, $"{(accepted ? "accepts" : "refuses")} {what} in {field.DisplayName}",
                $"{field.DisplayName} {(accepted ? "accepts" : "refuses")} {what}.",
                accepted ? "The form is accepted." : $"The form is not accepted and {field.DisplayName} is reported as invalid.",
                new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep())
                    .Append(accepted ? Accepted($"Confirm {what} was accepted") : Rejected($"Confirm {what} was refused")).ToList(),
                field.Identity, accepted ? TestPriority.Medium : TestPriority.High,
                new[] { $"boundary:{_ctx.FormId:N}/{field.Identity}/{technique}" }, fill.Data));
        }

        private void TextBoundaries(FormFieldModel field)
        {
            var (min, max) = ValueSynthesizer.LengthLimits(field);
            if (min is null && max is null)
            {
                if (ValueSynthesizer.IsFreeText(field) || field.ControlType is "email" or "url" or "tel")
                    Gap(TestCategory.Boundary, field.Identity, "a length limit",
                        $"{field.DisplayName} declares no minimum or maximum length, so its length boundaries are unknown and none were invented.",
                        "If the application limits it, add the limit to the field (minlength/maxlength) or verify it by hand.",
                        CoverageGapStatus.Unknown);
                return;
            }

            if (min is { } lo && lo > 0)
            {
                if (lo - 1 >= 1 && ValueSynthesizer.OfLength(field, lo - 1) is { } below) BoundaryCase(field, "minlength-1", below, false, $"{lo - 1} characters (one below the minimum of {lo})");
                if (ValueSynthesizer.OfLength(field, lo) is { } at) BoundaryCase(field, "minlength", at, true, $"exactly {lo} characters (the minimum)");
                if ((max is null || lo + 1 <= max) && ValueSynthesizer.OfLength(field, lo + 1) is { } above) BoundaryCase(field, "minlength+1", above, true, $"{lo + 1} characters (one above the minimum)");
            }

            if (max is { } hi && hi > 0)
            {
                if (hi - 1 >= (min ?? 1) && ValueSynthesizer.OfLength(field, hi - 1) is { } below) BoundaryCase(field, "maxlength-1", below, true, $"{hi - 1} characters (one below the maximum of {hi})");
                if (ValueSynthesizer.OfLength(field, hi) is { } at) BoundaryCase(field, "maxlength", at, true, $"exactly {hi} characters (the maximum)");

                // Above the maximum, the browser refuses to hold the extra character. That is
                // the declared behaviour of maxlength, and it is what is checked: the field
                // ends up holding no more than the maximum.
                if (field.ControlType is not "email")
                {
                    // The field has to be on screen to be typed into: a conditional field is
                    // revealed by the answer that shows it, a later wizard step is reached by
                    // completing the steps before it.
                    var reach = new List<DesignedStep> { Open() };
                    var reachable = true;
                    if (IsConditional(field))
                    {
                        var reveal = _form.Dependencies.FirstOrDefault(d => d.Shows.Contains(field.Identity));
                        var trigger = reveal is null ? null : _fields.FirstOrDefault(f => f.Identity == reveal.Trigger);
                        if (reveal is null || trigger is null) reachable = false;
                        else reach.Add(SetStep(trigger, trigger.ControlType is "checkbox" or "switch" ? (reveal.TriggerValue == "off" ? "off" : "on") : reveal.TriggerValue));
                    }
                    else if (IsStepHidden(field))
                    {
                        var before = FillValid(throughGroup: field.Group - 1, clickNextAfterLastGroup: true);
                        if (before.Failure is not null) reachable = false;
                        else reach.AddRange(before.Steps);
                    }
                    if (reachable)
                    {
                        var over = ValueSynthesizer.OfLength(field, hi + 1) ?? new string('a', hi + 1);
                        Add(Test(TestCategory.Boundary, "maxlength+1", $"holds no more than {hi} characters in {field.DisplayName}",
                            $"{field.DisplayName} keeps at most its maximum of {hi} characters.",
                            $"After typing {hi + 1} characters the field holds at most {hi}.",
                            reach.Append(new(BrowserActionType.Fill, $"Enter {hi + 1} characters in {field.DisplayName}", field.Locator, over))
                                .Append(new(BrowserActionType.AssertValueLength, $"Confirm {field.DisplayName} holds at most {hi} characters", field.Locator, $"<={hi}")).ToList(),
                            field.Identity, TestPriority.High, new[] { $"boundary:{_ctx.FormId:N}/{field.Identity}/maxlength+1" }));
                    }
                }
            }
            else if (ValueSynthesizer.IsFreeText(field))
            {
                Gap(TestCategory.Boundary, field.Identity, "a maximum length",
                    $"{field.DisplayName} declares no maximum length, so its upper boundary is unknown. A very long value is still sent by the input-validation tests.",
                    "If the application limits it, declare maxlength or verify the limit by hand.", CoverageGapStatus.Unknown);
            }
        }

        private void NumberBoundaries(FormFieldModel field)
        {
            var limits = ValueSynthesizer.NumericLimitsOf(field);
            if (limits.Min is null && limits.Max is null)
            {
                Gap(TestCategory.Boundary, field.Identity, "a numeric range",
                    $"{field.DisplayName} declares no minimum or maximum, so its numeric boundaries are unknown and none were invented.",
                    "If the application limits it, declare min/max or verify the range by hand.", CoverageGapStatus.Unknown);
                return;
            }
            var d = limits.Delta;
            if (limits.Min is { } min)
            {
                BoundaryCase(field, "min-1", limits.Format(min - d), false, $"{limits.Format(min - d)} (one step below the minimum of {limits.Format(min)})");
                BoundaryCase(field, "min", limits.Format(min), true, $"{limits.Format(min)} (the minimum)");
                if (limits.Max is null || min + d <= limits.Max) BoundaryCase(field, "min+1", limits.Format(min + d), true, $"{limits.Format(min + d)} (one step above the minimum)");
                if (min > 0 && min - d > 0) BoundaryCase(field, "zero", "0", false, "zero");
                if (min >= 0) BoundaryCase(field, "negative", limits.Format(-d), false, "a negative value");
            }
            if (limits.Max is { } max)
            {
                if (!limits.OnStep(max))
                {
                    Gap(TestCategory.Boundary, field.Identity, "the maximum itself",
                        $"{limits.Format(max)} is not reachable in steps of {limits.Step} from {limits.Format(limits.Min ?? 0)}, so the browser would refuse it for its step, not its maximum.",
                        "Check the field's min, max and step agree.", CoverageGapStatus.PartiallyCovered);
                }
                else
                {
                    if (limits.Min is null || max - d >= limits.Min) BoundaryCase(field, "max-1", limits.Format(max - d), true, $"{limits.Format(max - d)} (one step below the maximum)");
                    BoundaryCase(field, "max", limits.Format(max), true, $"{limits.Format(max)} (the maximum)");
                }
                BoundaryCase(field, "max+1", limits.Format(max + d), false, $"{limits.Format(max + d)} (one step above the maximum of {limits.Format(max)})");
                BoundaryCase(field, "very-large", "999999999999", false, "a very large number");
            }
            if (limits.Decimals > 0 && limits.Step is > 0)
            {
                var valid = ValueSynthesizer.Valid(field);
                if (valid.Ok)
                {
                    var precise = valid.Value + "1";
                    BoundaryCase(field, "precision", precise, false, $"more decimal places than its step of {limits.Step} allows");
                }
            }
        }

        private void DateBoundaries(FormFieldModel field)
        {
            var month = field.ControlType == "month";
            DateOnly? Parse(string? s) => month ? ValueSynthesizer.ParseMonth(s) : ValueSynthesizer.ParseDate(s);
            string Format(DateOnly d) => d.ToString(month ? "yyyy-MM" : "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            DateOnly Step(DateOnly d, int n) => month ? d.AddMonths(n) : d.AddDays(n);
            var unit = month ? "month" : "day";

            var min = Parse(field.Constraint("min"));
            var max = Parse(field.Constraint("max"));
            if (min is null && max is null)
            {
                Gap(TestCategory.Boundary, field.Identity, "a date range",
                    $"{field.DisplayName} declares no earliest or latest date, so its boundaries are unknown and none were invented.",
                    "If the application limits it, declare min/max or verify the range by hand.", CoverageGapStatus.Unknown);
                return;
            }
            if (min is { } lo)
            {
                BoundaryCase(field, "min-1", Format(Step(lo, -1)), false, $"{Format(Step(lo, -1))} (one {unit} before the earliest)");
                BoundaryCase(field, "min", Format(lo), true, $"{Format(lo)} (the earliest allowed)");
            }
            if (max is { } hi)
            {
                BoundaryCase(field, "max", Format(hi), true, $"{Format(hi)} (the latest allowed)");
                BoundaryCase(field, "max+1", Format(Step(hi, 1)), false, $"{Format(Step(hi, 1))} (one {unit} after the latest)");
            }
        }

        // ---- Equivalence partitions -----------------------------------------------------

        /// <summary>Above this many options a select is partitioned (first, middle, last)
        /// rather than every option exercised: equivalence partitioning in the literal sense,
        /// and recorded as a gap so the choice is visible.</summary>
        private const int EveryOptionUpTo = 25;

        private void Equivalence()
        {
            if (_submit is null || !CanSucceed || !Wanted(TestCategory.Equivalence)) return;
            foreach (var field in _fields.Where(f => !IsConditional(f)))
            {
                if (field.ControlType is "select" or "radio")
                {
                    var options = field.Options.Where(o => !o.Disabled && o.Value.Length > 0).ToList();
                    if (_form.Dependencies.Any(d => d.OptionsOf.ContainsKey(field.Identity))) continue;
                    var chosen = options.Count <= EveryOptionUpTo ? options
                        : new[] { options[0], options[options.Count / 2], options[^1] }.ToList();
                    if (options.Count > EveryOptionUpTo)
                        Gap(TestCategory.Equivalence, field.Identity, $"{options.Count - 3} of {options.Count} options individually",
                            $"{field.DisplayName} has {options.Count} options; the first, middle and last were chosen as representatives.",
                            "Select the remaining options by hand if they behave differently.", CoverageGapStatus.PartiallyCovered);
                    foreach (var option in chosen)
                    {
                        var fill = FillValid(new Dictionary<string, string> { [field.Identity] = option.Value });
                        if (fill.Failure is not null) { FillGap(TestCategory.Equivalence, field, fill.Failure); break; }
                        Add(Test(TestCategory.Equivalence, $"option:{option.Value}", $"accepts \"{option.Label}\" in {field.DisplayName}",
                            $"Each choice in {field.DisplayName} is accepted.", "The form is accepted.",
                            new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Accepted($"Confirm \"{option.Label}\" was accepted")).ToList(),
                            field.Identity, TestPriority.Low, new[] { $"partition:{_ctx.FormId:N}/{field.Identity}/{option.Value}" }, fill.Data));
                    }
                }
                else if (field.ControlType is "checkbox" or "switch" && !field.Required)
                {
                    var fill = FillValid(new Dictionary<string, string> { [field.Identity] = "on" });
                    if (fill.Failure is null)
                        Add(Test(TestCategory.Equivalence, "checked", $"accepts {field.DisplayName} ticked",
                            $"{field.DisplayName} is optional and accepted when ticked.", "The form is accepted.",
                            new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Accepted("Confirm the submission was accepted")).ToList(),
                            field.Identity, TestPriority.Low, new[] { $"partition:{_ctx.FormId:N}/{field.Identity}/checked" }, fill.Data));
                }
                else if (ValueSynthesizer.IsTextLike(field) || ValueSynthesizer.IsNumeric(field) || ValueSynthesizer.IsDateLike(field))
                {
                    if (_credentialForm) continue;
                    var alternate = ValueSynthesizer.Valid(field, variant: 1);
                    var first = ValueSynthesizer.Valid(field);
                    if (!alternate.Ok || alternate.Value == first.Value) continue;
                    var fill = FillValid(new Dictionary<string, string> { [field.Identity] = alternate.Value! });
                    if (fill.Failure is not null) continue;
                    Add(Test(TestCategory.Equivalence, "valid-partition", $"accepts a second representative valid value in {field.DisplayName}",
                        $"{field.DisplayName} accepts more than one value from its valid partition.", "The form is accepted.",
                        new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Accepted("Confirm the value was accepted")).ToList(),
                        field.Identity, TestPriority.Low, new[] { $"partition:{_ctx.FormId:N}/{field.Identity}/valid" }, fill.Data));
                }
            }
        }

        // ---- Input validation (robustness) ---------------------------------------------

        private static readonly (string Technique, string Value, string What, bool MultilineOnly)[] RobustnessValues =
        {
            ("leading-trailing-spaces", "  QA NXT  ", "leading and trailing spaces", false),
            ("multiple-spaces", "QA    NXT", "several spaces in a row", false),
            ("tab", "QA\tNXT", "a tab character", false),
            ("newline", "first line\nsecond line", "a line break", true),
            ("unicode", "Zoë Ñandú 李雷 Ωμέγα", "accented, CJK and Greek characters", false),
            ("emoji", "Hello 👋🏽 QA", "emoji", false),
            ("html-characters", "<b>&\"'</b>", "HTML special characters", false),
            ("url-encoded", "%3Cb%3E%20%26", "URL-encoded characters", false),
            ("malformed-encoding", "%E0%A4%A", "a malformed percent-encoding", false),
            ("repeated", new string('Z', 200), "200 repeated characters", false),
            ("null-like", "null", "the word null", false),
            ("undefined-like", "undefined", "the word undefined", false),
            ("nan-like", "NaN", "the text NaN", false)
        };

        private void InputValidation()
        {
            if (_submit is null || !Wanted(TestCategory.InputValidation)) return;
            foreach (var field in _fields.Where(ValueSynthesizer.IsFreeText))
            {
                var (_, max) = ValueSynthesizer.LengthLimits(field);
                var values = RobustnessValues.Where(v => !v.MultilineOnly || field.ControlType is "textarea" or "richtext")
                    .Select(v => (v.Technique, Value: max is { } m && v.Value.Length > m ? v.Value[..m] : v.Value, v.What)).ToList();
                values.Add(("very-long", new string('L', max is { } limit ? limit : 5000), max is { } l ? $"{l} characters (its maximum)" : "5000 characters"));

                foreach (var (technique, value, what) in values)
                {
                    var fill = FillValid(new Dictionary<string, string> { [field.Identity] = value });
                    if (fill.Failure is not null) { FillGap(TestCategory.InputValidation, field, fill.Failure); break; }
                    Add(Test(TestCategory.InputValidation, technique, $"handles {what} in {field.DisplayName}",
                        $"{field.DisplayName} copes with {what}: accepted or refused, but never an error.",
                        "The application accepts or refuses the value cleanly. A server error, an uncaught script error or internal detail on the page is a failure.",
                        new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(NoServerError()).ToList(),
                        field.Identity, TestPriority.Low, new[] { $"input:{_ctx.FormId:N}/{field.Identity}/{technique}" }, fill.Data));
                }
            }
        }

        // ---- Cross-field rules ------------------------------------------------------------

        private sealed record Relationship(string Kind, FormFieldModel First, FormFieldModel Second, string Description);

        private List<Relationship> Relationships()
        {
            var result = new List<Relationship>();
            var confirm = new Regex(@"confirm|repeat|again|verify|retype|re-enter", RegexOptions.IgnoreCase);
            foreach (var second in _fields.Where(f => confirm.IsMatch($"{f.Name} {f.Label}")))
            {
                var first = _fields.FirstOrDefault(f => f != second && f.ControlType == second.ControlType && !confirm.IsMatch($"{f.Name} {f.Label}"));
                if (first is not null) result.Add(new("equals", first, second, $"{second.DisplayName} must match {first.DisplayName}"));
            }

            var pairs = new[] { ("start", "end"), ("from", "to"), ("begin", "finish"), ("min", "max"), ("first", "last"), ("checkin", "checkout"), ("departure", "return") };
            foreach (var (a, b) in pairs)
            {
                var first = _fields.FirstOrDefault(f => Word(f, a) && (ValueSynthesizer.IsDateLike(f) || ValueSynthesizer.IsNumeric(f)));
                var second = first is null ? null : _fields.FirstOrDefault(f => f != first && Word(f, b) && f.ControlType == first.ControlType);
                if (first is not null && second is not null && !result.Any(r => r.First == first && r.Second == second))
                    result.Add(new("ordered", first, second, $"{second.DisplayName} must not be before {first.DisplayName}"));
            }
            return result;

            static bool Word(FormFieldModel f, string word)
                => Regex.IsMatch($"{f.Name} {f.Label}", $@"(^|[^a-z]){word}|{word}(?=[A-Z]|$|[^a-z])", RegexOptions.IgnoreCase);
        }

        private void CrossField()
        {
            if (_submit is null) return;
            var relationships = Relationships();
            if (relationships.Count == 0) return;
            if (!Wanted(TestCategory.CrossField)) return;

            foreach (var rel in relationships)
            {
                var technique = $"{rel.Kind}:{rel.First.Identity}:{rel.Second.Identity}";
                if (rel.Kind == "equals")
                {
                    var a = ValueSynthesizer.Valid(rel.First);
                    var b = ValueSynthesizer.Valid(rel.First, variant: 1);
                    if (!a.Ok || !b.Ok || a.Value == b.Value) continue;
                    var fill = FillValid(new Dictionary<string, string> { [rel.First.Identity] = a.Value!, [rel.Second.Identity] = b.Value! });
                    if (fill.Failure is not null) continue;
                    Add(Test(TestCategory.CrossField, technique, $"refuses {rel.Second.DisplayName} that does not match {rel.First.DisplayName}",
                        rel.Description + ".", $"The form is not accepted and the mismatch is reported.",
                        new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Rejected("Confirm the mismatch was refused")).ToList(),
                        rel.Second.Identity, TestPriority.High, new[] { $"rule:{_ctx.FormId:N}/{rel.Second.Identity}/equals:{rel.First.Identity}" }, fill.Data));
                }
                else
                {
                    var (early, late) = OrderedPair(rel.First);
                    if (early is null || late is null) continue;
                    var reversed = FillValid(new Dictionary<string, string> { [rel.First.Identity] = late, [rel.Second.Identity] = early });
                    if (reversed.Failure is null)
                        Add(Test(TestCategory.CrossField, technique + ":reversed", $"refuses {rel.Second.DisplayName} before {rel.First.DisplayName}",
                            rel.Description + ".", "The form is not accepted and the order is reported.",
                            new List<DesignedStep> { Open() }.Concat(reversed.Steps).Append(SubmitStep()).Append(Rejected("Confirm the reversed range was refused")).ToList(),
                            rel.Second.Identity, TestPriority.High, new[] { $"rule:{_ctx.FormId:N}/{rel.Second.Identity}/after:{rel.First.Identity}" }, reversed.Data));
                    var equal = FillValid(new Dictionary<string, string> { [rel.First.Identity] = early, [rel.Second.Identity] = early });
                    if (equal.Failure is null && CanSucceed)
                        Add(Test(TestCategory.CrossField, technique + ":equal", $"accepts {rel.Second.DisplayName} equal to {rel.First.DisplayName}",
                            "The boundary of the rule — the two values equal — is accepted.", "The form is accepted.",
                            new List<DesignedStep> { Open() }.Concat(equal.Steps).Append(SubmitStep()).Append(Accepted("Confirm equal values were accepted")).ToList(),
                            rel.Second.Identity, TestPriority.Medium, new[] { $"boundary:{_ctx.FormId:N}/{rel.Second.Identity}/equal:{rel.First.Identity}" }, equal.Data));
                }
            }
        }

        private static (string? Early, string? Late) OrderedPair(FormFieldModel field)
        {
            var a = ValueSynthesizer.Valid(field);
            var b = ValueSynthesizer.Valid(field, variant: 1);
            if (!a.Ok || !b.Ok || a.Value == b.Value) return (null, null);
            return string.CompareOrdinal(a.Value, b.Value) < 0 || ValueSynthesizer.IsNumeric(field)
                && decimal.Parse(a.Value!, System.Globalization.CultureInfo.InvariantCulture) < decimal.Parse(b.Value!, System.Globalization.CultureInfo.InvariantCulture)
                ? (a.Value, b.Value) : (b.Value, a.Value);
        }

        // ---- Dynamic fields ---------------------------------------------------------------

        private void Dynamic()
        {
            if (_form.Dependencies.Count == 0 || !Wanted(TestCategory.Dynamic)) return;
            var byKey = _fields.ToDictionary(f => f.Identity, StringComparer.Ordinal);

            foreach (var dep in _form.Dependencies)
            {
                if (!byKey.TryGetValue(dep.Trigger, out var trigger)) continue;
                var setTrigger = SetStep(trigger, trigger.ControlType is "checkbox" or "switch" ? (dep.TriggerValue == "off" ? "off" : "on") : dep.TriggerValue);

                foreach (var shownKey in dep.Shows)
                {
                    if (!byKey.TryGetValue(shownKey, out var shown)) continue;
                    var technique = $"shows:{dep.Trigger}={dep.TriggerValue}:{shownKey}";
                    Add(Test(TestCategory.Dynamic, technique, $"shows {shown.DisplayName} when {trigger.DisplayName} is \"{dep.TriggerValue}\"",
                        $"Answering {trigger.DisplayName} with \"{dep.TriggerValue}\" reveals {shown.DisplayName}.",
                        $"{shown.DisplayName} appears.",
                        new List<DesignedStep> { Open(), new(BrowserActionType.AssertHidden, $"Confirm {shown.DisplayName} starts hidden", shown.Locator), setTrigger,
                            new(BrowserActionType.AssertVisible, $"Confirm {shown.DisplayName} is now shown", shown.Locator) },
                        shownKey, TestPriority.High, new[] { $"dependency:{_ctx.FormId:N}/{dep.Trigger}/{shownKey}" }));

                    // Hidden again when the answer changes back.
                    var other = trigger.ControlType is "checkbox" or "switch"
                        ? SetStep(trigger, dep.TriggerValue == "off" ? "on" : "off")
                        : trigger.Options.FirstOrDefault(o => o.Value.Length > 0 && o.Value != dep.TriggerValue
                            && !_form.Dependencies.Any(d => d.Trigger == dep.Trigger && d.TriggerValue == o.Value && d.Shows.Contains(shownKey))) is { } alt
                            ? SetStep(trigger, alt.Value) : null;
                    if (other is not null)
                        Add(Test(TestCategory.Dynamic, technique + ":hides-again", $"hides {shown.DisplayName} again when {trigger.DisplayName} changes back",
                            $"{shown.DisplayName} is only shown while it applies.", $"{shown.DisplayName} is hidden again.",
                            new List<DesignedStep> { Open(), setTrigger, new(BrowserActionType.AssertVisible, $"Confirm {shown.DisplayName} is shown", shown.Locator),
                                other, new(BrowserActionType.AssertHidden, $"Confirm {shown.DisplayName} is hidden again", shown.Locator) },
                            shownKey, TestPriority.Medium, new[] { $"dependency:{_ctx.FormId:N}/{dep.Trigger}/{shownKey}" }));

                    if (shown.Required && _submit is not null)
                    {
                        var fill = FillValid(new Dictionary<string, string> { [dep.Trigger] = dep.TriggerValue == "off" ? "off" : dep.TriggerValue, [shownKey] = Omit });
                        if (fill.Failure is null)
                            Add(Test(TestCategory.Dynamic, technique + ":required-when-shown", $"requires {shown.DisplayName} once it is shown",
                                $"{shown.DisplayName} is required when {trigger.DisplayName} is \"{dep.TriggerValue}\".",
                                $"The form is not accepted while {shown.DisplayName} is empty.",
                                new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Rejected($"Confirm the empty {shown.DisplayName} was refused")).ToList(),
                                shownKey, TestPriority.High, new[] { $"rule:{_ctx.FormId:N}/{shownKey}/required-when:{dep.Trigger}" }, fill.Data));
                    }
                }

                foreach (var (childKey, options) in dep.OptionsOf)
                {
                    if (!byKey.TryGetValue(childKey, out var child)) continue;
                    var offered = options.Where(o => !IsPlaceholderLabel(o)).ToList();
                    if (offered.Count == 0) continue;
                    var technique = $"options:{dep.Trigger}={dep.TriggerValue}:{childKey}";
                    Add(Test(TestCategory.Dynamic, technique, $"offers {child.DisplayName} options for \"{dep.TriggerValue}\"",
                        $"Choosing \"{dep.TriggerValue}\" in {trigger.DisplayName} fills {child.DisplayName} with its own options.",
                        $"{child.DisplayName} offers \"{offered[0]}\".",
                        new List<DesignedStep> { Open(), setTrigger, new(BrowserActionType.AssertText, $"Confirm {child.DisplayName} offers \"{offered[0]}\"", child.Locator, Expected: offered[0]) },
                        childKey, TestPriority.Medium, new[] { $"dependency:{_ctx.FormId:N}/{dep.Trigger}/{childKey}" }));

                    // A stale child: choose one parent and its child, then change the parent.
                    var otherParent = _form.Dependencies.FirstOrDefault(d => d.Trigger == dep.Trigger && d.TriggerValue != dep.TriggerValue
                        && d.OptionsOf.TryGetValue(childKey, out var o) && !o.Contains(offered[0]));
                    if (otherParent is not null)
                        Add(Test(TestCategory.Dynamic, technique + ":stale", $"does not keep a {child.DisplayName} from another {trigger.DisplayName}",
                            $"Changing {trigger.DisplayName} after choosing {child.DisplayName} does not leave a choice that no longer applies.",
                            $"{child.DisplayName} no longer holds \"{offered[0]}\".",
                            new List<DesignedStep> { Open(), setTrigger, SetStep(child, offered[0]), SetStep(trigger, otherParent.TriggerValue),
                                new(BrowserActionType.AssertVisible, $"Check {child.DisplayName} after the change", child.Locator,
                                    ExtraAssertion: AssertionType.ValueEquals, ExtraExpected: offered[0], ExtraNegate: true) },
                            childKey, TestPriority.Medium, new[] { $"dependency:{_ctx.FormId:N}/{dep.Trigger}/{childKey}/reset" }));
                }
            }
        }

        // ---- Wizards ---------------------------------------------------------------------

        private void MultiStep()
        {
            if (!_form.IsMultiStep) return;
            if (!Wanted(TestCategory.MultiStep)) return;
            if (_next is null)
            {
                Gap(TestCategory.MultiStep, null, "moving between steps", "The form has steps but no control to move to the next one was recognised.",
                    "Write the step navigation by hand.");
                return;
            }

            var groups = _fields.Select(f => f.Group).Distinct().OrderBy(g => g).ToList();
            var first = _fields.Where(f => f.Group == groups[0]).ToList();
            var second = _fields.Where(f => groups.Count > 1 && f.Group == groups[1]).ToList();
            var firstRequired = first.FirstOrDefault(f => f.Required);
            var secondVisible = second.FirstOrDefault(f => !IsConditional(f));

            if (firstRequired is not null && secondVisible is not null)
                Add(Test(TestCategory.MultiStep, "next-empty", "refuses to move on from an incomplete first step",
                    "The wizard does not advance past a step with required fields missing.",
                    "The first step stays shown and the missing field is reported.",
                    new List<DesignedStep> { Open(), new(BrowserActionType.Click, $"Press \"{_next.Label}\"", _next.Locator),
                        new(BrowserActionType.AssertHidden, $"Confirm {secondVisible.DisplayName} is still hidden", secondVisible.Locator),
                        new(BrowserActionType.AssertFieldInvalid, $"Confirm {firstRequired.DisplayName} is reported", firstRequired.Locator) },
                    firstRequired.Identity, TestPriority.High, new[] { "state:step-incomplete" }));

            var advance = FillValid(throughGroup: groups[0], clickNextAfterLastGroup: true);
            if (advance.Failure is null && secondVisible is not null)
            {
                Add(Test(TestCategory.MultiStep, "next-valid", "moves on from a completed first step",
                    "A completed step leads to the next one.", $"{secondVisible.DisplayName} is shown.",
                    new List<DesignedStep> { Open() }.Concat(advance.Steps).Append(new(BrowserActionType.AssertVisible, $"Confirm {secondVisible.DisplayName} is shown", secondVisible.Locator)).ToList(),
                    null, TestPriority.High, new[] { "state:step-advanced" }, advance.Data));

                if (_previous is not null)
                {
                    var steps = new List<DesignedStep> { Open() }.Concat(advance.Steps)
                        .Append(new(BrowserActionType.Click, $"Press \"{_previous.Label}\"", _previous.Locator)).ToList();
                    foreach (var field in first.Where(f => ValueSynthesizer.IsTextLike(f) && advance.Data.ContainsKey(f.Identity) && f.ControlType != "password"))
                        steps.Add(new(BrowserActionType.AssertValue, $"Confirm {field.DisplayName} still holds what was entered", field.Locator, Expected: advance.Data[field.Identity]));
                    if (steps.Count > advance.Steps.Count + 2)
                        Add(Test(TestCategory.MultiStep, "previous-keeps-answers", "keeps the first step's answers after going back",
                            "Going back to an earlier step does not lose what was entered there.",
                            "Every answer on the first step is still there.", steps, null, TestPriority.High, new[] { "state:step-returned" }, advance.Data));
                }

                Add(Test(TestCategory.Recovery, "wizard-refresh", "survives a refresh part way through",
                    "Reloading the page in the middle of the wizard does not break it.",
                    "The page reloads without an error and the form is usable.",
                    new List<DesignedStep> { Open() }.Concat(advance.Steps).Append(new(BrowserActionType.Reload, "Reload the page"))
                        .Append(NoServerError()).Append(new(BrowserActionType.AssertVisible, "Confirm the form is still shown", _form.Locator)).ToList(),
                    null, TestPriority.Medium, new[] { "state:step-refreshed" }, advance.Data));
                _applicable.Add(TestCategory.Recovery);

                Add(Test(TestCategory.Exploratory, "wizard-back", "survives the browser's back button part way through",
                    "The browser's own back button in the middle of the wizard does not break the application.",
                    "No error; the application is still usable.",
                    new List<DesignedStep> { Open() }.Concat(advance.Steps).Append(new(BrowserActionType.GoBack, "Press the browser's back button")).Append(NoServerError()).ToList(),
                    null, TestPriority.Low, new[] { "state:step-history" }, advance.Data));
                _applicable.Add(TestCategory.Exploratory);
            }

            var last = _fields.Where(f => f.Group == groups[^1] && f.Required).ToList();
            if (last.Count > 0 && _submit is not null)
            {
                var fill = FillValid(last.ToDictionary(f => f.Identity, _ => Omit));
                if (fill.Failure is null)
                    Add(Test(TestCategory.MultiStep, "final-incomplete", "refuses the final submission with the last step incomplete",
                        "The last step's required fields are enforced at the end.", "The form is not accepted.",
                        new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Rejected("Confirm the incomplete submission was refused")).ToList(),
                        null, TestPriority.High, new[] { "state:step-final-incomplete" }, fill.Data));
            }

            Gap(TestCategory.MultiStep, null, "direct navigation to a later step",
                "The steps share one address, so there is no later step to open directly.",
                "If steps have their own URLs, add a test that opens step 2 first.", CoverageGapStatus.Unsupported);
            Human(TestCategory.MultiStep, "resume", "resume an abandoned application",
                "Whether an abandoned wizard can be resumed later depends on the product's intent, which the page does not state.",
                $"Start {Title}, complete the first step, close the browser, return later.", "The product behaves as its requirements say: resumes or starts again cleanly.");
        }

        // ---- Buttons and duplicates ------------------------------------------------------

        private string? EndpointPath()
        {
            if (_form.Action is { Length: > 0 } action && Uri.TryCreate(action, UriKind.Absolute, out var uri)) return uri.AbsolutePath;
            var post = _ctx.Endpoints.FirstOrDefault(e => !string.Equals(e.Method, "GET", StringComparison.OrdinalIgnoreCase));
            return post?.Path;
        }

        private string SubmitMethod()
        {
            if (_form.HasFormElement && _form.Action is not null) return _form.Method.ToUpperInvariant();
            return _ctx.Endpoints.FirstOrDefault(e => !string.Equals(e.Method, "GET", StringComparison.OrdinalIgnoreCase))?.Method.ToUpperInvariant() ?? "POST";
        }

        private void Reliability()
        {
            if (_submit is null || !_transactional || !CanSucceed || !Wanted(TestCategory.Reliability)) return;
            var fill = FillValid();
            if (fill.Failure is not null) { Gap(TestCategory.Reliability, null, "duplicate-submission tests", $"No valid submission could be produced ({fill.Failure}).", "Provide valid test data."); return; }
            var path = EndpointPath();
            var method = SubmitMethod();
            var requests = JsonSerializer.Serialize(new { method, urlContains = path, maxCount = 1, countUnrefusedOnly = true }, JsonDefaults.Options);

            Add(Test(TestCategory.Reliability, "rapid-repeat-submit", "sends one submission when the submit control is pressed twice quickly",
                "An impatient second press does not submit the form twice.",
                "Exactly one submission reaches the server.",
                new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep("repeat:2:120"))
                    .Append(new(BrowserActionType.AssertRequests, $"Confirm at most one {method} was sent", Value: requests)).ToList(),
                null, TestPriority.High, new[] { "state:duplicate-click" }, fill.Data));

            Add(Test(TestCategory.Reliability, "refresh-after-submit", "does not submit again when the result page is refreshed",
                "Refreshing after a successful submission does not repeat it.",
                "Only the original submission reaches the server.",
                new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Accepted("Confirm the submission was accepted"))
                    .Append(new(BrowserActionType.Reload, "Refresh the page")).Append(new(BrowserActionType.AssertRequests, $"Confirm only one {method} was sent", Value: requests)).ToList(),
                null, TestPriority.High, new[] { "state:refresh-after-success" }, fill.Data));

            Add(Test(TestCategory.Reliability, "back-after-submit", "does not submit again on the browser's back button",
                "Going back after a successful submission does not repeat it or break the application.",
                "Only the original submission reaches the server and nothing errors.",
                new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Accepted("Confirm the submission was accepted"))
                    .Append(new(BrowserActionType.GoBack, "Press the browser's back button")).Append(NoServerError())
                    .Append(new(BrowserActionType.AssertRequests, $"Confirm only one {method} was sent", Value: requests)).ToList(),
                null, TestPriority.Medium, new[] { "state:back-after-success" }, fill.Data));
        }

        // ---- Errors and recovery -------------------------------------------------------

        private void ErrorHandlingAndRecovery()
        {
            if (_submit is null) return;
            var required = _fields.Where(f => f.Required && !IsConditional(f) && !IsStepHidden(f)).ToList();

            if (Wanted(TestCategory.ErrorHandling))
            {
                foreach (var field in _fields.Where(f => f.Required && !IsConditional(f)))
                {
                    var fill = Omitting(field, Omit)!;
                    if (fill.Failure is not null) continue;
                    Add(Test(TestCategory.ErrorHandling, "error-on-field", $"reports the missing {field.DisplayName} on that field",
                        "A validation error is shown against the field it is about, not only in general.",
                        $"{field.DisplayName} is marked invalid or has its message beside it.",
                        fill.Steps.Append(new(BrowserActionType.AssertFieldInvalid, $"Confirm {field.DisplayName} is reported", field.Locator)).ToList(),
                        field.Identity, TestPriority.Medium, new[] { $"message:{_ctx.FormId:N}/{field.Identity}/required" }, fill.Data));
                }

                if (!_form.HasFormElement || _form.Action is null)
                {
                    var fill = FillValid();
                    if (fill.Failure is null)
                        Add(Test(TestCategory.ErrorHandling, "network-offline", "tells the user when the network is down",
                            "A submission that cannot reach the server is reported rather than lost silently.",
                            "The form stays and an error message is shown.",
                            new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(new(BrowserActionType.SetOffline, "Disconnect the network", Value: "true"))
                                .Append(SubmitStep()).Append(Rejected("Confirm the failure was reported")).ToList(),
                            null, TestPriority.Medium, new[] { "state:network-offline" }, fill.Data));
                }
                else
                {
                    Gap(TestCategory.ErrorHandling, null, "a network failure during submission",
                        "This form submits by navigating, so a network failure is shown by the browser's own error page, not by the application.",
                        "Nothing to do unless the application intercepts submission.", CoverageGapStatus.Unsupported);
                }
                Gap(TestCategory.ErrorHandling, null, "server timeouts and authorization errors",
                    "A timeout or a 401/403 cannot be provoked from the page without changing the server.",
                    "Use the failure lab or an API test to provoke them.", CoverageGapStatus.PartiallyCovered);
            }

            if (!_form.IsMultiStep && Wanted(TestCategory.Recovery))
            {
                var target = required.FirstOrDefault(f => ValueSynthesizer.IsTextLike(f) && f.ControlType != "password") ?? required.FirstOrDefault();
                if (target is not null)
                {
                    var broken = FillValid(new Dictionary<string, string> { [target.Identity] = Omit });
                    // The corrected value is the one a valid fill would use, whatever kind of
                    // control it is: a select is corrected by choosing an option, not by typing.
                    var valid = FillValid();
                    if (broken.Failure is null && valid.Failure is null && valid.Data.TryGetValue(target.Identity, out var good) && !_credentialForm)
                    {
                        var steps = new List<DesignedStep> { Open() }.Concat(broken.Steps).Append(SubmitStep())
                            .Append(Rejected("Confirm the first attempt was refused"))
                            .Append(SetStep(target, good));
                        // A server-rendered form gives back what was typed except passwords;
                        // they have to be entered again, as a person would.
                        // Answering the corrected field can rebuild the fields that depend on it — a
                        // new country empties the region list — so those are answered again, as a
                        // person would have to.
                        foreach (var dependency in _form.Dependencies.Where(d => d.Trigger == target.Identity))
                            foreach (var child in dependency.OptionsOf.Keys.Concat(dependency.Shows).Distinct())
                                if (valid.Data.TryGetValue(child, out var childValue) && _fields.FirstOrDefault(f => f.Identity == child) is { } childField)
                                    steps = steps.Append(SetStep(childField, childValue));
                        foreach (var password in _fields.Where(f => f.ControlType == "password" && f != target && broken.Data.ContainsKey(f.Identity)))
                            steps = steps.Append(SetStep(password, broken.Data[password.Identity]));
                        foreach (var file in _fields.Where(f => f.ControlType == "file" && broken.Data.ContainsKey(f.Identity)))
                            steps = steps.Append(SetStep(file, broken.Data[file.Identity]));
                        Add(Test(TestCategory.Recovery, "correct-and-resubmit", $"accepts the form once {target.DisplayName} is corrected",
                            "After an error, correcting the field and submitting again works, and the error clears.",
                            "The second submission is accepted.",
                            steps.Append(SubmitStep()).Append(Accepted("Confirm the corrected submission was accepted")).ToList(),
                            target.Identity, TestPriority.High, new[] { "state:invalid-to-valid" }, broken.Data));
                    }
                }
            }
        }

        private void StateTransition()
        {
            if (_submit is null || !CanSucceed || !Wanted(TestCategory.StateTransition)) return;
            var fill = FillValid();
            if (fill.Failure is not null) return;

            if (_fields.Any(f => f.Required) && !_form.IsMultiStep && !_credentialForm)
                Add(Test(TestCategory.StateTransition, "empty-invalid-valid-submitted", "moves from empty to invalid to valid to submitted",
                    "The form passes through each state in turn: empty, refused, completed, accepted.",
                    "The empty submission is refused and the completed one accepted.",
                    new List<DesignedStep> { Open(), SubmitStep(), Rejected("Confirm the empty form was refused") }
                        .Concat(fill.Steps).Append(SubmitStep()).Append(Accepted("Confirm the completed form was accepted")).ToList(),
                    null, TestPriority.Medium, new[] { "state:empty", "state:invalid", "state:valid", "state:submitted" }, fill.Data));

            var firstText = _fields.FirstOrDefault(f => ValueSynthesizer.IsTextLike(f) && !IsConditional(f) && !IsStepHidden(f));
            var partial = firstText is null ? null : fill.Steps.FirstOrDefault(s => s.Target == firstText.Locator);
            if (partial is not null)
                Add(Test(TestCategory.StateTransition, "partial-reload", "is usable after a reload while partly filled",
                    "Reloading a partly completed form does not leave it broken.",
                    "The form reloads without an error and can still be submitted.",
                    new List<DesignedStep> { Open(), partial, new(BrowserActionType.Reload, "Reload the page"), NoServerError(),
                        new(BrowserActionType.AssertEnabled, $"Confirm \"{_submit.Label}\" can still be pressed", _submit.Locator) },
                    null, TestPriority.Low, new[] { "state:partial", "state:reloaded" }));

            Add(Test(TestCategory.StateTransition, "submitted-back", "is usable again after a submission and going back",
                "After a submission, returning to the form leaves it usable.",
                "No error; the form is shown again.",
                new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Accepted("Confirm the submission was accepted"))
                    .Append(new(BrowserActionType.Navigate, $"Open {Title} again", Url: _ctx.PageUrl)).Append(NoServerError())
                    .Append(new(BrowserActionType.AssertVisible, "Confirm the form is shown", _form.Locator)).ToList(),
                null, TestPriority.Low, new[] { "state:submitted", "state:returned" }, fill.Data));
        }

        // ---- Security ------------------------------------------------------------------

        private void Security()
        {
            if (!Wanted(TestCategory.Security)) return;

            if (_submit is not null && _profile.AllowSafeSecurityProbes)
            {
                foreach (var field in _fields.Where(ValueSynthesizer.IsFreeText))
                {
                    var marker = $"qanxt-probe-{ShortHash(_ctx.FormId + field.Identity)}";
                    var probe = $"<{marker}></{marker}>";
                    var (_, max) = ValueSynthesizer.LengthLimits(field);
                    if (max is { } m && probe.Length > m) { Gap(TestCategory.Security, field.Identity, "a reflection probe", $"{field.DisplayName} is too short to hold the marker.", "Check reflection by hand.", CoverageGapStatus.PartiallyCovered); continue; }
                    var fill = FillValid(new Dictionary<string, string> { [field.Identity] = probe });
                    if (fill.Failure is not null) continue;
                    Add(Test(TestCategory.Security, "markup-reflection", $"does not reflect markup typed into {field.DisplayName}",
                        "Text typed into the form never comes back as live page markup (a cross-site scripting indicator). The probe is an inert custom element: no script, no handler.",
                        "The marker element does not exist in the resulting page.",
                        new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep())
                            .Append(new(BrowserActionType.AssertNoMarkupInjection, "Confirm the input was not written back as markup", Value: marker)).Append(NoServerError()).ToList(),
                        field.Identity, TestPriority.High, new[] { $"security:{_ctx.FormId:N}/{field.Identity}/reflection" }, fill.Data));
                }
            }
            else if (!_profile.AllowSafeSecurityProbes)
            {
                Gap(TestCategory.Security, null, "reflection probes", "Safe security probes are switched off for this application.",
                    "Allow safe probes in the testing configuration if the security scope permits.", CoverageGapStatus.NotCovered);
            }

            if (_form.HasFormElement && _form.Action is not null && !string.Equals(_form.Method, "get", StringComparison.OrdinalIgnoreCase))
            {
                var scope = CssOf(_form.Locator);
                var tokenSelector = $"{scope ?? string.Empty} input[type=\"hidden\"]:is([name*=\"csrf\" i], [name*=\"xsrf\" i], [name*=\"_token\" i], [name*=\"authenticity\" i], [name*=\"verification\" i], [name*=\"antiforgery\" i])".Trim();
                Add(Test(TestCategory.Security, "anti-forgery-token", "carries an anti-forgery token",
                    "A state-changing form includes a token that ties the submission to the page (a CSRF indicator).",
                    "A hidden anti-forgery field is present in the form.",
                    new List<DesignedStep> { Open(), new(BrowserActionType.AssertPresent, "Confirm an anti-forgery token is present",
                        new LocatorDescriptor { Strategy = LocatorStrategy.Css, Value = tokenSelector }) },
                    null, TestPriority.High, new[] { $"security:{_ctx.FormId:N}/csrf" }));
            }
            else if (_transactional && (!_form.HasFormElement || _form.Action is null))
            {
                Gap(TestCategory.Security, null, "an anti-forgery token",
                    "This form submits with script, so a token would travel in a header that the page does not declare.",
                    "Check the request carries an anti-forgery header or a same-site cookie.", CoverageGapStatus.HumanRequired);
            }

            var password = _fields.FirstOrDefault(f => f.ControlType == "password");
            if (password is not null)
            {
                Add(Test(TestCategory.Security, "password-masked", $"masks what is typed into {password.DisplayName}",
                    "A password is never shown on screen as it is typed.", "The field is a password field.",
                    new List<DesignedStep> { Open(), new(BrowserActionType.AssertAttribute, $"Confirm {password.DisplayName} is masked", password.Locator, Expected: "password", Attribute: "type") },
                    password.Identity, TestPriority.High, new[] { $"security:{_ctx.FormId:N}/{password.Identity}/masked" }));
                if (string.Equals(_form.Method, "get", StringComparison.OrdinalIgnoreCase) && _form.HasFormElement && _form.Action is not null)
                    _findings.Add(new(FormFindingKind.SecurityIndicator, "password-in-url", password.Identity,
                        "This form submits with GET, so the password would travel in the URL and end up in history and logs.", "serious"));
                if (_credentialForm)
                {
                    Human(TestCategory.Security, "brute-force", "lock out or slow down repeated failed sign-ins",
                        "Proving it takes many failed sign-ins, which can lock a real account. Run it deliberately, against a test account, or with the security engine's authentication checks.",
                        $"Sign in at {_ctx.PageUrl} with a wrong password ten times in a row.", "Attempts are slowed, challenged or locked after a reasonable number.");
                    Human(TestCategory.Security, "account-enumeration", "give the same answer for an unknown user and a wrong password",
                        "Comparing the two needs a real account to compare against.",
                        "Sign in once with an unknown username, once with a known username and a wrong password.", "Both attempts give the same message and take about the same time.");
                }
            }

            foreach (var field in _fields.Where(f => f.ControlType is "cardNumber" || f.Autocomplete is { } a && a.StartsWith("cc-", StringComparison.Ordinal)))
            {
                if (field.Autocomplete is null or "on")
                    _findings.Add(new(FormFindingKind.SecurityIndicator, "card-autocomplete", field.Identity,
                        $"{field.DisplayName} holds card data and does not declare its autocomplete purpose.", "warning"));
            }

            Gap(TestCategory.Security, null, "authorization, access control and object references",
                "Who may submit this form, and with whose records, is a property of the account, not the page; it is tested at application level by the security engine against its scope.",
                "Run the security engine's access-control checks on this application.", CoverageGapStatus.PartiallyCovered);
        }

        private static string? CssOf(LocatorDescriptor locator) => locator.Strategy switch
        {
            LocatorStrategy.Css when locator.Nth is null && locator.Value != "body" => locator.Value,
            // The engine resolves a test id through data-testid, so that is the attribute.
            LocatorStrategy.TestId => $"[data-testid=\"{locator.Value}\"]",
            _ => locator.Fallbacks.Select(CssOf).FirstOrDefault(c => c is not null)
        };

        private static string ShortHash(string value)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..8].ToLowerInvariant();

        // ---- Accessibility -------------------------------------------------------------

        private void Accessibility()
        {
            if (!Wanted(TestCategory.Accessibility)) return;
            var include = CssOf(_form.Locator);
            var descriptor = JsonSerializer.Serialize(new { include, failOn = "serious" }, JsonDefaults.Options);
            Add(Test(TestCategory.Accessibility, "axe", "has no serious automated accessibility violations",
                "The form passes the automated WCAG rules axe-core can check. Automated rules cover part of accessibility, not all of it.",
                "No serious or critical violation is reported for the form.",
                new List<DesignedStep> { Open(), new(BrowserActionType.CheckAccessibility, "Run the accessibility rules on the form", Value: descriptor) },
                null, TestPriority.High, new[] { $"a11y:{_ctx.FormId:N}/rules" },
                evidence: "axe-core results (violations, incomplete, passes), screenshot."));
            if (include is null)
                Gap(TestCategory.Accessibility, null, "a scan scoped to the form", "The form has no selector the scanner can be scoped with, so the whole page is scanned.",
                    "Give the form an id or test id.", CoverageGapStatus.PartiallyCovered);

            if (_submit is not null && _fields.Any(f => f.Required))
                Add(Test(TestCategory.Accessibility, "axe-error-state", "has no serious accessibility violations while showing errors",
                    "The error state is as accessible as the empty one.", "No serious or critical violation in the error state.",
                    new List<DesignedStep> { Open(), SubmitStepOrNext(), new(BrowserActionType.CheckAccessibility, "Run the accessibility rules on the form with its errors shown", Value: descriptor) },
                    null, TestPriority.Medium, new[] { $"a11y:{_ctx.FormId:N}/rules-error-state", "state:invalid" }));

            if (_submit is not null)
            {
                foreach (var field in _fields.Where(f => f.Required && !IsConditional(f)))
                {
                    var fill = Omitting(field, Omit)!;
                    if (fill.Failure is not null) continue;
                    Add(Test(TestCategory.Accessibility, "error-associated", $"announces the error for {field.DisplayName} with the field",
                        "A screen reader user hears a field's error when they reach the field: it is marked invalid and its message is referenced by it.",
                        $"{field.DisplayName} has aria-invalid and an aria-describedby (or browser validation) message.",
                        fill.Steps.Append(new(BrowserActionType.AssertErrorAssociated, $"Confirm the error is tied to {field.DisplayName}", field.Locator)).ToList(),
                        field.Identity, TestPriority.Medium, new[] { $"a11y:{_ctx.FormId:N}/{field.Identity}/error-association" }, fill.Data));
                }
            }

            // Tab order through consecutive simple controls in the first visible group.
            // Built from the start of the form and stopped at the first control Tab treats
            // differently (a radio group is one stop, a file input has its own button) or that
            // is read-only, rather than skipping it: skipping would expect focus to jump a
            // control the browser in fact stops on.
            var chain = new List<FormFieldModel>();
            foreach (var field in _form.Fields.Where(f => f.Visible && !f.Disabled && !IsStepHidden(f)))
            {
                // Date and time inputs take Tab between their own segments (day, month, year),
                // so focus legitimately stays inside them; the chain stops there rather than
                // calling that a defect.
                if (field.ReadOnly || field.ControlType is "radio" or "file" or "richtext" || ValueSynthesizer.IsDateLike(field)) break;
                chain.Add(field);
            }
            if (chain.Count < 2 && _form.Fields.Count(f => f.Visible) >= 2)
                Gap(TestCategory.Accessibility, null, "keyboard order through the whole form",
                    "The form starts with, or soon reaches, a control that handles Tab itself (a date, a radio group or a file input), so the order past it is not checked automatically.",
                    "Tab through the form by hand.", CoverageGapStatus.PartiallyCovered);
            if (chain.Count >= 2)
            {
                // Focus is put in the first field by pressing Tab in it, not by clicking: a click on
                // a select opens its list, and Tab then closes the list instead of moving on.
                var steps = new List<DesignedStep> { Open() };
                for (var i = 1; i < chain.Count; i++)
                {
                    steps.Add(i == 1
                        ? new(BrowserActionType.Press, $"Press Tab in {chain[0].DisplayName}", chain[0].Locator, "Tab")
                        : new(BrowserActionType.Press, "Press Tab", Value: "Tab"));
                    steps.Add(new(BrowserActionType.AssertFocused, $"Confirm focus moved to {chain[i].DisplayName}", chain[i].Locator));
                }
                Add(Test(TestCategory.Accessibility, "tab-order", "moves keyboard focus through its fields in order",
                    "Tab moves through the form's fields in the order they are shown.", "Focus reaches each field in turn.",
                    steps, null, TestPriority.Medium, new[] { $"a11y:{_ctx.FormId:N}/tab-order" }));
            }

            var lastText = _fields.LastOrDefault(f => f.ControlType is "text" or "email" or "tel" or "url" or "search" or "number" or "password" && !IsConditional(f) && !IsStepHidden(f));
            if (_submit is not null && lastText is not null && !_form.IsMultiStep && CanSucceed)
            {
                var fill = FillValid();
                if (fill.Failure is null)
                    Add(Test(TestCategory.Accessibility, "keyboard-submit", "can be submitted with the keyboard alone",
                        "Pressing Enter in a field submits the form, so it needs no mouse.", "The form is accepted.",
                        new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(new(BrowserActionType.Press, $"Press Enter in {lastText.DisplayName}", lastText.Locator, "Enter"))
                            .Append(Accepted("Confirm the keyboard submission was accepted")).ToList(),
                        null, TestPriority.Medium, new[] { $"a11y:{_ctx.FormId:N}/keyboard-submit" }, fill.Data));
            }

            foreach (var field in _fields.Where(f => !f.HasAssociatedLabel))
                _findings.Add(new(FormFindingKind.AccessibilityIndicator, "no-label", field.Identity,
                    $"{field.DisplayName} has no label tied to it{(field.Placeholder is not null ? "; its placeholder is not a label" : string.Empty)}.", "serious"));

            Human(TestCategory.Accessibility, "screen-reader", "read and complete with a screen reader",
                "Whether a form makes sense when heard is a judgement no rule engine makes.",
                $"With NVDA, JAWS or VoiceOver, complete {Title} at {_ctx.PageUrl}, including one mistake.",
                "Every field, its purpose, whether it is required and every error are announced clearly.");
            Human(TestCategory.Accessibility, "focus-visible", "show where keyboard focus is at every step",
                "Whether a focus indicator is clearly visible is a visual judgement.",
                $"Tab through {Title}.", "A clearly visible focus indicator is on every control in turn.");
        }

        // ---- API correlation ----------------------------------------------------------

        private void Api()
        {
            if (_submit is null || !Wanted(TestCategory.Api)) return;
            var path = EndpointPath();
            var scripted = !_form.HasFormElement || _form.Action is null;
            if (path is null && !scripted)
            {
                Gap(TestCategory.Api, null, "the endpoint the form submits to",
                    "Neither the form's action nor any call observed during discovery tells where this form submits.",
                    "Discover the application again with interaction enabled, or add an API test.", CoverageGapStatus.NotCovered);
                return;
            }
            var method = SubmitMethod();
            var fill = FillValid();
            if (fill.Failure is not null || !CanSucceed) return;

            // A GET carries its values in the URL, not a body; a file upload's body is not
            // visible to the browser's network log at all.
            var multipart = _form.Enctype?.Contains("multipart", StringComparison.OrdinalIgnoreCase) == true || _fields.Any(f => f.ControlType == "file");
            if (multipart)
                Gap(TestCategory.Api, null, "the uploaded payload",
                    "The body of a file upload is not exposed to the browser's network log, so which values reached the endpoint cannot be read.",
                    "Check the stored record, or add an API test that posts the same fields.", CoverageGapStatus.PartiallyCovered);
            var marker = method == "GET" || multipart ? null : _fields.Where(f => ValueSynthesizer.IsFreeText(f) && fill.Data.ContainsKey(f.Identity))
                .Select(f => fill.Data[f.Identity]).FirstOrDefault(v => !v.StartsWith("${", StringComparison.Ordinal) && v.Length >= 3);
            // A form that submits with script has no declared endpoint; discovery does not
            // submit forms, so it has not seen one either. The test then checks the one
            // request the submission makes, wherever it goes, and the report names it.
            if (path is null)
                Gap(TestCategory.Api, null, "the endpoint's address",
                    "This form submits with script and discovery never submits forms, so the endpoint was not observed. The test checks whichever request the submission makes.",
                    "Discover with interaction, or name the endpoint in an API test.", CoverageGapStatus.PartiallyCovered);
            var request = JsonSerializer.Serialize(new { method, urlContains = path, minCount = 1, statusIn = new[] { "2xx", "3xx" }, bodyContains = marker }, JsonDefaults.Options);
            Add(Test(TestCategory.Api, "valid-reaches-endpoint", $"sends a valid submission to {method} {path ?? "its endpoint"}",
                "What is typed is what the endpoint receives, and the endpoint accepts it.",
                $"One {method} to {path} succeeds{(marker is null ? string.Empty : ", carrying the value entered")}.",
                new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(new(BrowserActionType.AssertRequests, $"Confirm {method} {path} received the submission", Value: request)).ToList(),
                null, TestPriority.High, new[] { $"api:{method} {path ?? "(scripted)"}", $"api-mapping:{_ctx.FormId:N}" }, fill.Data,
                "Network log with request and response bodies."));

            if (!_form.IsMultiStep && (_form.NoValidate || !_form.HasFormElement || _form.Action is null))
            {
                var invalid = JsonSerializer.Serialize(new { method, urlContains = path, minCount = 1, statusIn = new[] { "2xx", "4xx" } }, JsonDefaults.Options);
                if (_fields.Any(f => f.Required && !IsConditional(f)))
                    Add(Test(TestCategory.Api, "server-validates", "is validated by the server, not only the browser",
                        "An empty submission reaches the server and is refused there, without a server error.",
                        "The server answers without a 5xx and the form is refused.",
                        new List<DesignedStep> { Open(), SubmitStepOrNext(), Rejected("Confirm the submission was refused"),
                            new(BrowserActionType.AssertRequests, $"Confirm the server answered {method} {path} without an error", Value: invalid) },
                        null, TestPriority.High, new[] { $"api:{method} {path ?? "(scripted)"}", $"api-validation:{_ctx.FormId:N}" }));
            }
            else
            {
                Gap(TestCategory.Api, null, "server-side validation",
                    "The browser's own validation stops an invalid submission before it reaches the server, so whether the server checks too cannot be seen from the page.",
                    "Add an API test that posts invalid values directly to the endpoint.", CoverageGapStatus.PartiallyCovered);
            }
        }

        // ---- Performance ----------------------------------------------------------------

        private void Performance()
        {
            if (!Wanted(TestCategory.Performance)) return;
            Add(Test(TestCategory.Performance, "page-load", $"loads within {_profile.PageLoadBudgetMs} ms",
                "The form's page is ready within the configured budget.", $"The page loads in under {_profile.PageLoadBudgetMs} ms.",
                new List<DesignedStep> { Open(), new(BrowserActionType.AssertLoadTimeUnder, $"Confirm the page loaded within {_profile.PageLoadBudgetMs} ms", Value: _profile.PageLoadBudgetMs.ToString(System.Globalization.CultureInfo.InvariantCulture)) },
                null, TestPriority.Medium, new[] { $"performance:{_ctx.FormId:N}/load" }, evidence: "Navigation timing."));

            var path = EndpointPath();
            var fill = FillValid();
            if (_submit is not null && fill.Failure is null && (path is not null || _form.HasFormElement))
            {
                var request = JsonSerializer.Serialize(new { method = SubmitMethod(), urlContains = path, minCount = 1, maxDurationMs = _profile.SubmitBudgetMs }, JsonDefaults.Options);
                Add(Test(TestCategory.Performance, "submit-response", $"answers a submission within {_profile.SubmitBudgetMs} ms",
                    "The server responds to a valid submission within the configured budget.", $"The submission is answered in under {_profile.SubmitBudgetMs} ms.",
                    new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(new(BrowserActionType.AssertRequests, $"Confirm the response came within {_profile.SubmitBudgetMs} ms", Value: request)).ToList(),
                    null, TestPriority.Medium, new[] { $"performance:{_ctx.FormId:N}/submit" }, fill.Data, "Network timings."));
            }
        }

        // ---- Responsive, compatibility, visual ------------------------------------------

        private void Responsive()
        {
            var smaller = _profile.Viewports.Skip(1).ToList();
            if (smaller.Count == 0 || !Wanted(TestCategory.Responsive)) return;
            foreach (var viewport in smaller)
            {
                var steps = new List<DesignedStep>
                {
                    new(BrowserActionType.SetViewport, $"Use a {viewport.Name} screen ({viewport.Size})", Value: viewport.Size),
                    Open(), new(BrowserActionType.AssertNoHorizontalScroll, "Confirm nothing scrolls sideways")
                };
                steps.AddRange(_fields.Where(f => f.Visible && f.ControlType != "radio")
                    .Select(f => new DesignedStep(BrowserActionType.AssertVisible, $"Confirm {f.DisplayName} is shown", f.Locator)));
                if (_submit is { Visible: true }) steps.Add(new(BrowserActionType.AssertVisible, $"Confirm \"{_submit.Label}\" is shown", _submit.Locator));
                Add(Test(TestCategory.Responsive, $"viewport:{viewport.Name}", $"fits a {viewport.Name} screen ({viewport.Size})",
                    $"The form is usable at {viewport.Size} without sideways scrolling.", "Nothing overflows and every field is shown.",
                    steps, null, TestPriority.Medium, new[] { $"viewport:{viewport.Size}", $"responsive:{_ctx.FormId:N}/{viewport.Name}" }));
            }
        }

        private void Compatibility()
        {
            if (_submit is null || !CanSucceed || !Wanted(TestCategory.Compatibility)) return;
            var fill = FillValid();
            if (fill.Failure is not null) return;
            foreach (var browser in _profile.Browsers)
            {
                var name = browser.ToString().ToLowerInvariant();
                var test = Test(TestCategory.Compatibility, $"browser:{name}", $"accepts a valid submission in {browser}",
                    $"The form works the same in {browser}. Runs only in a {browser} run; a run in another browser skips it.",
                    "The form is accepted.",
                    new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(SubmitStep()).Append(Accepted("Confirm the submission was accepted")).ToList(),
                    null, TestPriority.Medium, new[] { $"browser:{name}", $"compatibility:{_ctx.FormId:N}/{name}" }, fill.Data);
                Add(test with { Tags = test.Tags.Append($"browser:{name}").ToList() });
            }
        }

        private void Visual()
        {
            if (!Wanted(TestCategory.Visual)) return;
            var selector = CssOf(_form.Locator);
            string Descriptor(string name, NamedViewport? viewport) => JsonSerializer.Serialize(new
            {
                name, selector, maxDifferencePercent = _profile.VisualThresholdPercent,
                viewport = viewport is null ? null : new { width = viewport.Width, height = viewport.Height }
            }, JsonDefaults.Options);

            var formKey = $"{Slug(_ctx.Route)}-{ShortHash(_ctx.FormId.ToString())}";
            Add(Test(TestCategory.Visual, "baseline", "looks the same as its approved baseline",
                "The form's appearance has not changed unexpectedly. The first run records the baseline.",
                "No difference above the threshold; a difference asks for review.",
                new List<DesignedStep> { Open(), new(BrowserActionType.CheckVisual, "Compare the form with its baseline", Value: Descriptor($"{formKey}-default", null)) },
                null, TestPriority.Low, new[] { $"visual:{_ctx.FormId:N}/default" }, evidence: "Baseline, actual and difference images."));

            if (_submit is not null && _fields.Any(f => f.Required))
                Add(Test(TestCategory.Visual, "error-state", "shows its errors the same way as its approved baseline",
                    "The error state's appearance has not changed unexpectedly.", "No difference above the threshold.",
                    new List<DesignedStep> { Open(), SubmitStepOrNext(), new(BrowserActionType.CheckVisual, "Compare the error state with its baseline", Value: Descriptor($"{formKey}-errors", null)) },
                    null, TestPriority.Low, new[] { $"visual:{_ctx.FormId:N}/errors", "state:invalid" }, evidence: "Baseline, actual and difference images."));

            var mobile = _profile.Viewports.LastOrDefault();
            if (mobile is not null && _profile.Viewports.Count > 1)
                Add(Test(TestCategory.Visual, $"viewport:{mobile.Name}", $"looks the same as its approved {mobile.Name} baseline",
                    $"The form's appearance at {mobile.Size} has not changed unexpectedly.", "No difference above the threshold.",
                    new List<DesignedStep> { new(BrowserActionType.SetViewport, $"Use a {mobile.Name} screen", Value: mobile.Size), Open(),
                        new(BrowserActionType.CheckVisual, $"Compare the form at {mobile.Size} with its baseline", Value: Descriptor($"{formKey}-{mobile.Name}", mobile)) },
                    null, TestPriority.Low, new[] { $"visual:{_ctx.FormId:N}/{mobile.Name}", $"viewport:{mobile.Size}" }, evidence: "Baseline, actual and difference images."));
        }

        // ---- Exploratory -----------------------------------------------------------------

        private void Exploratory()
        {
            if (_submit is null || !Wanted(TestCategory.Exploratory)) return;
            var fill = FillValid();
            if (fill.Failure is null && !_credentialForm)
                Add(Test(TestCategory.Exploratory, "session-cleared", "copes with the session disappearing before submission",
                    "If cookies vanish (session expired, signed out elsewhere) between opening and submitting, the application recovers rather than crashing.",
                    "No server error: the user is asked to sign in again, or the submission is handled.",
                    new List<DesignedStep> { Open() }.Concat(fill.Steps).Append(new(BrowserActionType.ClearCookies, "Clear the session"))
                        .Append(SubmitStep()).Append(NoServerError()).ToList(),
                    null, TestPriority.Medium, new[] { "state:session-expired" }, fill.Data));

            if (_fields.Any(f => f.Required))
                Add(Test(TestCategory.Exploratory, "repeated-invalid-submit", "copes with an invalid form being submitted again and again",
                    "Pressing submit repeatedly on an incomplete form keeps refusing it without errors.",
                    "No error, and the form is still refused.",
                    new List<DesignedStep> { Open(), SubmitStepOrNext() with { Value = _form.IsMultiStep ? null : "repeat:3:200" }, NoServerError() },
                    null, TestPriority.Low, new[] { "state:repeated-invalid" }));

            var firstText = _fields.FirstOrDefault(f => ValueSynthesizer.IsTextLike(f) && f.Visible && f.ControlType != "password");
            var value = firstText is null ? null : ValueSynthesizer.Valid(firstText);
            if (firstText is not null && value is { Ok: true })
                Add(Test(TestCategory.Exploratory, "away-and-back", "copes with leaving part way and coming back",
                    "Leaving a partly filled form for another page and returning with the back button does not break it.",
                    "No error; the form is shown and usable.",
                    new List<DesignedStep> { Open(), SetStep(firstText, value.Value!), new(BrowserActionType.Navigate, "Go to the application's home page", Url: new Uri(new Uri(_ctx.PageUrl), "/").ToString()),
                        new(BrowserActionType.GoBack, "Press the browser's back button"), NoServerError(),
                        new(BrowserActionType.AssertVisible, "Confirm the form is shown", _form.Locator) },
                    null, TestPriority.Low, new[] { "state:navigated-away" }));

            var optional = _fields.Where(f => !f.Required && !IsConditional(f)).ToList();
            var required = _fields.Where(f => f.Required && !IsConditional(f)).ToList();
            if (optional.Count > 0 && required.Count > 0 && !_form.IsMultiStep)
            {
                var overrides = required.ToDictionary(f => f.Identity, _ => Omit);
                var fill2 = FillValid(overrides);
                if (fill2.Failure is null && fill2.Steps.Count > 0)
                    Add(Test(TestCategory.Exploratory, "optional-without-required", "refuses the optional fields alone",
                        "An unusual combination — every optional field completed, every required one left empty — is still refused.",
                        "The form is not accepted.",
                        new List<DesignedStep> { Open() }.Concat(fill2.Steps).Append(SubmitStepOrNext()).Append(Rejected("Confirm the submission was refused")).ToList(),
                        null, TestPriority.Low, new[] { "state:unusual-combination" }, fill2.Data));
            }
        }

        // ---- Usability heuristics (read from the structure, never failures) -------------

        private void Usability()
        {
            if (!Wanted(TestCategory.Usability)) return;
            foreach (var field in _fields.Where(f => !f.HasAssociatedLabel && f.Placeholder is not null))
                _findings.Add(new(FormFindingKind.UsabilityHeuristic, "placeholder-as-label", field.Identity,
                    $"{field.DisplayName} uses its placeholder as its only label; the hint vanishes as soon as typing starts.", "warning"));
            var perStep = _fields.GroupBy(f => f.Group).Select(g => g.Count()).DefaultIfEmpty(0).Max();
            if (perStep > 12)
                _findings.Add(new(FormFindingKind.UsabilityHeuristic, "long-form", null,
                    $"{perStep} fields in one step. Long forms are abandoned more; consider grouping or steps.", "info"));
            if (_submit is not null && Regex.IsMatch(_submit.Label, @"^(submit|ok|go|send)$", RegexOptions.IgnoreCase))
                _findings.Add(new(FormFindingKind.UsabilityHeuristic, "generic-action", null,
                    $"The submit control says \"{_submit.Label}\", which does not say what happens. A label naming the outcome is clearer.", "info"));
            if (_submit is null)
                _findings.Add(new(FormFindingKind.UsabilityHeuristic, "no-primary-action", null, "No primary action was recognised for this form.", "warning"));
            foreach (var field in _fields.Where(f => f.Autocomplete is null && (Mentions(f, "email") || Mentions(f, "name") || Mentions(f, "phone", "tel") || Mentions(f, "address", "postcode", "zip"))))
                _findings.Add(new(FormFindingKind.UsabilityHeuristic, "no-autocomplete", field.Identity,
                    $"{field.DisplayName} looks like personal data but does not declare autocomplete, so browsers cannot fill it.", "info"));
            var labels = _fields.Where(f => f.Label is not null).GroupBy(f => f.Label!.Trim().ToLowerInvariant()).Where(g => g.Count() > 1);
            foreach (var duplicate in labels)
                _findings.Add(new(FormFindingKind.UsabilityHeuristic, "duplicate-label", null,
                    $"{duplicate.Count()} fields share the label \"{duplicate.First().Label}\".", "warning"));

            Human(TestCategory.Usability, "review", "usability review",
                "Clarity of labels and messages, field order and whether every field is needed are judgements, not checks.",
                $"Complete {Title} as a first-time user, making one mistake.", "Labels, order, messages and the outcome are clear; no field feels unnecessary.");
        }

        private void DataIntegrityAndWorkflow()
        {
            if (_submit is not null && _transactional && Wanted(TestCategory.DataIntegrity))
            {
                Gap(TestCategory.DataIntegrity, null, "the stored record",
                    "QA NXT has no access to the application's database, and a stored record is only observable where the application shows it back.",
                    "Verify the stored record by hand, or add an API test against the application's read endpoint.", CoverageGapStatus.HumanRequired);
                Human(TestCategory.DataIntegrity, "record-stored", "store exactly what was submitted",
                    "The stored record is not visible to the browser.",
                    $"Submit {Title} with recognisable values, then find the record in the application or its database.",
                    "One record exists, with every value as entered; an invalid submission created none.");
            }
            if (_fields.Count >= 2 && Wanted(TestCategory.Workflow))
            {
                Gap(TestCategory.Workflow, null, "business rules between fields beyond those named",
                    "Rules such as \"business accounts need a company number\" exist in requirements, not in the page; only rules visible in names or observed in behaviour were tested.",
                    "Record the form's business rules, or import the manual tests that cover them.", CoverageGapStatus.HumanRequired);
                Human(TestCategory.Workflow, "business-rules", "apply its business rules",
                    "Business correctness is defined by requirements the application does not expose.",
                    $"Walk through {Title} against its requirements.", "Every documented rule is enforced.");
            }
        }
    }

    private static string Slug(string route)
    {
        var cleaned = new string(route.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray()).ToLowerInvariant();
        return string.IsNullOrEmpty(cleaned) ? "root" : cleaned[..Math.Min(cleaned.Length, 40)];
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
