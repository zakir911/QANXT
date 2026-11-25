using System.IO.Compression;
using System.Text;
using System.Text.Json;
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
    private static LocatorDescriptor Css(string selector) => new() { Strategy = LocatorStrategy.Css, Value = selector };

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

    /// <summary>A list page's search box: a GET form with an action, which changes nothing
    /// and re-renders its own page.</summary>
    private static DiscoveredFormModel SearchBox() => new()
    {
        Key = "customer-search", Name = "Customers", Action = "http://lab/customers", Method = "get",
        HasCsrfToken = false, NoValidate = false, Locator = TestId("customer-search-form"),
        Fields = new() { Field("q", "search"), Field("tier", "text") },
        Buttons = new() { new FormButtonModel { Label = "Search", Type = "submit", Role = "submit", Locator = TestId("customer-search-submit") } }
    };

    /// <summary>
    /// A filter box is not a transaction, so "accepted" cannot mean what it means on a form
    /// that saves something.
    ///
    /// AssertFormAccepted looks for a success message or for the form to be gone. A search
    /// re-renders the same page with the same controls, which is correct behaviour and
    /// exactly what that oracle reads as a silent refusal — "the form is still shown; no
    /// field is marked invalid; no error message is shown".
    ///
    /// Measured on a ten-page crawl of a freight application: 19 of 26 failures were this,
    /// every one on one of the four GET forms. Every application has a search box on every
    /// list page, so it fires everywhere and buries the findings that matter.
    ///
    /// _transactional already told the designer the difference and already gated the
    /// reliability and data-integrity tests. It was simply not applied to this step.
    /// </summary>
    [Fact]
    public void A_filter_form_does_not_assert_acceptance_the_way_a_saving_form_does()
    {
        var steps = Design(SearchBox()).Tests
            .SelectMany(test => test.Steps)
            .Select(step => step.Action)
            .ToList();

        steps.Should().NotContain(BrowserActionType.AssertFormAccepted,
            "a GET filter re-renders its own page, so a success message or a vanished form "
            + "is not what acceptance looks like here");
        steps.Should().Contain(BrowserActionType.AssertNoServerError,
            "what is true and worth asserting is that the application handled the "
            + "submission without erroring");
    }

    [Fact]
    public void A_saving_form_still_asserts_acceptance_properly()
    {
        // Guarding the filter case must not weaken the case it was written for: a form that
        // creates something should still be required to say it succeeded.
        Design(Registration()).Tests
            .SelectMany(test => test.Steps)
            .Select(step => step.Action)
            .Should().Contain(BrowserActionType.AssertFormAccepted);
    }

    /// <summary>A freight booking form: two dates whose ordering matters, named the way the
    /// industry names them rather than the way a travel site does.</summary>
    private static DiscoveredFormModel Booking() => new()
    {
        Key = "book-shipment", Name = "Book a shipment", Action = "http://lab/shipments/new",
        Method = "post", HasCsrfToken = true, NoValidate = true, Locator = TestId("book-form"),
        Fields = new()
        {
            Field("collectionDate", "date", true, label: "Collection date"),
            Field("estimatedDelivery", "date", true, label: "Estimated delivery"),
            Field("grossWeight", "number", true, new() { ["min"] = "0.1", ["max"] = "30000" })
        },
        Buttons = new() { new FormButtonModel { Label = "Book", Type = "submit", Role = "submit", Locator = TestId("book-submit") } }
    };

    /// <summary>
    /// A date pair is only cross-field tested if the detector knows the two words.
    ///
    /// The ordered-pair list held seven entries — start/end, from/to, begin/finish, min/max,
    /// first/last, checkin/checkout, departure/return — which is the vocabulary of a travel
    /// booking site. Measured on a 137-screen freight application: 2,348 tests were designed
    /// across 20 categories and not one was cross-field, because its forms say "Collection
    /// date" and "Estimated delivery". A shipment that delivered before it was collected
    /// saved without complaint and nothing had been written that would ask.
    /// </summary>
    [Fact]
    public void A_domain_named_date_pair_is_recognised_as_an_ordering()
    {
        var names = Design(Booking()).Tests.Select(t => t.Name).ToList();

        names.Should().Contain(name => name.Contains("before"),
            "delivery before collection is incoherent in any application, and the engine "
            + "already knows how to test an ordering once it sees one");

        Design(Booking()).Tests.Select(t => t.Category)
            .Should().Contain(TestCategory.CrossField);
    }

    /// <summary>The pairs it already knew must keep working: widening a vocabulary is only
    /// safe if it is additive.</summary>
    [Theory]
    [InlineData("startDate", "Start date", "endDate", "End date")]
    [InlineData("checkinDate", "Check-in", "checkoutDate", "Check-out")]
    [InlineData("validFrom", "Valid from", "validTo", "Valid to")]
    public void The_pairs_it_already_knew_still_pair(string firstName, string firstLabel,
        string secondName, string secondLabel)
    {
        var form = Booking() with
        {
            Fields = new()
            {
                Field(firstName, "date", true, label: firstLabel),
                Field(secondName, "date", true, label: secondLabel)
            }
        };

        Design(form).Tests.Select(t => t.Category).Should().Contain(TestCategory.CrossField);
    }

    /// <summary>
    /// Arrival and departure are deliberately not a pair.
    ///
    /// Which precedes which depends on whether the form describes a journey's own legs or a
    /// stay between them. A pair that is wrong half the time generates failures on correct
    /// applications, and this engine has produced enough of those.
    /// </summary>
    [Fact]
    public void Arrival_and_departure_are_not_treated_as_an_ordering()
    {
        var form = Booking() with
        {
            Fields = new()
            {
                Field("arrivalDate", "date", true, label: "Arrival date"),
                Field("departureDate", "date", true, label: "Departure date")
            }
        };

        Design(form).Tests.Select(t => t.Category).Should().NotContain(TestCategory.CrossField,
            "the ordering depends on what the form is about, so asserting one would be a "
            + "guess dressed as a finding");
    }

    /// <summary>A stock transfer: two selects over one list of sites, plus the product.</summary>
    private static DiscoveredFormModel Transfer() => new()
    {
        Key = "new-transfer", Name = "New transfer", Action = "http://lab/warehouse/transfers/new",
        Method = "post", HasCsrfToken = true, NoValidate = true, Locator = TestId("transfer-form"),
        Fields = new()
        {
            SelectField("skuId", "Product", new[] { ("", "Choose a product"), ("sku-001", "MF-1000"), ("sku-002", "MF-1037") }),
            SelectField("fromWarehouseId", "From site", new[] { ("", "Choose a site"), ("wh-fxt", "Felixstowe DC"), ("wh-mcr", "Manchester Hub") }),
            SelectField("toWarehouseId", "To site", new[] { ("", "Choose a site"), ("wh-fxt", "Felixstowe DC"), ("wh-mcr", "Manchester Hub") })
        },
        Buttons = new() { new FormButtonModel { Label = "Raise transfer", Type = "submit", Role = "submit", Locator = TestId("transfer-submit") } }
    };

    /// <summary>A required select, built through the same Field helper the other fixtures
    /// use so Key and Identity are derived the way the engine derives them.</summary>
    private static FormFieldModel SelectField(string name, string label,
        (string Value, string Label)[] options)
        => Field(name, "select", required: true, label: label,
            options: options.Select(o => new FormOptionModel { Value = o.Value, Label = o.Label }).ToList());

    /// <summary>
    /// Two selects over the same list must not both take its first option.
    ///
    /// Each select was filled independently, so a transfer form's "From site" and "To site" —
    /// the same list of warehouses — both received the first one, and the application
    /// correctly refused a transfer from Felixstowe to Felixstowe. The happy-path test then
    /// reported that a valid submission had been rejected.
    ///
    /// Measured on a 137-screen freight application: this shape is on every transfer, every
    /// origin-and-destination pair and every move-between form. Each chosen value was
    /// individually valid, which is why nothing in the single-field synthesis could see it.
    /// </summary>
    [Fact]
    public void Two_selects_over_the_same_list_are_given_different_options()
    {
        var happy = Design(Transfer()).Tests
            .First(t => t.Name.Contains("accepts a complete valid submission"));

        var chosen = happy.Steps
            .Where(step => step.Action == BrowserActionType.Select)
            .ToDictionary(step => step.Description, step => step.Value);

        var sites = chosen.Where(pair => pair.Key.Contains("site")).Select(pair => pair.Value).ToList();
        sites.Should().HaveCount(2);
        sites.Should().OnlyHaveUniqueItems(
            "a transfer from a site to itself is not a valid submission, so filling both "
            + "with the first option tests the application's refusal rather than its "
            + "acceptance");
    }

    /// <summary>Selects over different lists are untouched: the product and the site are not
    /// in competition, and forcing them apart would be meaningless.</summary>
    [Fact]
    public void Selects_over_different_lists_still_take_their_first_option()
    {
        var happy = Design(Transfer()).Tests
            .First(t => t.Name.Contains("accepts a complete valid submission"));

        happy.Steps
            .Where(step => step.Action == BrowserActionType.Select && step.Description.Contains("Product"))
            .Select(step => step.Value)
            .Should().Equal("sku-001");
    }

    /// <summary>A three-step booking wizard: one step of text, one of numbers and a
    /// selector, one to confirm. The shape the freight lab's booking form has, and the
    /// shape the retention check used to look straight past.</summary>
    private static DiscoveredFormModel ThreeStepWizard() => new()
    {
        Key = "booking", Name = "Book a shipment", Action = "http://lab/shipments/new", Method = "post",
        HasCsrfToken = true, NoValidate = true, Locator = TestId("booking-form"), IsMultiStep = true, VisibleGroup = 0,
        Fields = new()
        {
            Field("reference", "text", true, new() { ["maxlength"] = "20" }, group: 0),
            Field("customer", "text", true, group: 0),
            Field("pieces", "number", true, new() { ["min"] = "1", ["max"] = "500", ["step"] = "1" }, visible: false, group: 1),
            Field("weight", "number", true, new() { ["min"] = "0.1", ["max"] = "30000", ["step"] = "0.1" }, visible: false, group: 1),
            Field("weightUnit", "select", options: new()
            {
                new FormOptionModel { Value = "kg", Label = "Kilograms" },
                new FormOptionModel { Value = "lb", Label = "Pounds" }
            }, visible: false, group: 1),
            Field("notes", "textarea", visible: false, group: 2)
        },
        Buttons = new()
        {
            new FormButtonModel { Label = "Next", Type = "button", Role = "next", Locator = TestId("booking-next") },
            new FormButtonModel { Label = "Back", Type = "button", Role = "previous", Locator = TestId("booking-previous") },
            new FormButtonModel { Label = "Book", Type = "submit", Role = "submit", Locator = TestId("booking-submit") }
        }
    };

    /// <summary>
    /// Going back must not empty the step you came from, whichever step that is.
    ///
    /// The check existed and looked only at step one, and only at its text fields. A wizard
    /// that re-renders a later step from its defaults rather than from the draft loses
    /// exactly what step one keeps: the freight lab's booking wizard empties step two's
    /// numbers when you step back from step three, and no test asked.
    /// </summary>
    [Fact]
    public void Going_back_is_checked_for_every_step_not_only_the_first()
    {
        var retention = Design(ThreeStepWizard()).Tests
            .Where(test => test.Technique.StartsWith("previous-keeps-answers", StringComparison.Ordinal))
            .ToList();

        retention.Should().HaveCount(2,
            "a three-step wizard has two steps you can come back to, and both can lose what was typed");
        retention.Select(test => test.Technique).Should()
            .BeEquivalentTo(new[] { "previous-keeps-answers", "previous-keeps-answers-2" });
    }

    /// <summary>A quantity a wizard forgets is as lost as a name it forgets. assertValue
    /// reads a number and a select through the control's own value, so there was no reason
    /// to check only the text fields.</summary>
    [Fact]
    public void Going_back_reads_numbers_and_selects_back_not_only_text()
    {
        var second = Design(ThreeStepWizard()).Tests
            .Single(test => test.Technique == "previous-keeps-answers-2");

        var readBack = second.Steps
            .Where(step => step.Action == BrowserActionType.AssertValue)
            .Select(step => step.Description)
            .ToList();

        readBack.Should().HaveCount(3, "step two holds two numbers and a selector");
        readBack.Should().Contain(description => description.Contains("pieces"));
        readBack.Should().Contain(description => description.Contains("weight"));
        readBack.Should().Contain(description => description.Contains("weightUnit"));
    }

    /// <summary>A password is deliberately not read back, and a tick is not a value the
    /// control reports, so neither is asserted.</summary>
    [Fact]
    public void Going_back_does_not_read_a_password_or_a_tick_back()
    {
        var wizard = ThreeStepWizard();
        var withSecrets = wizard with
        {
            Fields = wizard.Fields.Concat(new[]
            {
                Field("pin", "password", visible: false, group: 1),
                Field("fragile", "checkbox", visible: false, group: 1)
            }).ToList()
        };

        var second = Design(withSecrets).Tests
            .Single(test => test.Technique == "previous-keeps-answers-2");

        second.Steps.Where(step => step.Action == BrowserActionType.AssertValue)
            .Select(step => step.Description)
            .Should().NotContain(description => description.Contains("pin"))
            .And.NotContain(description => description.Contains("fragile"));
    }

    /// <summary>
    /// Press Save, then go and look: the engine used to declare this out of reach.
    ///
    /// The gap it recorded said a stored record is only observable where the application
    /// shows it back — true of the database, false of the page. An application that answers
    /// a save with a redirect is showing the record, and the values it was given should be
    /// in what it shows.
    /// </summary>
    [Fact]
    public void A_saving_form_is_checked_by_opening_the_record_again()
    {
        var roundTrip = Design(Registration()).Tests
            .Single(test => test.Technique == "round-trip");

        roundTrip.Category.Should().Be(TestCategory.DataIntegrity);
        roundTrip.Steps[^1].Action.Should().Be(BrowserActionType.AssertSavedValuesReadBack,
            "the oracle navigates, so nothing after it would be looking at the page the rest "
            + "of the test left behind");
        roundTrip.Steps.Select(step => step.Action).Should().Contain(BrowserActionType.AssertFormAccepted,
            "a record is only read back once the submission has been established as accepted");
    }

    /// <summary>Only free text carries a marker. A number can come back rounded, a date
    /// reformatted, a selection rendered as its label and an amount converted into another
    /// unit — all correct, and none of it a value that comes back as it went in.</summary>
    [Fact]
    public void Only_free_text_values_are_asked_to_read_back()
    {
        var roundTrip = Design(Registration()).Tests.Single(test => test.Technique == "round-trip");
        var asked = roundTrip.Steps.Last(step => step.Action == BrowserActionType.AssertSavedValuesReadBack);

        var payload = JsonSerializer.Deserialize<SavedValuesStep>(asked.Value!, JsonDefaults.Options)!;

        payload.Values.Should().OnlyContain(v => v.Value.StartsWith("QANXT-", StringComparison.Ordinal),
            "a value the application could already be showing proves nothing");
        payload.Values.Select(v => v.Label).Should().BeEquivalentTo(new[] { "fullName", "bio" },
            "the text field and the textarea; not the age, not the password, not the tick");
    }

    /// <summary>The same form always gives the same suite, markers included: a random one
    /// would make two runs of the same application disagree about what was asked.</summary>
    [Fact]
    public void A_read_back_marker_is_the_same_every_time()
    {
        string Marker(FormDesign design) => JsonSerializer
            .Deserialize<SavedValuesStep>(design.Tests.Single(t => t.Technique == "round-trip")
                .Steps.Last(s => s.Action == BrowserActionType.AssertSavedValuesReadBack).Value!,
                JsonDefaults.Options)!
            .Values.First().Value;

        Marker(Design(Registration())).Should().Be(Marker(Design(Registration())));
    }

    /// <summary>A filter box saves nothing, so there is no record to open again.</summary>
    [Fact]
    public void A_filter_form_is_not_asked_to_read_a_record_back()
    {
        Design(SearchBox()).Tests.Should().NotContain(test => test.Technique == "round-trip");
    }

    /// <summary>
    /// A form built by client JavaScript carries HTML's default method of GET and posts with
    /// fetch anyway. The clinical scheduler's booking form reads method=get, action=null, and
    /// creates appointments; a check on the method threw it out, so the application where
    /// reading the record back matters most got no round-trip test at all.
    /// </summary>
    [Fact]
    public void A_client_rendered_form_that_declares_no_method_is_still_asked_to_read_back()
    {
        var booking = new DiscoveredFormModel
        {
            Key = "booking", Name = "Schedule", Action = null, Method = "get",
            HasCsrfToken = false, NoValidate = false, Locator = TestId("booking-form"),
            Fields = new()
            {
                Field("patient", "text", true, new() { ["maxlength"] = "60" }),
                Field("start", "datetime", true),
                Field("end", "datetime", true)
            },
            Buttons = new() { new FormButtonModel { Label = "Book", Type = "submit", Role = "submit", Locator = TestId("booking-submit") } }
        };

        Design(booking).Tests.Should().Contain(test => test.Technique == "round-trip");
    }

    [Fact]
    public void A_reference_field_raises_the_uniqueness_question_rather_than_asserting_an_answer()
    {
        // FP_D04 is real and observable: freight accepts two invoices carrying one reference
        // with the defect on, and refuses the second with it off. What the generator cannot
        // know is whether the rule exists. A field named "reference" is as often a
        // counterparty's own number, legitimately shared, as it is a key — and freight's own
        // form says nothing either way. Asserting uniqueness would fail every application
        // that allows duplicates by design.
        var invoice = new DiscoveredFormModel
        {
            Name = "Raise an invoice", Method = "post", Action = "/billing/invoices/new",
            HasFormElement = true, Locator = TestId("invoice-form"),
            Fields = new()
            {
                Field("customerId", "select", true),
                Field("netGbp", "number", true),
                Field("reference", "text", false, new() { ["maxlength"] = "24" })
            },
            Buttons = new() { new FormButtonModel { Label = "Raise invoice", Type = "submit", Role = "submit", Locator = TestId("invoice-submit") } }
        };

        var design = Design(invoice);

        design.Tests.Should().NotContain(test => test.Technique.StartsWith("unique-"),
            "a rule nobody stated is not a verdict a machine may reach");
        design.Gaps.Should().Contain(gap =>
            gap.FieldKey == "reference" && gap.Status == CoverageGapStatus.HumanRequired);
        design.HumanTasks.Should().Contain(task => task.Key.Contains("unique-reference"));
    }

    [Fact]
    public void The_uniqueness_question_names_both_answers_so_it_can_be_closed()
    {
        var invoice = new DiscoveredFormModel
        {
            Name = "Raise an invoice", Method = "post", Action = "/billing/invoices/new",
            HasFormElement = true, Locator = TestId("invoice-form"),
            Fields = new() { Field("reference", "text", false) },
            Buttons = new() { new FormButtonModel { Label = "Raise", Type = "submit", Role = "submit", Locator = TestId("invoice-submit") } }
        };

        var task = Design(invoice).HumanTasks.Single(t => t.Key.Contains("unique-reference"));

        task.Steps.Should().Contain("submit it again with the same");
        task.Expected.Should().Contain("If it is not, both are accepted and that is correct");
    }

    [Fact]
    public void An_ordinary_field_raises_no_uniqueness_question()
    {
        // The near misses are excluded deliberately: a name is a person's or a product's, and
        // asking about every text field would make the answer sheet longer than the report.
        var form = new DiscoveredFormModel
        {
            Name = "Add a customer", Method = "post", Action = "/customers/new",
            HasFormElement = true, Locator = TestId("customer-form"),
            Fields = new()
            {
                Field("name", "text", true),
                Field("contactEmail", "email", true),
                Field("pieces", "number", false)
            },
            Buttons = new() { new FormButtonModel { Label = "Add", Type = "submit", Role = "submit", Locator = TestId("customer-submit") } }
        };

        var design = Design(form);

        design.HumanTasks.Should().NotContain(task => task.Key.Contains("unique-"));
        design.Gaps.Should().NotContain(gap => gap.Missing.Contains("a uniqueness check"));
    }

    [Fact]
    public void A_filter_form_raises_no_uniqueness_question_because_it_creates_nothing()
    {
        var filter = new DiscoveredFormModel
        {
            Name = "Invoice filters", Method = "get", Action = "/billing/invoices",
            HasFormElement = true, Locator = TestId("invoice-filters"),
            Fields = new() { Field("reference", "text", false) },
            Buttons = new() { new FormButtonModel { Label = "Apply", Type = "submit", Role = "submit", Locator = TestId("invoice-apply") } }
        };

        Design(filter).HumanTasks.Should().NotContain(task => task.Key.Contains("unique-"));
    }

    private static FormDesign Design(DiscoveredFormModel form, TestingProfile? profile = null, bool credentials = false,
        IReadOnlyList<CorrelatedEndpoint>? endpoints = null)
        => FormTestDesigner.Design(new FormDesignContext(Guid.Parse("11111111-1111-1111-1111-111111111111"), form,
            "http://lab/registration", "/registration", form.Name, credentials,
            endpoints ?? Array.Empty<CorrelatedEndpoint>(), profile ?? new TestingProfile()));

    /// <summary>The same design, told what discovery saw on the form's page.</summary>
    private static FormDesign DesignOnPageShowing(DiscoveredFormModel form, params string[] stateWords)
        => FormTestDesigner.Design(new FormDesignContext(Guid.Parse("11111111-1111-1111-1111-111111111111"), form,
            "http://lab/registration", "/registration", form.Name, false, Array.Empty<CorrelatedEndpoint>(),
            new TestingProfile(), stateWords));

    /// <summary>The registration form with its submit withheld, as discovery records a
    /// control a rule or a permission will not let this identity press.</summary>
    private static DiscoveredFormModel WithWithheldSubmit(bool disabled = true, bool visible = true)
    {
        var form = Registration();
        return form with
        {
            Buttons = new()
            {
                new FormButtonModel
                {
                    Label = "Create account", Type = "submit", Role = "submit",
                    Locator = TestId("registration-submit"), Disabled = disabled, Visible = visible
                }
            }
        };
    }

    [Fact]
    public void A_control_the_page_withholds_is_asked_of_the_server_too()
    {
        // The authorization counterpart of the server-enforcement pair. A disabled submit
        // is a rule the page keeps; whether anything else keeps it is a different question,
        // and the only evidence for it is the control that is not there.
        var step = Design(WithWithheldSubmit()).Tests
            .SelectMany(t => t.Steps)
            .Should().ContainSingle(s => s.Action == BrowserActionType.AssertHiddenMeansForbidden).Subject;

        step.Value.Should().NotBeNullOrWhiteSpace();

        // The same grammar trap the server-enforcement payload fell into: a strategy spelled
        // the wrong way resolves to nothing, the oracle falls back to the first form on the
        // page, and a wrong submission gets refused — which reads here as the permission
        // being enforced. Both locators have to round-trip through the worker's converter.
        var decoded = JsonSerializer.Deserialize<HiddenControlStep>(step.Value!, JsonDefaults.Options);
        decoded!.Control.Strategy.Should().Be(LocatorStrategy.TestId);
        decoded.Control.Value.Should().Be("registration-submit");
        decoded.Form.Strategy.Should().Be(LocatorStrategy.TestId);
        decoded.Form.Value.Should().Be("registration-form");
        decoded.Capability.Should().Contain("Create account");
    }

    [Fact]
    public void A_control_the_page_offers_raises_no_authorization_question()
    {
        // Nothing is being withheld, so there is no rule to check the server against. A
        // step here would pass because there was nothing to find, which is worse than no
        // step: it reads as coverage.
        Design(Registration()).Tests
            .Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertHiddenMeansForbidden));
    }

    [Fact]
    public void A_submit_that_is_hidden_rather_than_disabled_counts_the_same()
    {
        Design(WithWithheldSubmit(disabled: false, visible: false)).Tests
            .Should().Contain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertHiddenMeansForbidden));
    }

    [Fact]
    public void A_filter_raises_no_authorization_question_whatever_its_controls_do()
    {
        // A GET form that changes nothing has no permission to enforce, so a refusal would
        // mean nothing and an acceptance even less.
        var filter = SearchBox();
        var withheld = filter with
        {
            Buttons = new()
            {
                new FormButtonModel { Label = "Search", Type = "submit", Role = "submit", Disabled = true,
                    Locator = TestId("customer-search-submit") }
            }
        };

        Design(withheld).Tests
            .Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertHiddenMeansForbidden));
    }

    [Fact]
    public void A_record_in_a_terminal_state_is_asked_whether_the_server_will_move_it_on()
    {
        var step = DesignOnPageShowing(Registration(), "Rejected").Tests
            .SelectMany(t => t.Steps)
            .Should().ContainSingle(s => s.Action == BrowserActionType.AssertStateForbidsAction).Subject;

        var decoded = JsonSerializer.Deserialize<StateForbidsStep>(step.Value!, JsonDefaults.Options);
        decoded!.State.Should().Be("rejected");
        decoded.Form.Strategy.Should().Be(LocatorStrategy.TestId);
        decoded.Form.Value.Should().Be("registration-form");
    }

    [Fact]
    public void A_state_the_page_does_not_show_designs_no_test()
    {
        // The premise has to be established by discovery, not guessed. A step that opens by
        // asking about a state the record is not in would fail on every run for a reason
        // that is the designer's fault.
        DesignOnPageShowing(Registration()).Tests
            .Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertStateForbidsAction));

        DesignOnPageShowing(Registration(), "Active", "Pending").Tests
            .Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertStateForbidsAction));
    }

    [Fact]
    public void A_state_a_record_can_legitimately_be_acted_on_from_designs_no_test()
    {
        // "Completed" and "settled" are terminal without being closed: plenty of workflows
        // act on a completed record, and a check that fired on them would be noise.
        DesignOnPageShowing(Registration(), "Completed", "Settled").Tests
            .Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertStateForbidsAction));
    }

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
        // A refusal is checked in the browser and then asked for again at the endpoint, in
        // that order: the second step only means anything once the first has established
        // that the page refuses these values.
        below.Steps.Should().Contain(s => s.Action == BrowserActionType.AssertFormRejected);
        below.Steps.Last().Action.Should().Be(BrowserActionType.AssertServerEnforces);
        var verbs = below.Steps.Select(s => s.Action).ToList();
        verbs.IndexOf(BrowserActionType.AssertFormRejected)
            .Should().BeLessThan(verbs.IndexOf(BrowserActionType.AssertServerEnforces));
        design.Tests.Single(t => t.FieldKey == "age" && t.Technique == "max").Steps.Last().Action.Should().Be(BrowserActionType.AssertFormAccepted);
    }

    /// <summary>
    /// A rule enforced in the browser alone is not enforced, so every refusal the engine
    /// checks in the page is asked for again at the endpoint — but only where that question
    /// has an answer. These are the cases where it does not, and asking anyway would
    /// manufacture failures: a GET search box enforces nothing, and a form whose action
    /// discovery never saw cannot be addressed at all.
    /// </summary>
    [Fact]
    public void A_refusal_is_checked_at_the_endpoint_too_but_only_where_that_means_something()
    {
        var posts = Design(Registration());
        posts.Tests.Should().Contain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertServerEnforces),
            "a form that posts has an endpoint whose enforcement can be checked");

        // Every server step names the form it is to serialise, and follows a browser-side
        // refusal in the same test. One without the other says nothing.
        foreach (var test in posts.Tests.Where(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertServerEnforces)))
        {
            var verbs = test.Steps.Select(s => s.Action).ToList();
            verbs.IndexOf(BrowserActionType.AssertFormRejected).Should().BeGreaterThanOrEqualTo(0,
                $"{test.Technique} asks the endpoint without first establishing the browser refuses");
            verbs.IndexOf(BrowserActionType.AssertFormRejected)
                .Should().BeLessThan(verbs.IndexOf(BrowserActionType.AssertServerEnforces));

            // The payload names the form to serialise off the live page. Without it the
            // oracle would rebuild the submission from the plan and drop the anti-forgery
            // token, and the refusal that follows would be read as the server enforcing.
            var step = test.Steps.First(s => s.Action == BrowserActionType.AssertServerEnforces);
            step.Value.Should().NotBeNullOrWhiteSpace();
            step.Value.Should().Contain("registration-form");

            // The strategy has to be spelled the way the worker's locator grammar spells
            // it. Hand-building this JSON produced "testid", which matches no strategy at
            // all: the oracle fell back to the first form on the page, so on any page with
            // two forms it sent the wrong submission — and a wrong submission gets refused,
            // which this check would have reported as the server enforcing the rule. 398
            // steps in a measurement run were about to be exactly that.
            using var payload = JsonDocument.Parse(step.Value!);
            payload.RootElement.GetProperty("form").GetProperty("strategy").GetString()
                .Should().Be("testId", "the wire spelling is camelCase, not lowercase");

            // Read back through the same converter the worker uses. A strategy that does
            // not round-trip is one the worker cannot resolve.
            var decoded = JsonSerializer.Deserialize<ServerEnforcementStep>(step.Value!, JsonDefaults.Options);
            decoded!.Form.Strategy.Should().Be(LocatorStrategy.TestId);
            decoded.Form.Value.Should().Be("registration-form");
        }

        Design(SearchBox()).Tests
            .Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertServerEnforces),
                "a GET search box enforces no rule, so there is nothing for the server to hold");

        var noAction = Registration() with { Action = null };
        Design(noAction).Tests
            .Should().NotContain(t => t.Steps.Any(s => s.Action == BrowserActionType.AssertServerEnforces),
                "a form whose action was never discovered cannot be submitted directly");
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

    /// <summary>
    /// The shape the previous rule missed: a sign-in form that marks nothing required and
    /// declares no autocomplete, which is what an application validating on the server
    /// produces. The password came from configuration and the username was synthesised, so
    /// every test expecting a successful sign-in failed against a form that works.
    /// </summary>
    [Fact]
    public void A_sign_in_form_that_marks_nothing_required_still_gets_the_configured_username()
    {
        var login = new DiscoveredFormModel
        {
            Key = "signin", Name = "Clinic Scheduler", Action = null, Method = "post", NoValidate = true,
            Locator = Css("form#signin"),
            Fields = new()
            {
                Field("username", "text", required: false, label: "Username"),
                Field("password", "password", required: false, label: "Password")
            },
            Buttons = new() { new FormButtonModel { Label = "Sign in", Type = "submit", Role = "submit", Locator = TestId("signin-submit") } }
        };

        var design = Design(login, credentials: true);
        var happy = design.Tests.Should().ContainSingle(t => t.Technique == "happy-path").Subject;
        happy.Steps.Should().Contain(s => s.Value == "${secret:app_username}");
        happy.Steps.Should().Contain(s => s.Value == "${secret:app_password}");
        happy.Steps.Should().NotContain(s => s.Value != null && s.Value.Contains("QA NXT"));
    }

    /// <summary>
    /// The other side of naming the username field: an extra text field on a sign-in form
    /// is not the username and must not be given it.
    /// </summary>
    [Fact]
    public void A_second_text_field_on_a_sign_in_form_is_not_given_the_username()
    {
        var login = new DiscoveredFormModel
        {
            Key = "signin", Name = "Sign in", Action = "http://lab/login", Method = "post", NoValidate = true,
            Locator = TestId("signin-form"),
            Fields = new()
            {
                Field("tenant", "text", label: "Organisation code"),
                Field("email", "text", label: "Email"),
                Field("password", "password", autocomplete: "current-password")
            },
            Buttons = new() { new FormButtonModel { Label = "Sign in", Type = "submit", Role = "submit", Locator = TestId("signin-submit") } }
        };

        var happy = Design(login, credentials: true).Tests
            .Should().ContainSingle(t => t.Technique == "happy-path").Subject;
        var username = happy.Steps.Where(s => s.Value == "${secret:app_username}").ToList();
        username.Should().HaveCount(1, "only the field that names itself the user is the username");
        username[0].Description.Should().Contain("Email");
    }

    /// <summary>
    /// A form with no action, on a page that calls one write endpoint, is correlated to it.
    /// On a page that calls several, it is not correlated to any: the booking form on a
    /// client-rendered scheduler was given /api/session, the sign-in, because that was the
    /// first non-GET call its page made, and three tests then asserted against an endpoint
    /// the form has nothing to do with.
    /// </summary>
    [Fact]
    public void One_write_endpoint_on_the_page_is_the_form_s_endpoint()
    {
        var form = ActionlessForm();
        var design = Design(form, endpoints: new[] { new CorrelatedEndpoint("GET", "/api/me"), new CorrelatedEndpoint("POST", "/api/slots") });

        var api = design.Tests.Should().ContainSingle(t => t.Technique == "valid-reaches-endpoint").Subject;
        api.Name.Should().Contain("/api/slots");
    }

    [Fact]
    public void Several_write_endpoints_on_the_page_name_none_of_them_and_say_why()
    {
        var form = ActionlessForm();
        var design = Design(form, endpoints: new[]
        {
            new CorrelatedEndpoint("POST", "/api/session"),
            new CorrelatedEndpoint("POST", "/api/appointments")
        });

        design.Tests.Should().NotContain(t => t.Name.Contains("/api/session"),
            "naming one of two is a guess, and this one is the sign-in");
        var gap = design.Gaps.Should().ContainSingle(g => g.Missing.Contains("endpoint")).Subject;
        gap.Reason.Should().Contain("/api/session").And.Contain("/api/appointments");
    }

    private static DiscoveredFormModel ActionlessForm() => new()
    {
        Key = "book", Name = "Book", Action = null, Method = "post", NoValidate = true,
        Locator = TestId("book-form"),
        Fields = new() { Field("who", "text", required: true, label: "Name") },
        Buttons = new() { new FormButtonModel { Label = "Book", Type = "submit", Role = "submit", Locator = TestId("book-submit") } }
    };

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
    public void A_form_hidden_behind_nothing_gets_no_tests_and_says_why()
    {
        // Every test of a form nobody can open waits for an invisible field and times out,
        // which a report then reads as a slow application.
        var design = Design(Registration() with { HiddenAtLoad = true, Opener = null });
        design.Tests.Should().BeEmpty();
        design.Gaps.Should().ContainSingle(g => g.Missing == "a way to open the form");
        design.HumanTasks.Should().ContainSingle(t => t.Title.Contains("open and submit"));
    }

    [Fact]
    public void A_form_behind_an_opener_is_opened_before_each_test_uses_it()
    {
        var opener = new FormOpenerModel { Label = "Contact us", Locator = TestId("contact-open") };
        var design = Design(Registration() with { HiddenAtLoad = true, Opener = opener });
        design.Tests.Should().NotBeEmpty();

        foreach (var test in design.Tests)
        {
            // Every step that uses the form comes after an opener press, from the page's load
            // (or reload before submitting, or return) onwards.
            var steps = test.Steps.ToList();
            var open = false;
            var submitted = false;
            foreach (var step in steps)
            {
                if (step.Action == BrowserActionType.Navigate || step.Action == BrowserActionType.GoBack) { open = false; submitted = false; continue; }
                if (step.Action == BrowserActionType.Reload) { if (!submitted) open = false; continue; }
                if (step.Target?.Value == "contact-open") { open = true; continue; }
                var usesForm = step.Target is not null && step.Action != BrowserActionType.SetViewport;
                if (usesForm && !submitted) open.Should().BeTrue($"{test.Name}: \"{step.Description}\" needs the form open");
                if (step.Target?.Value == "registration-submit" || step.Action == BrowserActionType.Press) submitted = true;
            }
        }
        var responsive = design.Tests.First(t => t.Category == TestCategory.Responsive && t.Steps.Any(s => s.Action == BrowserActionType.AssertVisible)).Steps.ToList();
        responsive.FindIndex(s => s.Target?.Value == "contact-open").Should().BeGreaterThan(responsive.FindIndex(s => s.Action == BrowserActionType.AssertNoHorizontalScroll),
            "the page is measured as it loads, then the form is opened to check its fields");
        var refresh = design.Tests.Single(t => t.Technique == "refresh-after-submit").Steps.ToList();
        refresh.Skip(refresh.FindIndex(s => s.Action == BrowserActionType.Reload)).Should().NotContain(s => s.Target != null && s.Target.Value == "contact-open",
            "a reload after submitting shows the result page, which has no opener");
        design.Tests.Single(t => t.Technique == "page-load").Steps.Should().NotContain(s => s.Target != null && s.Target.Value == "contact-open",
            "measuring the page load does not need the form open");
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
