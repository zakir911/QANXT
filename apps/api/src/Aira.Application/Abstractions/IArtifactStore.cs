namespace Aira.Application.Abstractions;

public sealed record StoredArtifact(string StorageKey, long SizeBytes, string Sha256, string ContentType);

/// <summary>Binary persistence for screenshots, traces, video, HAR and large logs.
/// Content-addressed so identical artifacts deduplicate. Never PostgreSQL.</summary>
public interface IArtifactStore
{
    Task<StoredArtifact> PutAsync(Guid organizationId, string suggestedName, string contentType,
        Stream content, CancellationToken ct = default);

    Task<Stream?> GetAsync(string storageKey, CancellationToken ct = default);
    Task<bool> ExistsAsync(string storageKey, CancellationToken ct = default);
    Task DeleteAsync(string storageKey, CancellationToken ct = default);

    /// <summary>A time-limited URL when the backing store supports one; null for stores
    /// that do not, in which case the API streams the bytes itself.</summary>
    Task<string?> TryGetSignedUrlAsync(string storageKey, TimeSpan validFor, CancellationToken ct = default);
}
