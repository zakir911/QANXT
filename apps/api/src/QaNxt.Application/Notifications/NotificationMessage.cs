using QaNxt.Domain.Enums;

namespace QaNxt.Application.Notifications;

/// <summary>
/// One thing to tell somebody, in a shape every provider can render.
/// </summary>
/// <remarks>
/// Providers format this; they never decide what is in it. Keeping the decision here is
/// what stops a Slack message and a webhook payload from disagreeing about whether a run
/// failed, and means a new provider cannot accidentally widen what is disclosed.
///
/// There is no field for a secret, a token, a cookie or a header, and no provider is given
/// the run's evidence. What a notification carries is a verdict, some counts and a link;
/// anybody who needs more follows the link and authenticates like everybody else.
/// </remarks>
public sealed record NotificationMessage(
    NotificationEventKind Event,
    /// <summary>One line, suitable for a phone. "3 tests failed in Checkout (release-2.4)".</summary>
    string Title,
    /// <summary>A few sentences at most. What happened and what to look at.</summary>
    string Body,
    Guid ProjectId,
    string ProjectName,
    Guid? TestRunId = null,
    string? RunName = null,
    string? Url = null,
    /// <summary>Counts and identifiers a machine reader wants. Never anything sensitive.</summary>
    IReadOnlyDictionary<string, object?>? Facts = null)
{
    /// <summary>How loud this is, for providers that can show it.</summary>
    public NotificationSeverity Severity => Event switch
    {
        NotificationEventKind.RunFailed => NotificationSeverity.Problem,
        NotificationEventKind.QualityGateBlocked => NotificationSeverity.Problem,
        NotificationEventKind.BreakingContractChange => NotificationSeverity.Problem,
        NotificationEventKind.ScheduleDisabled => NotificationSeverity.Warning,
        // Problem, not Information. A channel that colour-codes by severity would have
        // rendered a new Critical vulnerability the same shade as a passing build, and the
        // one message in the week worth stopping for would look like the rest.
        NotificationEventKind.SecurityCriticalFinding => NotificationSeverity.Problem,
        NotificationEventKind.SecurityRegression => NotificationSeverity.Problem,
        _ => NotificationSeverity.Information
    };
}

public enum NotificationSeverity { Information = 0, Warning = 1, Problem = 2 }

/// <summary>The outcome of one attempt to deliver one message to one integration.</summary>
public sealed record NotificationResult(
    bool Delivered,
    int? StatusCode,
    string? Detail,
    /// <summary>True when trying again later could succeed: a timeout, a 5xx, a 429.</summary>
    bool Retryable)
{
    public static NotificationResult Success(int? status = null) => new(true, status, null, false);

    public static NotificationResult Failed(string detail, int? status = null, bool retryable = false)
        => new(false, status, detail, retryable);
}

/// <summary>Renders and delivers a message over one kind of channel.</summary>
/// <remarks>
/// A provider receives the message, the integration's non-sensitive settings, and its
/// decrypted credentials. It returns what happened rather than throwing: a channel being
/// down is an ordinary outcome that has to be recorded, not an exception that could
/// propagate into the run that triggered it.
/// </remarks>
public interface INotificationProvider
{
    IntegrationKind Kind { get; }

    Task<NotificationResult> SendAsync(
        NotificationMessage message,
        IReadOnlyDictionary<string, string> settings,
        IReadOnlyDictionary<string, string> credentials,
        CancellationToken ct = default);
}
