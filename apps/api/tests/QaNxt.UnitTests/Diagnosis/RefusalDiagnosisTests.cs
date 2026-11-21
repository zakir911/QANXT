using System.Reflection;
using FluentAssertions;
using QaNxt.Application.Diagnosis;
using QaNxt.Domain.Diagnosis;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;
using Xunit;

namespace QaNxt.UnitTests.Diagnosis;

/// <summary>
/// What a refused submission is a defect about.
///
/// Measured on a 6,344-test run of a freight application: one credit-note form produced
/// twelve defects. The form is shown to an account that may not raise credit notes, and the
/// application says so in the page — "You do not have permission to raise credit notes." —
/// which the oracle captured correctly and the diagnosis then filed twelve times, once per
/// field a test happened to be varying, each titled "refuses a valid submission".
///
/// Two things were wrong. The field a test varies is not what makes a refused submission
/// distinct, and an application refusing an account it told you it would refuse is not a
/// defect in the form's validation.
/// </summary>
public class RefusalDiagnosisTests
{
    private static readonly MethodInfo Signature = typeof(DefectService)
        .GetMethod("Signature", BindingFlags.NonPublic | BindingFlags.Static)!;

    private static (string Key, string Symptom) Diagnose(string message, string? fieldKey, BrowserActionType action)
    {
        var testCase = new TestCase
        {
            OrganizationId = Guid.Empty, ProjectId = Guid.Empty,
            ApplicationFormId = Guid.Parse("44444444-4444-4444-4444-444444444444"),
            Name = "a test", Category = TestCategory.Boundary, FieldKey = fieldKey
        };
        var step = new TestAction { OrganizationId = Guid.Empty, Action = action, Description = "check" };

        var failure = new Failure { OrganizationId = Guid.Empty, RawMessage = message };
        return ((string, string))Signature.Invoke(null, new object?[] { failure, testCase, step, null })!;
    }

    private const string PermissionRefusal =
        "Expected the submission to be accepted, but the form is still shown; fields marked invalid: "
        + "invoiceId, amountGbp, reason; messages: \"You do not have permission to raise credit notes.\"; "
        + "no confirmation is shown; the route did not change from /billing/credit-notes/new?invoice=inv-0004";

    [Fact]
    public void A_refused_submission_is_one_defect_whatever_field_the_test_was_varying()
    {
        var note = Diagnose(PermissionRefusal, "note", BrowserActionType.AssertFormAccepted);
        var amount = Diagnose(PermissionRefusal, "amountGbp", BrowserActionType.AssertFormAccepted);
        var nothing = Diagnose(PermissionRefusal, null, BrowserActionType.AssertFormAccepted);

        note.Key.Should().Be(amount.Key);
        note.Key.Should().Be(nothing.Key,
            "the form refuses the submission; which field a boundary test was varying is incidental");
    }

    [Fact]
    public void Two_different_refusals_on_one_form_are_still_two_defects()
    {
        var permission = Diagnose(PermissionRefusal, "note", BrowserActionType.AssertFormAccepted);
        var silent = Diagnose(
            "Expected the submission to be accepted, but the form is still shown; no field is marked invalid; "
            + "no error message is shown; no confirmation is shown.",
            "note", BrowserActionType.AssertFormAccepted);

        permission.Key.Should().NotBe(silent.Key);
    }

    [Fact]
    public void A_refusal_that_names_a_permission_is_not_called_a_validation_defect()
    {
        Diagnose(PermissionRefusal, "note", BrowserActionType.AssertFormAccepted)
            .Symptom.Should().Contain("will not accept it from")
            .And.Contain("nothing about its rules could be tested");
    }

    [Fact]
    public void A_refusal_about_a_value_is_still_a_validation_defect()
    {
        Diagnose(
            "Expected the submission to be accepted, but the form is still shown; fields marked invalid: "
            + "collectionDate; messages: \"Enter a collection date no earlier than today.\"",
            "collectionDate", BrowserActionType.AssertFormAccepted)
            .Symptom.Should().Be("refuses a valid submission");
    }

    /// <summary>"Not allowed" is deliberately not in the vocabulary: an application that says
    /// a date is not allowed is talking about the value, not about the account.</summary>
    [Fact]
    public void A_message_about_a_value_not_being_allowed_is_not_read_as_a_permission()
    {
        Diagnose(
            "Expected the submission to be accepted, but the form is still shown; messages: "
            + "\"A delivery date before the collection date is not allowed.\"",
            "deliveryDate", BrowserActionType.AssertFormAccepted)
            .Symptom.Should().Be("refuses a valid submission");
    }

    /// <summary>Every other check keeps the field in its signature: two fields whose errors
    /// are not announced are two defects, because each field has to be fixed.</summary>
    [Fact]
    public void Other_checks_still_distinguish_one_field_from_another()
    {
        var first = Diagnose("Expected this field to be reported invalid, but nothing marks it.",
            "email", BrowserActionType.AssertErrorAssociated);
        var second = Diagnose("Expected this field to be reported invalid, but nothing marks it.",
            "postcode", BrowserActionType.AssertErrorAssociated);

        first.Key.Should().NotBe(second.Key);
    }
}
