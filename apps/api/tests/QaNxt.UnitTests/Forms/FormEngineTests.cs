using System.IO.Compression;
using System.Text;
using FluentAssertions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Forms;
using QaNxt.Application.Testing;
using QaNxt.Domain.Enums;
using Xunit;

namespace QaNxt.UnitTests.Forms;

/// <summary>The deterministic form-level test engine.
///
/// These hold the engine to the rules it exists for: every generated step is one the
/// execution engine accepts; every test traces to something discovery found; limits that
/// are not declared are reported as unknown rather than invented; the same form always gives
/// the same suite; and nothing is quietly capped.</summary>
public class FormEngineTests
{
    private static readonly BrowserActionPolicy Policy = new(false, true, (string _, out string reason) => { reason = string.Empty; return true; });

    private static LocatorDescriptor TestId(string id) => new() { Strategy = LocatorStrategy.TestId, Value = id };

    private static FormFieldModel Field(string name, string type, bool required = false, Dictionary<string, string>? constraints = null,
        List<FormOptionModel>? options = null, bool visible = true, int group = 0, string? label = null, string? autocomplete = null)
        => new()
        {
            Key = name, Name = name, Label = label ?? name, HasAssociatedLabel = true, ControlType = type, Required = required,
            Constraints = constraints ?? new(), Options = options ?? new(), Visible = visible, Group = group,
            Autocomplete = autocomplete, Locator = TestId($"f-{name}")
        };

    private static DiscoveredFormModel Registration() => new()
    {
        Key = "registration", Name = "Create an account", Action = "http://lab/registration", Method = "post", HasCsrfToken = true,
        NoValidate = true, Locator = TestId("registration-form"),
        Fields = new()
        {
            Field("fullName", "text", true, new() { ["minlength"] = "2", ["maxlength"] = "60" }),
            Field("email", "email", true),
            Field("password", "password", true, new() { ["minlength"] = "8" }, autocomplete: "new-password"),
            Field("confirmPassword", "password", true, new() { ["minlength"] = "8" }, label: "Confirm password", autocomplete: "new-password"),
            Field("age", "number", true, new() { ["min"] = "18", ["max"] = "120", ["step"] = "1" }),
            Field("bio", "textarea"),
            Field("terms", "checkbox", true)
        },
        Buttons = new() { new FormButtonModel { Label = "Create account", Type = "submit", Role = "submit", Locator = TestId("registration-submit") } }
    };

    private static FormDesign Design(DiscoveredFormModel form, TestingProfile? profile = null, bool credentials = false)
        => FormTestDesigner.Design(new FormDesignContext(Guid.Parse("11111111-1111-1111-1111-111111111111"), form,
            "http://lab/registration", "/registration", form.Name, credentials, Array.Empty<CorrelatedEndpoint>(), profile ?? new TestingProfile()));

    [Fact]
    public void Every_generated_step_is_one_the_engine_accepts()
    {
        var design = Design(Registration());
        design.Tests.Should().NotBeEmpty();
        foreach (var test in design.Tests)
        {
            foreach (var step in test.Steps)
            {
                var result = BrowserActionValidator.Validate(new BrowserAction
                {
                    Action = step.Action, Description = step.Description, Target = step.Target, Value = step.Value,
                    Url = step.Url, Expected = step.Expected, Attribute = step.Attribute, Count = step.Count
                }, Policy);
                result.IsValid.Should().BeTrue($"{test.Name} / {step.Description}: {string.Join("; ", result.Errors)}");
            }
            test.Steps.Any(s => BrowserActionVerbs.IsAssertion(s.Action)
                || s.Action is BrowserActionType.CheckAccessibility or BrowserActionType.CheckVisual).Should().BeTrue($"{test.Name} must check something");
        }
    }

    [Fact]
    public void Each_required_field_is_refused_on_its_own_and_every_declared_boundary_is_tested()
    {
        var design = Design(Registration());
        foreach (var name in new[] { "fullName", "email", "password", "confirmPassword", "age", "terms" })
            design.Tests.Should().Contain(t => t.Category == TestCategory.Negative && t.Technique == "required" && t.FieldKey == name);

        string[] Boundaries(string field) => design.Tests.Where(t => t.Category == TestCategory.Boundary && t.FieldKey == field).Select(t => t.Technique).ToArray();
        Boundaries("age").Should().Contain(new[] { "min-1", "min", "min+1", "max-1", "max", "max+1" });
        Boundaries("fullName").Should().Contain(new[] { "minlength-1", "minlength", "minlength+1", "maxlength-1", "maxlength", "maxlength+1" });

        var below = design.Tests.Single(t => t.FieldKey == "age" && t.Technique == "min-1");
        below.Steps.Should().Contain(s => s.Action == BrowserActionType.Fill && s.Value == "17");
        below.Steps.Last().Action.Should().Be(BrowserActionType.AssertFormRejected);
        design.Tests.Single(t => t.FieldKey == "age" && t.Technique == "max").Steps.Last().Action.Should().Be(BrowserActionType.AssertFormAccepted);
    }

    [Fact]
    public void A_limit_that_is_not_declared_is_reported_as_unknown_and_never_invented()
    {
        var design = Design(Registration());
        design.Tests.Should().NotContain(t => t.FieldKey == "bio" && t.Category == TestCategory.Boundary);
        design.Gaps.Should().Contain(g => g.FieldKey == "bio" && g.Category == TestCategory.Boundary && g.Status == CoverageGapStatus.Unknown);
    }

    [Fact]
    public void Nothing_is_generated_for_a_field_discovery_did_not_find()
    {
        var design = Design(Registration());
        var fields = Registration().Fields.Select(f => f.Name).ToHashSet();
        design.Tests.Where(t => t.FieldKey is not null).Should().OnlyContain(t => fields.Contains(t.FieldKey!));
        design.Tests.Should().NotContain(t => t.Name.Contains("coupon", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_confirmation_field_gets_a_mismatch_test()
    {
        var design = Design(Registration());
        var mismatch = design.Tests.Single(t => t.Category == TestCategory.CrossField);
        mismatch.FieldKey.Should().Be("confirmPassword");
        var fills = mismatch.Steps.Where(s => s.Action == BrowserActionType.Fill && s.Target!.Value.Contains("assword")).Select(s => s.Value).ToList();
        fills.Should().HaveCount(2).And.OnlyHaveUniqueItems();
    }

    [Fact]
    public void The_same_form_always_produces_the_same_suite()
    {
        var first = Design(Registration()).Tests.Select(t => $"{t.Key}|{string.Join(",", t.Steps.Select(s => $"{s.Action}{s.Value}"))}").ToList();
        var second = Design(Registration()).Tests.Select(t => $"{t.Key}|{string.Join(",", t.Steps.Select(s => $"{s.Action}{s.Value}"))}").ToList();
        second.Should().Equal(first);
        first.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Quick_mode_generates_only_its_categories_and_custom_with_none_generates_nothing()
    {
        Design(Registration(), new TestingProfile { Mode = TestingMode.Quick }).Tests.Select(t => t.Category).Distinct()
            .Should().BeSubsetOf(new[] { TestCategory.Smoke, TestCategory.Functional, TestCategory.Negative, TestCategory.Accessibility });
        Design(Registration(), new TestingProfile { Mode = TestingMode.Custom, Categories = new() }).Tests.Should().BeEmpty();
        new TestingProfile { Mode = TestingMode.Custom }.Validate().Should().NotBeEmpty("an empty custom selection is refused with a reason");
    }

    [Fact]
    public void A_bigger_form_gets_more_tests_with_no_cap()
    {
        var small = Design(Registration()).Tests.Count;
        var bigger = Registration() with
        {
            Fields = Registration().Fields.Concat(Enumerable.Range(1, 30).Select(i => Field($"extra{i}", "text", true, new() { ["maxlength"] = "20" }))).ToList()
        };
        Design(bigger).Tests.Count.Should().BeGreaterThan(small + 30 * 5);
    }

    [Fact]
    public void A_sign_in_form_without_credentials_generates_no_test_that_expects_success()
    {
        var login = new DiscoveredFormModel
        {
            Key = "login", Name = "Sign in", Action = "http://lab/login", Method = "post", Locator = TestId("login-form"),
            Fields = new() { Field("username", "text", true, autocomplete: "username"), Field("password", "password", true, autocomplete: "current-password") },
            Buttons = new() { new FormButtonModel { Label = "Sign in", Type = "submit", Role = "submit", Locator = TestId("login-submit") } }
        };
        var design = Design(login);
        design.Tests.Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertFormAccepted));
        design.Gaps.Should().Contain(g => g.Category == TestCategory.Functional && g.Status == CoverageGapStatus.HumanRequired);
        design.HumanTasks.Should().Contain(h => h.Title.Contains("brute", StringComparison.OrdinalIgnoreCase) || h.Title.Contains("lock out"));

        var withCredentials = Design(login, credentials: true);
        withCredentials.Tests.Should().Contain(t => t.Technique == "happy-path"
            && t.Steps.Any(s => s.Value == "${secret:app_password}") && t.Steps.Any(s => s.Value == "${secret:app_username}"));
    }

    [Fact]
    public void A_value_for_a_conditional_field_first_reveals_it()
    {
        var form = new DiscoveredFormModel
        {
            Key = "dynamic", Name = "Open an account", Action = "http://lab/dynamic", Method = "post", NoValidate = true, Locator = TestId("dynamic-form"),
            Fields = new()
            {
                Field("hasReferral", "checkbox"),
                Field("referralCode", "text", true, new() { ["pattern"] = "[A-Z0-9]{6}", ["maxlength"] = "6" }, visible: false),
                Field("email", "email", true)
            },
            Buttons = new() { new FormButtonModel { Label = "Open account", Type = "submit", Role = "submit", Locator = TestId("dynamic-submit") } },
            Dependencies = new() { new FormDependencyModel { Trigger = "hasReferral", TriggerValue = "on", Shows = new() { "referralCode" } } }
        };
        var design = Design(form);
        var pattern = design.Tests.First(t => t.FieldKey == "referralCode" && t.Category == TestCategory.Validation);
        var tick = pattern.Steps.ToList().FindIndex(s => s.Action == BrowserActionType.Check && s.Target!.Value == "f-hasReferral");
        var type = pattern.Steps.ToList().FindIndex(s => s.Action == BrowserActionType.Fill && s.Target!.Value == "f-referralCode");
        tick.Should().BeGreaterThan(0).And.BeLessThan(type);
        design.Tests.Should().Contain(t => t.Category == TestCategory.Dynamic && t.Technique.EndsWith(":required-when-shown"));
        design.Tests.Single(t => t.FieldKey == "referralCode" && t.Technique == "maxlength+1").Steps
            .Should().Contain(s => s.Action == BrowserActionType.Check && s.Target!.Value == "f-hasReferral");
        design.Tests.Where(t => t.FieldKey == "referralCode" && t.Category == TestCategory.InputValidation)
            .Should().NotBeEmpty().And.OnlyContain(t => t.Steps.Any(s => s.Action == BrowserActionType.Check && s.Target!.Value == "f-hasReferral"));
    }

    [Fact]
    public void A_one_page_forms_continue_button_is_its_submit_control()
    {
        var form = Registration() with
        {
            Buttons = new() { new FormButtonModel { Label = "Continue", Type = "submit", Role = "next", Locator = TestId("go") } }
        };
        Design(form).Tests.Should().Contain(t => t.Technique == "happy-path");
    }

    [Theory]
    [InlineData("[0-9]{16}", null, null)]
    [InlineData("[a-z0-9_]+", "3", "12")]
    [InlineData("[A-Za-z0-9 ]{3,10}", null, null)]
    [InlineData("[0-9+ ]{7,15}", null, null)]
    [InlineData("[A-Z0-9]{6}", null, "6")]
    public void A_valid_value_meets_every_declared_constraint_at_once(string pattern, string? min, string? max)
    {
        var constraints = new Dictionary<string, string> { ["pattern"] = pattern };
        if (min is not null) constraints["minlength"] = min;
        if (max is not null) constraints["maxlength"] = max;
        var field = Field("x", "text", true, constraints);
        var value = ValueSynthesizer.Valid(field);
        value.Ok.Should().BeTrue(value.Reason);
        ValueSynthesizer.Satisfies(field, value.Value!).Should().BeTrue(value.Value);
        ValueSynthesizer.PatternViolations(field).Should().NotBeEmpty().And.OnlyContain(v => !ValueSynthesizer.MatchesPattern(pattern, v.Value));
    }

    [Fact]
    public void A_pattern_the_engine_cannot_satisfy_is_reported_rather_than_guessed()
    {
        var field = Field("x", "text", true, new() { ["pattern"] = "(?:foo|bar)\\d{3}", ["maxlength"] = "2" });
        ValueSynthesizer.Valid(field).Ok.Should().BeFalse();
    }

    [Theory]
    [InlineData("0.01", "10000", "0.01")]
    [InlineData("1", "99", "1")]
    [InlineData("1000", "50000", "100")]
    public void A_valid_number_is_inside_the_range_and_on_the_step(string min, string max, string step)
    {
        var field = Field("n", "number", true, new() { ["min"] = min, ["max"] = max, ["step"] = step });
        var value = decimal.Parse(ValueSynthesizer.Valid(field).Value!, System.Globalization.CultureInfo.InvariantCulture);
        value.Should().BeInRange(decimal.Parse(min, System.Globalization.CultureInfo.InvariantCulture), decimal.Parse(max, System.Globalization.CultureInfo.InvariantCulture));
        ValueSynthesizer.NumericLimitsOf(field).OnStep(value).Should().BeTrue();
    }

    [Fact]
    public void Coverage_weights_default_and_can_be_changed_by_category_name()
    {
        var profile = new TestingProfile();
        profile.WeightOf(TestCategory.Functional).Should().Be(3);
        profile.WeightOf(TestCategory.Visual).Should().Be(1);
        (profile with { Weights = new() { ["visual"] = 0 } }).WeightOf(TestCategory.Visual).Should().Be(0);
        TestingProfile.FromJson(profile.ToJson()).EffectiveCategories().Should().HaveCount(Enum.GetValues<TestCategory>().Length);
    }

    // ---- Manual test import ----------------------------------------------------------

    [Theory]
    [InlineData("Open /login", BrowserActionType.Navigate)]
    [InlineData("Go to https://lab.test/x", BrowserActionType.Navigate)]
    [InlineData("Enter \"ada\" in Username", BrowserActionType.Fill)]
    [InlineData("Fill the Email field with \"a@b.test\"", BrowserActionType.Fill)]
    [InlineData("Choose \"Canada\" from Country", BrowserActionType.Select)]
    [InlineData("Tick the terms checkbox", BrowserActionType.Check)]
    [InlineData("Click Sign in", BrowserActionType.Click)]
    [InlineData("Click the \"Save profile\" button", BrowserActionType.Click)]
    [InlineData("Verify \"Welcome back\" is shown", BrowserActionType.AssertText)]
    [InlineData("The URL should contain \"/dashboard\"", BrowserActionType.AssertUrl)]
    public void A_manual_step_in_the_grammar_becomes_an_action(string line, BrowserActionType expected)
    {
        var actions = StepGrammar.Parse(line, "http://lab.test");
        actions.Should().NotBeNull().And.HaveCount(1);
        actions![0].Action.Should().Be(expected);
        BrowserActionValidator.Validate(actions[0], Policy).IsValid.Should().BeTrue();
    }

    [Theory]
    [InlineData("Look for a reset link")]
    [InlineData("Make sure it feels fast")]
    [InlineData("Log in as an admin")]
    public void A_step_outside_the_grammar_is_not_guessed(string line)
        => StepGrammar.Parse(line, "http://lab.test").Should().BeNull();

    [Fact]
    public void Csv_with_quoted_line_breaks_and_doubled_quotes_is_read()
    {
        var rows = CsvReader.Read("Title,Steps\nA,\"Open /x\nClick \"\"Go\"\"\"\nB,Open /y\n");
        rows.Should().HaveCount(3);
        rows[1][1].Should().Be("Open /x\nClick \"Go\"");
    }

    [Fact]
    public void An_xlsx_sheet_with_shared_and_inline_strings_is_read()
    {
        var bytes = MakeXlsx();
        var rows = XlsxReader.Read(bytes);
        rows.Should().HaveCount(2);
        rows[0].Should().Equal("Title", "Steps");
        rows[1].Should().Equal("Opens", "Open /x");
    }

    private static byte[] MakeXlsx()
    {
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            void Add(string name, string content)
            {
                using var writer = new StreamWriter(zip.CreateEntry(name).Open(), Encoding.UTF8);
                writer.Write(content);
            }
            const string main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
            Add("xl/workbook.xml", $"<workbook xmlns=\"{main}\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"S\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
            Add("xl/_rels/workbook.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>");
            Add("xl/sharedStrings.xml", $"<sst xmlns=\"{main}\"><si><t>Title</t></si><si><t>Steps</t></si></sst>");
            Add("xl/worksheets/sheet1.xml", $"<worksheet xmlns=\"{main}\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>"
                + "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>Opens</t></is></c><c r=\"B2\" t=\"inlineStr\"><is><t>Open /x</t></is></c></row></sheetData></worksheet>");
        }
        return stream.ToArray();
    }
}
