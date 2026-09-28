using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
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
/// Posts a message as JSON to a URL somebody configured.
/// </summary>
/// <remarks>
/// <para>
/// The plainest possible channel, and the one everything else is a special case of: a
/// Slack incoming webhook, a Teams connector, a PagerDuty events endpoint and a team's own
/// service are all "POST some JSON to this URL". Providing this one honestly is worth more
/// than providing five that have never been sent to anything.
/// </para>
/// <para>
/// <b>An outbound POST to a user-supplied URL is an SSRF primitive</b>, and is treated as
/// one. It goes through the same <see cref="TargetUrlGuard"/> as every URL the platform
/// opens, so a notification cannot be pointed at cloud metadata, at a link-local address,
/// or — unless the deployment allows private networks — at anything inside the network
/// QA NXT runs in. Without that, "configure a webhook" would be "ask QA NXT to fetch a URL for
/// you and tell you what it said", which is a far more useful capability to an attacker
/// than a notification.
/// </para>
/// <para>
/// Deliveries are optionally signed. When a secret is configured the body is HMAC-SHA256'd
/// and sent in <c>X-QaNxt-Signature</c>, so a receiver can tell a real delivery from anyone
/// who learned the URL. The secret never appears in the payload or in a log.
/// </para>
/// </remarks>
public sealed class WebhookNotificationProvider : INotificationProvider
{
    public const string SignatureHeader = "X-QaNxt-Signature";
    public const string EventHeader = "X-QaNxt-Event";

    /// <summary>Long enough for a slow receiver, short enough not to hold a run's tail.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private readonly IHttpClientFactory _clients;
    private readonly ITargetPolicy _targets;
    private readonly ILogger<WebhookNotificationProvider> _logger;

    public WebhookNotificationProvider(IHttpClientFactory clients, ITargetPolicy targets,
        ILogger<WebhookNotificationProvider> logger)
    {
        _clients = clients;
        _targets = targets;
        _logger = logger;
    }

    public IntegrationKind Kind => IntegrationKind.Webhook;

    public async Task<NotificationResult> SendAsync(
        NotificationMessage message,
        IReadOnlyDictionary<string, string> settings,
        IReadOnlyDictionary<string, string> credentials,
        CancellationToken ct = default)
    {
        if (!settings.TryGetValue("url", out var url) || string.IsNullOrWhiteSpace(url))
            return NotificationResult.Failed("No URL is configured for this webhook.");

        // Re-checked at send time, not only when the integration was saved. The allowlist
        // is deployment configuration and can change after the fact, and a check that
        // happened once at configuration time is not a control over what is sent today.
        if (!_targets.IsAllowed(url, Array.Empty<string>(), out var reason))
            return NotificationResult.Failed($"The webhook URL was refused: {reason}.");

        var payload = BuildPayload(message);
        var body = JsonSerializer.Serialize(payload, JsonDefaults.Options);

        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        request.Headers.TryAddWithoutValidation(EventHeader, message.Event.ToString());

        if (credentials.TryGetValue("signingSecret", out var secret) && !string.IsNullOrWhiteSpace(secret))
        {
            request.Headers.TryAddWithoutValidation(SignatureHeader, Sign(body, secret));
        }

        var client = _clients.CreateClient("notifications");
        client.Timeout = Timeout;

        try
        {
            using var response = await client.SendAsync(request, ct);
            var status = (int)response.StatusCode;

            if (response.IsSuccessStatusCode) return NotificationResult.Success(status);

            // A 4xx means the receiver rejected what we sent and will reject it again; a
            // 5xx or a 429 means it could not take it now. Retrying the first for ever is
            // how a queue fills up with messages nobody will ever accept.
            var retryable = status >= 500 || response.StatusCode == HttpStatusCode.TooManyRequests;
            return NotificationResult.Failed(
                $"The receiver answered {status} {response.ReasonPhrase}.", status, retryable);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return NotificationResult.Failed($"The receiver did not answer within {Timeout.TotalSeconds:0}s.",
                retryable: true);
        }
        catch (HttpRequestException exception)
        {
            // The message, not the exception: a stack trace here tells a reader nothing and
            // the message may carry the host, which is what they need.
            return NotificationResult.Failed($"The receiver could not be reached: {exception.Message}",
                retryable: true);
        }
    }

    /// <summary>
    /// What goes on the wire.
    /// </summary>
    /// <remarks>
    /// Flat, stable and small. A receiver keys off <c>event</c> and reads the counts; the
    /// URL is there for a person. Nothing in here is a secret, and there is no field a
    /// future change could put one in without somebody noticing they were adding it.
    ///
    /// Public because it is the contract every receiver parses, and a contract deserves
    /// tests that name it rather than tests that reach through a mocked HTTP client.
    /// </remarks>
    public static object BuildPayload(NotificationMessage message) => new
    {
        schemaVersion = 1,
        @event = message.Event.ToString(),
        severity = message.Severity.ToString(),
        title = message.Title,
        body = message.Body,
        project = new { id = message.ProjectId, name = message.ProjectName },
        run = message.TestRunId is null
            ? null
            : new { id = message.TestRunId, name = message.RunName },
        url = message.Url,
        facts = message.Facts,
        sentAt = DateTimeOffset.UtcNow
    };

    /// <summary>`sha256=<hex>`, the shape GitHub uses, because receivers already parse it.</summary>
    public static string Sign(string body, string secret)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(body));
        return $"sha256={Convert.ToHexString(hash).ToLowerInvariant()}";
    }
}
