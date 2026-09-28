using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using QaNxt.Application.Contracts;
using QaNxt.Application.Notifications;
using QaNxt.Application.Applications;
using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using Microsoft.Extensions.Logging;

namespace QaNxt.Infrastructure.Notifications;

/// <summary>
/// Posts a message to a Slack incoming webhook.
/// </summary>
/// <remarks>
/// <para>
/// Mechanically this is the webhook provider with Slack's payload shape: an incoming
/// webhook is a URL you POST JSON to, and the URL is itself the credential, which is why
/// it is stored encrypted rather than in settings.
/// </para>
/// <para>
/// <b>What is verified and what is not.</b> The payload this builds, and that it is
/// delivered, are executed against a local receiver in the golden suite. That a real Slack
/// workspace renders it as intended is <b>not verified</b> — it needs a workspace and a
/// webhook URL, and this repository has neither. The Block Kit structure is written against
/// Slack's documented schema and is not claimed to have been posted to Slack.
/// </para>
/// </remarks>
public sealed class SlackNotificationProvider : INotificationProvider
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private readonly IHttpClientFactory _clients;
    private readonly ITargetPolicy _targets;
    private readonly ILogger<SlackNotificationProvider> _logger;

    public SlackNotificationProvider(IHttpClientFactory clients, ITargetPolicy targets,
        ILogger<SlackNotificationProvider> logger)
    {
        _clients = clients;
        _targets = targets;
        _logger = logger;
    }

    public IntegrationKind Kind => IntegrationKind.Slack;

    public async Task<NotificationResult> SendAsync(
        NotificationMessage message,
        IReadOnlyDictionary<string, string> settings,
        IReadOnlyDictionary<string, string> credentials,
        CancellationToken ct = default)
    {
        // The incoming-webhook URL is the credential — anyone holding it can post to the
        // channel — so it lives in encrypted storage, not in settings the API returns.
        if (!credentials.TryGetValue("webhookUrl", out var url) || string.IsNullOrWhiteSpace(url))
            return NotificationResult.Failed("No incoming-webhook URL is configured for this Slack integration.");

        if (!_targets.IsAllowed(url, Array.Empty<string>(), out var reason))
            return NotificationResult.Failed($"The Slack webhook URL was refused: {reason}.");

        var body = JsonSerializer.Serialize(BuildPayload(message), JsonDefaults.Options);

        var client = _clients.CreateClient("notifications");
        client.Timeout = Timeout;

        try
        {
            using var response = await client.PostAsync(url,
                new StringContent(body, Encoding.UTF8, "application/json"), ct);
            var status = (int)response.StatusCode;

            if (response.IsSuccessStatusCode) return NotificationResult.Success(status);

            var retryable = status >= 500 || response.StatusCode == HttpStatusCode.TooManyRequests;

            // Slack answers 4xx with a plain-text reason ("invalid_token", "channel_not_found")
            // that says exactly what is wrong, and it is worth passing on rather than
            // reporting only the status. It is Slack's text about our request, never a
            // credential.
            var detail = await response.Content.ReadAsStringAsync(ct);
            return NotificationResult.Failed(
                $"Slack answered {status}: {Truncate(detail, 200)}", status, retryable);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return NotificationResult.Failed($"Slack did not answer within {Timeout.TotalSeconds:0}s.",
                retryable: true);
        }
        catch (HttpRequestException exception)
        {
            return NotificationResult.Failed($"Slack could not be reached: {exception.Message}",
                retryable: true);
        }
    }

    /// <summary>
    /// Slack's Block Kit shape, with a plain <c>text</c> fallback.
    /// </summary>
    /// <remarks>
    /// The fallback is not optional: it is what a mobile push notification and a
    /// screen reader use, and a message with blocks and no text is silent on a phone —
    /// which is the one place a failed nightly actually needs to arrive.
    /// </remarks>
    public static object BuildPayload(NotificationMessage message)
    {
        var emoji = message.Severity switch
        {
            NotificationSeverity.Problem => ":red_circle:",
            NotificationSeverity.Warning => ":warning:",
            _ => ":white_check_mark:"
        };

        var blocks = new List<object>
        {
            new
            {
                type = "section",
                text = new { type = "mrkdwn", text = $"{emoji} *{Escape(message.Title)}*\n{Escape(message.Body)}" }
            }
        };

        if (message.Facts is { Count: > 0 })
        {
            blocks.Add(new
            {
                type = "section",
                fields = message.Facts
                    .Where(fact => fact.Value is not null)
                    // Slack renders at most ten fields in a section and drops the rest
                    // silently, so the cut is made here where it can be reasoned about.
                    .Take(10)
                    .Select(fact => new
                    {
                        type = "mrkdwn",
                        text = $"*{Escape(Humanise(fact.Key))}*\n{Escape(fact.Value!.ToString() ?? string.Empty)}"
                    })
                    .ToArray()
            });
        }

        if (!string.IsNullOrWhiteSpace(message.Url))
        {
            blocks.Add(new
            {
                type = "actions",
                elements = new object[]
                {
                    new
                    {
                        type = "button",
                        text = new { type = "plain_text", text = "Open in QA NXT" },
                        url = message.Url
                    }
                }
            });
        }

        return new
        {
            // The fallback, for phones and screen readers.
            text = $"{message.Title} — {message.Body}",
            blocks
        };
    }

    /// <summary>Slack's three mrkdwn metacharacters. Everything else is literal.</summary>
    private static string Escape(string value)
        => value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static string Humanise(string key)
    {
        var spaced = System.Text.RegularExpressions.Regex.Replace(key, "([A-Z])", " $1").Trim();
        return spaced.Length == 0 ? key : char.ToUpperInvariant(spaced[0]) + spaced[1..];
    }

    private static string Truncate(string value, int max)
        => value.Length <= max ? value : value[..max] + "…";
}
