using System.Text.Json;
using QaNxt.Application.Forms;
using QaNxt.Application.Security;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>
/// The body the write checks send.
///
/// Worth pinning because the failure was silent in the worst way: the checks sent `{}`, every
/// form endpoint that validates its fields refused it, and each check correctly reported that
/// it could reach no verdict. Nothing failed, nothing was red, and 37 endpoints on a
/// server-rendered application — one of them a planted missing-token defect — were simply
/// never evaluated. A suite of 1789 tests had nothing to say about it.
/// </summary>
public class FormRequestShapeTests
{
    private static FormFieldModel Field(
        string name, string controlType = "text", bool required = true,
        string? defaultValue = null, params string[] options)
        => new()
        {
            Key = name, Name = name, Label = name, ControlType = controlType,
            Required = required, DefaultValue = defaultValue,
            Options = options.Select(o => new FormOptionModel { Value = o, Label = o }).ToList()
        };

    private static DiscoveredFormModel Form(
        IEnumerable<FormFieldModel> fields, string? enctype = null,
        params string[] hiddenFieldNames)
        => new()
        {
            Key = "f1", Name = "form", Method = "post", Action = "/warehouse/stock/s-1/adjust",
            Enctype = enctype, Fields = fields.ToList(),
            HiddenFieldNames = hiddenFieldNames.ToList()
        };

    [Fact]
    public void Fills_every_required_field_the_form_declares()
    {
        var shape = FormRequestShape.Of(Form(new[]
        {
            Field("delta", "number"),
            Field("reason", "select", options: new[] { "", "Damage", "Theft or loss" }),
            Field("note", "textarea", required: false)
        }));

        shape.Should().NotBeNull();
        shape!.Fields.Should().ContainKey("delta");
        shape.Fields.Should().ContainKey("reason");
        // The placeholder option is not a choice: a form whose select defaults to "Choose a
        // reason" is refused by the application that declared the field required.
        shape.Fields["reason"].Should().Be("Damage");
        shape.ContentType.Should().Be("application/x-www-form-urlencoded");
    }

    [Fact]
    public void Leaves_the_anti_forgery_token_out_of_the_body_and_names_the_field()
    {
        var shape = FormRequestShape.Of(Form(
            new[] { Field("delta", "number") },
            hiddenFieldNames: new[] { "_csrf", "step" }));

        shape.Should().NotBeNull();
        // The probe has to be able to send this request *without* a token. A sample that
        // carried one would make the probe identical to the control, and the check would
        // report a missing token on an application that enforces it.
        shape!.Fields.Should().NotContainKey("_csrf");
        shape.TokenField.Should().Be("_csrf");
    }

    [Theory]
    [InlineData("csrf_token")]
    [InlineData("authenticity_token")]
    [InlineData("__RequestVerificationToken")]
    [InlineData("X-XSRF-TOKEN")]
    public void Recognises_the_token_field_by_the_same_names_discovery_does(string name)
    {
        var shape = FormRequestShape.Of(Form(
            new[] { Field("delta", "number") }, hiddenFieldNames: new[] { name }));

        shape!.TokenField.Should().Be(name);
    }

    [Fact]
    public void Carries_what_the_page_already_has_rather_than_inventing_a_value()
    {
        var shape = FormRequestShape.Of(Form(new[]
        {
            Field("site", "select", defaultValue: "FXT", options: new[] { "FXT", "DUB" })
        }));

        shape!.Fields["site"].Should().Be("FXT");
    }

    [Fact]
    public void Two_selects_over_the_same_list_do_not_take_the_same_option()
    {
        // A transfer form's "From site" and "To site" are the same list of warehouses. An
        // application that refuses a transfer from Felixstowe to Felixstowe is right to, and
        // the check would read that correct refusal as the endpoint declining the request.
        var shape = FormRequestShape.Of(Form(new[]
        {
            Field("from", "select", options: new[] { "FXT", "DUB", "MCR" }),
            Field("to", "select", options: new[] { "FXT", "DUB", "MCR" })
        }));

        shape!.Fields["from"].Should().NotBe(shape.Fields["to"]);
    }

    [Fact]
    public void A_list_too_short_to_go_round_repeats_rather_than_giving_up()
    {
        var shape = FormRequestShape.Of(Form(new[]
        {
            Field("a", "select", options: new[] { "ONE" }),
            Field("b", "select", options: new[] { "ONE" })
        }));

        // No body at all is worse than one the application may refuse, and a duplicate is
        // something it has to cope with anyway.
        shape!.Fields["a"].Should().Be("ONE");
        shape.Fields["b"].Should().Be("ONE");
    }

    [Fact]
    public void A_file_input_is_left_out_and_recorded_as_unfilled()
    {
        var shape = FormRequestShape.Of(Form(new[]
        {
            Field("title"),
            Field("document", "file", required: false)
        }));

        shape!.Fields.Should().NotContainKey("document");
        shape.Unfilled.Should().Contain("document");
    }

    [Fact]
    public void No_body_at_all_when_a_required_field_has_no_value_the_engine_believes_in()
    {
        // A required select with nothing to choose. Guessing would send a body the
        // application refuses, and the check cannot tell a refusal it caused from one the
        // application would have made anyway.
        var shape = FormRequestShape.Of(Form(new[]
        {
            Field("reason", "select", options: new[] { "" })
        }));

        shape.Should().BeNull();
    }

    [Fact]
    public void A_disabled_control_is_not_submitted()
    {
        var disabled = Field("ignored") with { Disabled = true };
        var shape = FormRequestShape.Of(Form(new[] { Field("delta", "number"), disabled }));

        shape!.Fields.Should().NotContainKey("ignored");
    }

    [Fact]
    public void A_control_with_no_name_is_not_submitted()
    {
        var unnamed = Field("x") with { Name = null };
        var shape = FormRequestShape.Of(Form(new[] { Field("delta", "number"), unnamed }));

        shape!.Fields.Keys.Should().BeEquivalentTo(new[] { "delta" });
    }

    [Fact]
    public void An_unchecked_optional_box_is_simply_not_sent()
    {
        var shape = FormRequestShape.Of(Form(new[]
        {
            Field("delta", "number"),
            Field("urgent", "checkbox", required: false)
        }));

        shape!.Fields.Should().NotContainKey("urgent");
    }

    [Fact]
    public void A_multipart_form_is_narrowed_to_urlencoded_rather_than_echoed()
    {
        // Sending a multipart content type with a urlencoded body is a request no browser
        // makes. The file part is not what these checks are asking about.
        var shape = FormRequestShape.Of(Form(
            new[] { Field("title") }, enctype: "multipart/form-data"));

        shape!.ContentType.Should().Be("application/x-www-form-urlencoded");
    }

    [Fact]
    public void The_sample_is_json_the_surface_can_already_store_and_read()
    {
        var shape = FormRequestShape.Of(Form(new[] { Field("delta", "number") }));
        var json = FormRequestShape.ToSampleJson(shape!);

        var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
        parsed.Should().ContainKey("delta");
    }

    [Fact]
    public void No_form_is_no_shape_rather_than_an_empty_one()
    {
        FormRequestShape.Of(null).Should().BeNull();
        FormRequestShape.Of(DiscoveredFormModel.FromJson("not json")).Should().BeNull();
    }

    [Fact]
    public void A_numeric_field_gets_an_ordinary_value_not_the_midpoint_of_its_range()
    {
        // The midpoint is the right choice for a form test and the wrong one for a request
        // whose only job is to be accepted: the midpoint of a symmetric range is zero, and
        // zero is the value business rules exclude more often than any other.
        //
        // Freight's stock adjustment declares min="-100000" max="100000" step="1". The
        // midpoint is exactly 0, the handler answers "Enter a whole number other than zero"
        // and redirects back to the form, and the anti-forgery check correctly reported that
        // the endpoint had not accepted its request.
        var delta = Field("delta", "number") with
        {
            Constraints = new Dictionary<string, string>
                { ["min"] = "-100000", ["max"] = "100000", ["step"] = "1" }
        };

        var shape = FormRequestShape.Of(Form(new[] { delta }));

        shape!.Fields["delta"].Should().Be("1");
    }

    [Fact]
    public void A_range_that_excludes_one_still_gets_a_value_inside_it()
    {
        var quantity = Field("quantity", "number") with
        {
            Constraints = new Dictionary<string, string>
                { ["min"] = "50", ["max"] = "100", ["step"] = "1" }
        };

        var shape = FormRequestShape.Of(Form(new[] { quantity }));

        var value = decimal.Parse(shape!.Fields["quantity"]);
        value.Should().BeInRange(50, 100);
    }

    [Fact]
    public void A_step_that_one_does_not_land_on_falls_back_rather_than_sending_an_invalid_value()
    {
        var amount = Field("amount", "number") with
        {
            Constraints = new Dictionary<string, string>
                { ["min"] = "0", ["max"] = "100", ["step"] = "25" }
        };

        var shape = FormRequestShape.Of(Form(new[] { amount }));

        // 1 is not on a step of 25, so the synthesizer's own choice is used.
        var value = decimal.Parse(shape!.Fields["amount"]);
        (value % 25).Should().Be(0);
    }
}
