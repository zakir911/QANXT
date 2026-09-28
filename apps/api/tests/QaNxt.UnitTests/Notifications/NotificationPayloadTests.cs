using System.Text.Json;
using QaNxt.Application.Contracts;
using QaNxt.Application.Notifications;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Projects;
using QaNxt.Infrastructure.Notifications;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Notifications;

/// <summary>
/// What goes on the wire, and what decides whether anything goes at all.
/// </summary>
/// <remarks>
/// Delivery itself is executed against a real receiver in the golden suite (NOT-001 to
/// NOT-008). What is pinned here is the part that is pure: the payload shape a receiver
/// parses, the signature a receiver verifies, and the subscription rule that decides
/// whether a message is sent — each of which is a contract somebody else depends on.
/// </remarks>
public class NotificationPayloadTests
{
    private static readonly Guid ProjectId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid RunId = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private static NotificationMessage Message(
        NotificationEventKind kind = NotificationEventKind.RunFailed) => new(
        kind, "3 test(s) failed in Checkout", "The quality gate passed.",
        ProjectId, "Checkout", RunId, "Nightly",
        Facts: new Dictionary<string, object?> { ["failed"] = 3, ["passed"] = 17 });

    // -----------------------------------------------------------------------
    // The webhook payload
    // -----------------------------------------------------------------------

    [Fact]
    public void The_payload_carries_a_schema_version_a_receiver_can_branch_on()
    {
        // Without it, the only way a receiver finds out the shape changed is by breaking.
        var json = Json(WebhookNotificationProvider.BuildPayload(Message()));
        json.GetProperty("schemaVersion").GetInt32().Should().Be(1);
    }

    [Fact]
    public void The_payload_names_the_event_the_project_and_the_run()
    {
        var json = Json(WebhookNotificationProvider.BuildPayload(Message()));

        json.GetProperty("event").GetString().Should().Be("RunFailed");
        json.GetProperty("severity").GetString().Should().Be("Problem");
        json.GetProperty("project").GetProperty("id").GetGuid().Should().Be(ProjectId);
        json.GetProperty("run").GetProperty("id").GetGuid().Should().Be(RunId);
        json.GetProperty("facts").GetProperty("failed").GetInt32().Should().Be(3);
    }

    [Fact]
    public void A_message_about_no_particular_run_has_no_run_object_rather_than_an_empty_one()
    {
        // A schedule disabling itself is not about a run. `"run": {"id": null}` would make
        // a receiver's `if (payload.run)` true and send it looking for a run that is not there.
        var message = new NotificationMessage(
            NotificationEventKind.ScheduleDisabled, "Schedule stopped", "…", ProjectId, "Checkout");

        var json = Json(WebhookNotificationProvider.BuildPayload(message));

        json.TryGetProperty("run", out var run).Should().BeFalse("a null run is omitted entirely");
    }

    [Theory]
    [InlineData(NotificationEventKind.RunFailed, "Problem")]
    [InlineData(NotificationEventKind.QualityGateBlocked, "Problem")]
    [InlineData(NotificationEventKind.BreakingContractChange, "Problem")]
    [InlineData(NotificationEventKind.ScheduleDisabled, "Warning")]
    [InlineData(NotificationEventKind.RunPassed, "Information")]
    public void Severity_follows_the_event(NotificationEventKind kind, string expected)
        => Json(WebhookNotificationProvider.BuildPayload(Message(kind)))
            .GetProperty("severity").GetString().Should().Be(expected);

    // -----------------------------------------------------------------------
    // The signature
    // -----------------------------------------------------------------------

    [Fact]
    public void The_signature_is_an_hmac_of_the_exact_body_in_the_shape_receivers_already_parse()
    {
        // sha256=<hex>, which is what GitHub sends, so a receiver can reuse code it has.
        var signature = WebhookNotificationProvider.Sign("{\"a\":1}", "secret");

        signature.Should().StartWith("sha256=");
        signature.Should().MatchRegex("^sha256=[0-9a-f]{64}$");
    }

    [Fact]
    public void Changing_one_byte_of_the_body_changes_the_signature()
    {
        WebhookNotificationProvider.Sign("{\"a\":1}", "secret")
            .Should().NotBe(WebhookNotificationProvider.Sign("{\"a\":2}", "secret"));
    }

    [Fact]
    public void Changing_the_secret_changes_the_signature()
    {
        WebhookNotificationProvider.Sign("{\"a\":1}", "secret")
            .Should().NotBe(WebhookNotificationProvider.Sign("{\"a\":1}", "other"));
    }

    [Fact]
    public void The_signature_is_not_the_secret()
    {
        // Stated because it is the whole point: the header goes to the receiver, and a
        // header that contained the secret would hand it to anyone who saw one delivery.
        WebhookNotificationProvider.Sign("{\"a\":1}", "the-secret").Should().NotContain("the-secret");
    }

    // -----------------------------------------------------------------------
    // Slack's shape
    // -----------------------------------------------------------------------

    [Fact]
    public void The_slack_payload_always_has_a_plain_text_fallback()
    {
        // Blocks with no text is silent on a phone and to a screen reader, and a phone is
        // the one place a failed nightly actually needs to arrive.
        var json = Json(SlackNotificationProvider.BuildPayload(Message()));

        json.GetProperty("text").GetString().Should().Contain("3 test(s) failed in Checkout");
        json.GetProperty("blocks").GetArrayLength().Should().BeGreaterThan(0);
    }

    [Fact]
    public void The_slack_payload_escapes_the_characters_slack_treats_as_markup()
    {
        var message = Message() with { Title = "a < b & c > d" };
        var json = Json(SlackNotificationProvider.BuildPayload(message));

        json.GetProperty("text").GetString().Should().Contain("a < b & c > d",
            "the fallback is plain text and is not escaped");

        // Read as a decoded string, not as serialized JSON: System.Text.Json writes an
        // ampersand as \u0026 by default, so a check against the serialized form would be
        // testing the serializer's escaping rather than Slack's.
        var block = json.GetProperty("blocks")[0].GetProperty("text").GetProperty("text").GetString();
        block.Should().Contain("&lt;").And.Contain("&amp;").And.Contain("&gt;");
        block.Should().NotContain("a < b");
    }

    // -----------------------------------------------------------------------
    // Who gets told
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData(NotificationEventKind.RunFailed, true)]
    [InlineData(NotificationEventKind.QualityGateBlocked, true)]
    [InlineData(NotificationEventKind.BreakingContractChange, true)]
    [InlineData(NotificationEventKind.ScheduleDisabled, true)]
    [InlineData(NotificationEventKind.RunPassed, false)]
    public void By_default_failures_are_sent_and_successes_are_not(NotificationEventKind kind, bool expected)
    {
        // A channel that posts every green build is one nobody reads by the second week,
        // and the failure they needed scrolls past with it.
        var integration = new Integration { SettingsJson = "{\"url\":\"https://example.test/hook\"}" };

        NotificationService.Subscribes(integration, kind).Should().Be(expected);
    }

    [Fact]
    public void An_explicit_event_list_replaces_the_defaults_rather_than_adding_to_them()
    {
        var integration = new Integration { SettingsJson = "{\"events\":\"runPassed\"}" };

        NotificationService.Subscribes(integration, NotificationEventKind.RunPassed).Should().BeTrue();
        NotificationService.Subscribes(integration, NotificationEventKind.RunFailed).Should().BeFalse();
    }

    [Fact]
    public void An_empty_event_list_means_none_which_is_a_legitimate_thing_to_configure()
    {
        // It keeps an integration in place, credentials and all, while somebody fixes a
        // noisy channel — without deleting and re-pasting the webhook URL.
        var integration = new Integration { SettingsJson = "{\"events\":\"\"}" };

        foreach (var kind in Enum.GetValues<NotificationEventKind>())
        {
            NotificationService.Subscribes(integration, kind).Should().BeFalse();
        }
    }

    [Fact]
    public void Malformed_settings_fall_back_to_the_defaults_rather_than_silencing_everything()
    {
        // Failing closed here would mean a corrupted settings row silently stops every
        // alert for that project, which is the failure nobody notices.
        var integration = new Integration { SettingsJson = "not json at all" };

        NotificationService.Subscribes(integration, NotificationEventKind.RunFailed).Should().BeTrue();
    }

    private static JsonElement Json(object payload)
        => JsonDocument.Parse(JsonSerializer.Serialize(payload, JsonDefaults.Options)).RootElement;
}
