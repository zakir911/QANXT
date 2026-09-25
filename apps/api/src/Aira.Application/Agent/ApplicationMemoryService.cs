using Aira.Application.Abstractions;
using Aira.Application.Security;
using Aira.Domain.Agent;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Agent;

public sealed record RememberRequest(
    ApplicationMemoryKind Kind,
    string Subject,
    string Fact,
    ApplicationMemoryProvenance Provenance,
    int Confidence,
    Guid? RunId = null);

public sealed record MemoryView(
    Guid Id, ApplicationMemoryKind Kind, string Subject, string Fact,
    ApplicationMemoryProvenance Provenance, int Confidence, int TimesSeen,
    DateTimeOffset FirstSeenAt, DateTimeOffset LastSeenAt, bool IsStale);

public interface IApplicationMemoryService
{
    Task<Guid> RememberAsync(Guid applicationId, RememberRequest request, CancellationToken ct = default);
    Task<IReadOnlyList<MemoryView>> RecallAsync(
        Guid applicationId, ApplicationMemoryKind? kind = null, bool includeStale = false,
        CancellationToken ct = default);
    Task<int> ForgetStaleAsync(Guid applicationId, CancellationToken ct = default);
}

/// <summary>
/// What the platform remembers about an application between passes.
/// </summary>
/// <remarks>
/// <para>
/// Three rules hold here, and each one exists because of a way memory goes wrong.
/// </para>
/// <para>
/// <strong>A fact carries where it came from.</strong> An observation and an inference are
/// stored the same way and are not the same thing, so the provenance travels with the fact and
/// the planner is free to treat them differently. An inference is never reported as
/// functionality the application has.
/// </para>
/// <para>
/// <strong>Confidence is capped below certainty.</strong> Nothing here reaches 100. A platform
/// that is certain about an application it last looked at three weeks ago has stopped checking,
/// and the cap is the cheapest way to keep that from being expressible.
/// </para>
/// <para>
/// <strong>Seeing a fact again strengthens it; not seeing it ages it out.</strong> A fact that
/// no pass has confirmed in <see cref="StaleAfterDays"/> is reported stale rather than deleted,
/// because "we used to believe this and have not seen it lately" is information and silence is
/// not.
/// </para>
/// <para>
/// Secrets never land here. The subject and the fact are masked on the way in, and a test
/// asserts it rather than leaving it to whoever writes the next caller.
/// </para>
/// </remarks>
public sealed class ApplicationMemoryService : IApplicationMemoryService
{
    /// <summary>A fact nothing has confirmed for this long is reported as stale.</summary>
    public const int StaleAfterDays = 30;

    /// <summary>The ceiling on confidence. Never 100.</summary>
    public const int MaxConfidence = 95;

    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly SecretMasker _masker;

    public ApplicationMemoryService(IAiraDbContext db, IClock clock, SecretMasker masker)
    {
        _db = db;
        _clock = clock;
        _masker = masker;
    }

    public async Task<Guid> RememberAsync(
        Guid applicationId, RememberRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Subject))
            throw new ArgumentException("A remembered fact needs a subject.", nameof(request));
        if (string.IsNullOrWhiteSpace(request.Fact))
            throw new ArgumentException("A remembered fact needs a fact.", nameof(request));

        var application = await _db.Applications
            .FirstOrDefaultAsync(a => a.Id == applicationId, ct)
            ?? throw new InvalidOperationException($"Application {applicationId} does not exist.");

        var subject = _masker.MaskText(request.Subject.Trim());
        var fact = _masker.MaskText(request.Fact.Trim());
        var confidence = Math.Clamp(request.Confidence, 0, MaxConfidence);
        var now = _clock.UtcNow;

        var existing = await _db.ApplicationMemories.FirstOrDefaultAsync(
            m => m.ApplicationId == applicationId && m.Kind == request.Kind && m.Subject == subject, ct);

        if (existing is null)
        {
            var memory = new ApplicationMemory
            {
                OrganizationId = application.OrganizationId,
                ApplicationId = applicationId,
                Kind = request.Kind,
                Subject = subject,
                Fact = fact,
                Provenance = request.Provenance,
                Confidence = confidence,
                LastConfirmedByRunId = request.RunId,
                FirstSeenAt = now,
                LastSeenAt = now,
                TimesSeen = 1
            };
            _db.ApplicationMemories.Add(memory);
            await _db.SaveChangesAsync(ct);
            return memory.Id;
        }

        existing.Fact = fact;
        existing.LastSeenAt = now;
        existing.TimesSeen += 1;
        existing.LastConfirmedByRunId = request.RunId ?? existing.LastConfirmedByRunId;

        // Provenance only ever improves. A fact first inferred and later observed is now an
        // observation; one observed and later inferred is still an observation, because the
        // earlier sighting did not stop having happened.
        if (request.Provenance < existing.Provenance) existing.Provenance = request.Provenance;

        // Seeing it again is weak evidence, so it is worth a little and capped hard. Anything
        // stronger would let a fact the platform re-derives every pass climb to near-certainty
        // without anybody ever re-checking the application.
        existing.Confidence = Math.Clamp(Math.Max(existing.Confidence, confidence) + 2, 0, MaxConfidence);

        await _db.SaveChangesAsync(ct);
        return existing.Id;
    }

    public async Task<IReadOnlyList<MemoryView>> RecallAsync(
        Guid applicationId, ApplicationMemoryKind? kind = null, bool includeStale = false,
        CancellationToken ct = default)
    {
        var cutoff = _clock.UtcNow.AddDays(-StaleAfterDays);

        var query = _db.ApplicationMemories.Where(m => m.ApplicationId == applicationId);
        if (kind is { } k) query = query.Where(m => m.Kind == k);
        if (!includeStale) query = query.Where(m => m.LastSeenAt >= cutoff);

        var memories = await query
            .OrderByDescending(m => m.Confidence)
            .ThenByDescending(m => m.LastSeenAt)
            .ToListAsync(ct);

        return memories.Select(m => new MemoryView(
            m.Id, m.Kind, m.Subject, m.Fact, m.Provenance, m.Confidence, m.TimesSeen,
            m.FirstSeenAt, m.LastSeenAt, IsStale: m.LastSeenAt < cutoff)).ToList();
    }

    /// <summary>
    /// Removes facts nothing has confirmed in a long time.
    /// </summary>
    /// <remarks>
    /// Separate from recall, and never automatic during a pass. Forgetting is a change to what
    /// the platform believes, and a pass that quietly dropped half its memory while planning
    /// would produce a plan nobody could reproduce.
    /// </remarks>
    public async Task<int> ForgetStaleAsync(Guid applicationId, CancellationToken ct = default)
    {
        var cutoff = _clock.UtcNow.AddDays(-StaleAfterDays * 2);
        var stale = await _db.ApplicationMemories
            .Where(m => m.ApplicationId == applicationId && m.LastSeenAt < cutoff)
            .ToListAsync(ct);

        if (stale.Count == 0) return 0;
        _db.ApplicationMemories.RemoveRange(stale);
        await _db.SaveChangesAsync(ct);
        return stale.Count;
    }
}
