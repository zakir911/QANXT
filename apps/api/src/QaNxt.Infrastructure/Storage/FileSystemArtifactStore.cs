using System.Security.Cryptography;
using QaNxt.Application.Abstractions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace QaNxt.Infrastructure.Storage;

public sealed class StorageOptions
{
    public string Provider { get; set; } = "filesystem";
    public string Root { get; set; } = "./storage";
    public string Bucket { get; set; } = "qanxt-artifacts";
    public int RetentionDays { get; set; } = 30;
    /// <summary>Hard ceiling on a single artifact, to stop a runaway trace filling the disk.</summary>
    public long MaxArtifactBytes { get; set; } = 256L * 1024 * 1024;
}

/// <summary>Content-addressed artifact storage on local disk. The key layout
/// (<c>tenant/ab/abcdef…ext</c>) mirrors an object-store prefix layout exactly, so the S3
/// adapter is a drop-in replacement and existing keys stay meaningful.</summary>
public sealed class FileSystemArtifactStore : IArtifactStore
{
    private readonly StorageOptions _options;
    private readonly ILogger<FileSystemArtifactStore> _logger;
    private readonly string _root;

    public FileSystemArtifactStore(IOptions<StorageOptions> options, ILogger<FileSystemArtifactStore> logger)
    {
        _options = options.Value;
        _logger = logger;
        _root = Path.GetFullPath(_options.Root);
        Directory.CreateDirectory(_root);
    }

    public async Task<StoredArtifact> PutAsync(Guid organizationId, string suggestedName, string contentType,
        Stream content, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(content);

        // Buffer to a temp file so the hash can be computed without holding the artifact in memory.
        var tempPath = Path.Combine(_root, $".tmp-{Guid.NewGuid():N}");
        long size;
        string hash;

        await using (var temp = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true))
        {
            await content.CopyToAsync(temp, ct).ConfigureAwait(false);
            size = temp.Length;
        }

        try
        {
            if (size > _options.MaxArtifactBytes)
            {
                throw new InvalidOperationException(
                    $"Artifact '{suggestedName}' is {size} bytes, above the {_options.MaxArtifactBytes} byte limit.");
            }

            await using (var reading = File.OpenRead(tempPath))
            {
                hash = Convert.ToHexString(await SHA256.HashDataAsync(reading, ct).ConfigureAwait(false)).ToLowerInvariant();
            }

            var extension = Path.GetExtension(suggestedName);
            var key = $"{organizationId:N}/{hash[..2]}/{hash}{extension}";
            var destination = ResolvePath(key);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);

            if (File.Exists(destination))
            {
                // Identical content already stored: deduplicate rather than write it twice.
                File.Delete(tempPath);
            }
            else
            {
                File.Move(tempPath, destination);
            }

            return new StoredArtifact(key, size, hash, contentType);
        }
        catch
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
            throw;
        }
    }

    public Task<Stream?> GetAsync(string storageKey, CancellationToken ct = default)
    {
        var path = ResolvePath(storageKey);
        if (!File.Exists(path)) return Task.FromResult<Stream?>(null);
        return Task.FromResult<Stream?>(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true));
    }

    public Task<bool> ExistsAsync(string storageKey, CancellationToken ct = default)
        => Task.FromResult(File.Exists(ResolvePath(storageKey)));

    public Task DeleteAsync(string storageKey, CancellationToken ct = default)
    {
        var path = ResolvePath(storageKey);
        if (File.Exists(path))
        {
            File.Delete(path);
            _logger.LogInformation("Deleted artifact {Key}", storageKey);
        }
        return Task.CompletedTask;
    }

    /// <summary>The filesystem store has no signed-URL concept; the API streams these
    /// artifacts itself, with authorization applied per request.</summary>
    public Task<string?> TryGetSignedUrlAsync(string storageKey, TimeSpan validFor, CancellationToken ct = default)
        => Task.FromResult<string?>(null);

    /// <summary>Resolves a key to a path and refuses anything that escapes the root.
    /// Keys come from the database and from workers, so traversal must be impossible.</summary>
    private string ResolvePath(string storageKey)
    {
        if (string.IsNullOrWhiteSpace(storageKey)) throw new ArgumentException("Storage key is required.", nameof(storageKey));
        if (Path.IsPathRooted(storageKey) || storageKey.Contains("..", StringComparison.Ordinal))
            throw new ArgumentException($"Invalid storage key '{storageKey}'.", nameof(storageKey));

        var full = Path.GetFullPath(Path.Combine(_root, storageKey));
        if (!full.StartsWith(_root + Path.DirectorySeparatorChar, StringComparison.Ordinal) && full != _root)
            throw new ArgumentException($"Storage key '{storageKey}' resolves outside the artifact root.", nameof(storageKey));
        return full;
    }
}
