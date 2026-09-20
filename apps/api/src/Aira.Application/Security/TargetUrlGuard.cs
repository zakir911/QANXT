using System.Net;
using System.Net.Sockets;

namespace Aira.Application.Security;

public sealed record UrlGuardOptions(
    IReadOnlyCollection<string> AllowedHosts,
    IReadOnlyCollection<string> ExcludedPathPrefixes,
    bool AllowPrivateNetworks);

/// <summary>Decides whether the platform may open a URL. This is the primary SSRF control:
/// a user can ask us to test any site, so every navigation — the seed URL, every discovered
/// link, and every redirect target — is checked here before a request is issued.</summary>
public static class TargetUrlGuard
{
    private static readonly HashSet<string> AllowedSchemes = new(StringComparer.OrdinalIgnoreCase) { "http", "https" };

    /// <summary>Hostnames that are never allowed regardless of configuration, because they
    /// address cloud instance metadata services.</summary>
    private static readonly HashSet<string> BlockedHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "metadata.google.internal", "metadata.goog", "instance-data"
    };

    public static bool IsAllowed(string url, UrlGuardOptions options, out string reason)
    {
        reason = string.Empty;

        if (string.IsNullOrWhiteSpace(url)) { reason = "the URL is empty"; return false; }
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) { reason = "the URL is not absolute"; return false; }
        if (!AllowedSchemes.Contains(uri.Scheme)) { reason = $"scheme '{uri.Scheme}' is not permitted (http and https only)"; return false; }
        if (!string.IsNullOrEmpty(uri.UserInfo)) { reason = "credentials embedded in a URL are not permitted"; return false; }

        var host = uri.Host;
        if (BlockedHosts.Contains(host)) { reason = "the host is a cloud metadata endpoint"; return false; }

        if (options.AllowedHosts.Count > 0 && !MatchesAllowlist(host, options.AllowedHosts))
        {
            reason = $"host '{host}' is not in the application's allowed domains";
            return false;
        }

        foreach (var excluded in options.ExcludedPathPrefixes)
        {
            if (string.IsNullOrWhiteSpace(excluded)) continue;
            if (uri.AbsolutePath.StartsWith(excluded.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                reason = $"path '{uri.AbsolutePath}' is excluded by configuration";
                return false;
            }
        }

        // Two separate decisions, deliberately. Some addresses are never a legitimate test
        // target however the platform is configured — link-local above all, because
        // 169.254.169.254 is the cloud metadata service and the browser worker would fetch
        // whatever it returns and store it as evidence the caller can download.
        if (IsAlwaysForbiddenLiteral(host, out var forbiddenReason))
        {
            reason = forbiddenReason;
            return false;
        }

        // These are the ones the flag exists for: a developer pointing the platform at an
        // application on their own machine.
        if (!options.AllowPrivateNetworks && IsPrivateOrReservedLiteral(host, out var literalReason))
        {
            reason = literalReason;
            return false;
        }

        return true;
    }

    /// <summary>Allowlist entries may be an exact host or a leading-dot suffix
    /// ("<c>.example.com</c>" matches any subdomain but not "notexample.com").</summary>
    public static bool MatchesAllowlist(string host, IReadOnlyCollection<string> allowed)
    {
        foreach (var raw in allowed)
        {
            var entry = raw?.Trim();
            if (string.IsNullOrEmpty(entry)) continue;
            if (entry.StartsWith('.'))
            {
                if (host.EndsWith(entry, StringComparison.OrdinalIgnoreCase)) return true;
                if (host.Equals(entry[1..], StringComparison.OrdinalIgnoreCase)) return true;
            }
            else if (host.Equals(entry, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /// <summary>Addresses that are refused whatever the configuration says.
    ///
    /// Allowing private networks is a development convenience — it lets someone point the
    /// platform at an application on localhost. Nothing about that need justifies reaching
    /// the cloud metadata service, and an operator who enables the convenience is not
    /// asking for it. These ranges therefore sit outside the flag entirely.</summary>
    public static bool IsAlwaysForbiddenLiteral(string host, out string reason)
    {
        reason = string.Empty;

        var candidate = host.StartsWith('[') && host.EndsWith(']') ? host[1..^1] : host;
        if (!IPAddress.TryParse(candidate, out var ip)) return false;

        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            if (b[0] == 169 && b[1] == 254)
            {
                reason = "169.254.0.0/16 is link-local (cloud metadata) and is never a permitted target";
                return true;
            }
            if (b[0] == 100 && b[1] >= 64 && b[1] <= 127)
            {
                reason = "100.64.0.0/10 is carrier-grade NAT space and is never a permitted target";
                return true;
            }
            if (b[0] == 0) { reason = "0.0.0.0/8 is reserved and is never a permitted target"; return true; }
            if (b[0] >= 224) { reason = "multicast and reserved space is never a permitted target"; return true; }
        }
        else if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            // Checked before the mapping below, so ::ffff:169.254.169.254 cannot slip past.
            if (ip.IsIPv4MappedToIPv6) return IsAlwaysForbiddenLiteral(ip.MapToIPv4().ToString(), out reason);
            if (ip.IsIPv6LinkLocal)
            {
                reason = "IPv6 link-local addresses are never a permitted target";
                return true;
            }
            if (ip.IsIPv6Multicast) { reason = "IPv6 multicast is never a permitted target"; return true; }
        }

        return false;
    }

    /// <summary>Rejects literal addresses that point at loopback, link-local, private or
    /// otherwise reserved space. DNS names that resolve into those ranges are additionally
    /// checked at connection time by the worker, because DNS can change between checks.
    ///
    /// Callers gate this behind <see cref="TargetPolicyOptions.AllowPrivateNetworks"/>; the
    /// ranges that must never be reachable live in
    /// <see cref="IsAlwaysForbiddenLiteral"/> instead.</summary>
    public static bool IsPrivateOrReservedLiteral(string host, out string reason)
    {
        reason = string.Empty;

        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        {
            reason = "localhost targets are disabled by configuration";
            return true;
        }

        var candidate = host.StartsWith('[') && host.EndsWith(']') ? host[1..^1] : host;
        if (!IPAddress.TryParse(candidate, out var ip)) return false;

        if (IPAddress.IsLoopback(ip)) { reason = "loopback addresses are disabled by configuration"; return true; }

        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            if (b[0] == 10) { reason = "10.0.0.0/8 is a private network"; return true; }
            if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) { reason = "172.16.0.0/12 is a private network"; return true; }
            if (b[0] == 192 && b[1] == 168) { reason = "192.168.0.0/16 is a private network"; return true; }
            if (b[0] == 169 && b[1] == 254) { reason = "169.254.0.0/16 is link-local (cloud metadata)"; return true; }
            if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) { reason = "100.64.0.0/10 is carrier-grade NAT space"; return true; }
            if (b[0] == 0) { reason = "0.0.0.0/8 is reserved"; return true; }
            if (b[0] >= 224) { reason = "multicast and reserved space is not a valid target"; return true; }
        }
        else if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (ip.IsIPv6LinkLocal) { reason = "IPv6 link-local addresses are not valid targets"; return true; }
            if (ip.IsIPv6SiteLocal) { reason = "IPv6 site-local addresses are not valid targets"; return true; }
            var b = ip.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) { reason = "IPv6 unique-local addresses are not valid targets"; return true; }
            if (ip.IsIPv4MappedToIPv6) return IsPrivateOrReservedLiteral(ip.MapToIPv4().ToString(), out reason);
        }

        return false;
    }

    /// <summary>Collapses a URL for deduplication: drops the fragment, sorts query keys,
    /// replaces numeric and GUID path segments with placeholders, and strips a trailing
    /// slash. Without this, a crawler loops forever on /accounts/1, /accounts/2, …</summary>
    public static string Normalize(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return url;

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Select(NormalizeSegment);
        var path = "/" + string.Join('/', segments);
        if (path.Length > 1 && path.EndsWith('/')) path = path[..^1];

        var query = string.Empty;
        if (!string.IsNullOrEmpty(uri.Query))
        {
            var pairs = uri.Query.TrimStart('?')
                .Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(p => p.Split('=', 2)[0])
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(k => k, StringComparer.OrdinalIgnoreCase)
                .Select(k => $"{k}={{v}}");
            var joined = string.Join('&', pairs);
            if (joined.Length > 0) query = "?" + joined;
        }

        var port = uri.IsDefaultPort ? string.Empty : $":{uri.Port}";
        return $"{uri.Scheme}://{uri.Host.ToLowerInvariant()}{port}{path}{query}";
    }

    private static string NormalizeSegment(string segment)
    {
        if (segment.Length == 0) return segment;
        if (segment.All(char.IsDigit)) return "{id}";
        if (Guid.TryParse(segment, out _)) return "{guid}";
        // Long opaque tokens (hashes, base64 ids) are treated as identifiers too.
        if (segment.Length >= 24 && segment.All(c => char.IsLetterOrDigit(c) || c is '-' or '_')
            && segment.Any(char.IsDigit) && segment.Any(char.IsLetter)) return "{token}";
        return segment.ToLowerInvariant();
    }
}
