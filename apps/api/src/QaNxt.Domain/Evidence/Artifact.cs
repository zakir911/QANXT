using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Evidence;

/// <summary>Metadata for a binary held in the artifact store. The bytes never live in
/// PostgreSQL; identical content deduplicates by hash.</summary>
public class Artifact : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid? TestExecutionId { get; set; }
    public Guid? TestActionId { get; set; }
    public Guid? DiscoveryRunId { get; set; }
    public Guid? ApplicationPageId { get; set; }

    public ArtifactKind Kind { get; set; }
    public string Name { get; set; } = string.Empty;
    /// <summary>Key within the artifact store, not a filesystem path.</summary>
    public string StorageKey { get; set; } = string.Empty;
    public string ContentType { get; set; } = "application/octet-stream";
    public long SizeBytes { get; set; }
    public string Sha256 { get; set; } = string.Empty;
    /// <summary>True when the masking pass ran over this artifact's contents.</summary>
    public bool IsMasked { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public string? MetadataJson { get; set; }
}
