using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Projects;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Notifications;

/// <summary>Where the console lives, so a message can carry a link to the run.</summary>
/// <remarks>
/// A record rather than IConfiguration because the Application layer does not read
/// configuration — the composition root does, and passes the answer in. Null is a valid
/// value: a deployment with no console URL sends messages with no link rather than a
/// message with a link to nowhere.
/// </remarks>
public sealed record NotificationOptions(string? ConsoleBaseUrl);

public interface INotificationService
{
    /// <summary>
    /// Tells whoever is configured to care, and records whether they were told.
    /// </summary>
    /// <remarks>
    /// Never throws. A channel being down is an ordinary outcome; letting it propagate
    /// would mean a Slack outage turning a passing run into an errored one, which is a
    /// worse failure than the missed message.
    /// </remarks>
    Task NotifyAsync(NotificationMessage message, CancellationToken ct = default);

    /// <summary>Sends a test message to one integration, and returns what happened.</summary>
    /// <remarks>
    /// The only way to find out whether a webhook works is to send to it. Without this,
    /// the first real delivery is the test, and it happens at the moment somebody needed
    /// the message.
    /// </remarks>
    Task<Result<NotificationResult>> TestAsync(Guid integrationId, CancellationToken ct = default);
}

/// <summary>
/// Decides what is worth telling somebody, and dispatches it.
/// </summary>
/// <remarks>
/// <para>
/// The <c>Integration</c> entity has existed since the first migration with no service
/// behind it — the same state schedules were in. Nothing read it, so nothing was ever sent.
/// </para>
/// <para>
/// What to send is decided here and nowhere else. Providers render; they do not choose. A
/// message carries a verdict, some counts and a link — never evidence, never a credential,
/// never a header. Anybody who needs more follows the link and authenticates.
/// </para>
/// </remarks>
public sealed class NotificationService : INotificationService
{
    /// <summary>Events an integration receives when nobody has said otherwise.</summary>
    /// <remarks>
    /// Failures and blocks, not successes. A channel that posts every green build is one
    /// nobody reads by the second week, and the failure they needed scrolls past with it.
    /// <see cref="NotificationEventKind.RunPassed"/> is available and has to be asked for.
    /// </remarks>
    public static readonly IReadOnlySet<NotificationEventKind> DefaultEvents =
        new HashSet<NotificationEventKind>
        {
            NotificationEventKind.RunFailed,
            NotificationEventKind.QualityGateBlocked,
            NotificationEventKind.BreakingContractChange,
            NotificationEventKind.ScheduleDisabled,
            // On by default. A team that configured notifications and then had a fixed
            // vulnerability come back without being told would be right to ask why they
            // had to opt in, and these two fire rarely enough not to become noise.
            NotificationEventKind.SecurityCriticalFinding,
            NotificationEventKind.SecurityRegression
        };

    private readonly IQaNxtDbContext _db;
    private readonly IEnumerable<INotificationProvider> _providers;
    private readonly ISecretProtector _protector;
    private readonly IClock _clock;
    private readonly ILogger<NotificationService> _logger;
    private readonly string? _consoleUrl;

    public NotificationService(IQaNxtDbContext db, IEnumerable<INotificationProvider> providers,
        ISecretProtector protector, IClock clock, ILogger<NotificationService> logger,
        NotificationOptions options)
    {
        _db = db;
        _providers = providers;
        _protector = protector;
        _clock = clock;
        _logger = logger;
        _consoleUrl = options.ConsoleBaseUrl?.TrimEnd('/');
    }

    public async Task NotifyAsync(NotificationMessage message, CancellationToken ct = default)
    {
        try
        {
            var integrations = await _db.Integrations
                .Where(i => i.ProjectId == message.ProjectId && i.IsEnabled)
                .ToListAsync(ct);

            var wanted = integrations.Where(i => Subscribes(i, message.Event)).ToList();
            if (wanted.Count == 0) return;

            // The link is added here rather than by each caller, so every channel points at
            // the same place and a caller cannot forget it.
            var enriched = message.Url is null && message.TestRunId is not null && _consoleUrl is not null
                ? message with { Url = $"{_consoleUrl}/runs/{message.TestRunId}" }
                : message;

            foreach (var integration in wanted)
            {
                await DispatchAsync(integration, enriched, ct);
            }
        }
        catch (Exception exception)
        {
            // Deliberately swallowed at the top. Everything below already records its own
            // failures; anything that reaches here is a defect in the notifier itself, and
            // a defect in the notifier must not fail the run that triggered it.
            _logger.LogError(exception, "Notifying about {Event} in project {ProjectId} failed",
                message.Event, message.ProjectId);
        }
    }

    public async Task<Result<NotificationResult>> TestAsync(Guid integrationId, CancellationToken ct = default)
    {
        var integration = await _db.Integrations.FirstOrDefaultAsync(i => i.Id == integrationId, ct);
        if (integration is null) return Error.NotFound("The integration");

        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == integration.ProjectId, ct);

        var message = new NotificationMessage(
            NotificationEventKind.RunPassed,
            "QA NXT test notification",
            "If you are reading this, the integration works. Nothing has failed; somebody pressed test.",
            integration.ProjectId,
            project?.Name ?? "Unknown project",
            Facts: new Dictionary<string, object?> { ["integration"] = integration.Name });

        var result = await DispatchAsync(integration, message, ct, isTest: true);
        return Result<NotificationResult>.Success(result);
    }

    // -----------------------------------------------------------------------

    private async Task<NotificationResult> DispatchAsync(Integration integration,
        NotificationMessage message, CancellationToken ct, bool isTest = false)
    {
        var provider = _providers.FirstOrDefault(p => p.Kind == integration.Kind);
        if (provider is null)
        {
            // A kind with no provider is a configuration a person made that the platform
            // cannot honour. Recorded rather than ignored, so the console can say so.
            var missing = NotificationResult.Failed(
                $"No notification provider is registered for {integration.Kind}.");
            await RecordAsync(integration, message, missing, ct);
            return missing;
        }

        var settings = Read(integration.SettingsJson);
        var credentials = ReadCredentials(integration);

        NotificationResult result;
        try
        {
            result = await provider.SendAsync(message, settings, credentials, ct);
        }
        catch (Exception exception)
        {
            // A provider is expected to return a result rather than throw. One that throws
            // is a defect in the provider, and it is recorded as a delivery failure rather
            // than allowed to reach the caller.
            _logger.LogError(exception, "Notification provider {Kind} threw", integration.Kind);
            result = NotificationResult.Failed($"The {integration.Kind} provider failed: {exception.Message}");
        }

        if (result.Delivered)
        {
            integration.LastUsedAt = _clock.UtcNow;
        }
        else
        {
            _logger.LogWarning(
                "Notification {Event} to {Kind} integration '{Name}' was not delivered: {Detail}",
                message.Event, integration.Kind, integration.Name, result.Detail);
        }

        if (!isTest) await RecordAsync(integration, message, result, ct);
        else await _db.SaveChangesAsync(ct);

        return result;
    }

    private async Task RecordAsync(Integration integration, NotificationMessage message,
        NotificationResult result, CancellationToken ct)
    {
        _db.NotificationDeliveries.Add(new NotificationDelivery
        {
            OrganizationId = integration.OrganizationId,
            ProjectId = integration.ProjectId,
            IntegrationId = integration.Id,
            Event = message.Event,
            Channel = integration.Kind,
            TestRunId = message.TestRunId,
            Title = Truncate(message.Title, 300),
            Delivered = result.Delivered,
            StatusCode = result.StatusCode,
            Detail = result.Detail is null ? null : Truncate(result.Detail, 500),
            AttemptedAt = _clock.UtcNow
        });

        await _db.SaveChangesAsync(ct);
    }

    /// <summary>Whether this integration asked for this event.</summary>
    /// <remarks>
    /// An integration with no <c>events</c> setting gets the defaults. An explicit empty
    /// list means "none", which is a legitimate thing to configure — it keeps an
    /// integration in place, credentials and all, while somebody is fixing a noisy channel.
    /// </remarks>
    public static bool Subscribes(Integration integration, NotificationEventKind kind)
    {
        var settings = Read(integration.SettingsJson);
        if (!settings.TryGetValue("events", out var raw)) return DefaultEvents.Contains(kind);

        var wanted = raw
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(value => value.ToLowerInvariant())
            .ToHashSet();

        return wanted.Contains(kind.ToString().ToLowerInvariant());
    }

    private static Dictionary<string, string> Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new();
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return new();

            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var property in document.RootElement.EnumerateObject())
            {
                values[property.Name] = property.Value.ValueKind == JsonValueKind.String
                    ? property.Value.GetString() ?? string.Empty
                    : property.Value.ToString();
            }
            return values;
        }
        catch (JsonException)
        {
            return new();
        }
    }

    private Dictionary<string, string> ReadCredentials(Integration integration)
    {
        if (string.IsNullOrWhiteSpace(integration.EncryptedCredentials)) return new();
        try
        {
            return Read(_protector.Unprotect(integration.EncryptedCredentials));
        }
        catch (Exception exception)
        {
            // The exception must not carry the ciphertext into a log. What a reader needs
            // is which integration cannot be decrypted, not what it contains.
            _logger.LogError(
                "Integration {IntegrationId} has credentials that cannot be decrypted: {Reason}",
                integration.Id, exception.GetType().Name);
            return new();
        }
    }

    private static string Truncate(string value, int max)
        => value.Length <= max ? value : value[..max];
}
