using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Primitives;

namespace QaNxt.Api.Authorization;

/// <summary>Reads what a bearer token <em>claims</em> to be, without trusting it.
///
/// <para>Used for one thing only: choosing which rate-limit bucket a request belongs in. A
/// worker whose job token has expired authenticates to nothing, so the validated principal
/// is empty and its callbacks fall into the general per-address bucket — where a fleet
/// exhausts a human-sized budget in seconds and starts receiving 429s. That matters more
/// than it sounds: the worker exchanges an expired token for a fresh one when it is told
/// <em>401</em>, and a 429 arriving instead hides that signal completely. A run whose
/// tokens aged out therefore retried into the limiter until the stranded sweep ended it.</para>
///
/// <para>This is deliberately not authentication and must never be used as any. It does not
/// check the signature, the issuer, the audience or the expiry, and nothing downstream is
/// authorised by it. Every bucket is bounded, and the endpoints themselves still require a
/// properly validated token, so the worst a forged claim achieves is a different rate
/// bucket.</para></summary>
public static class WorkerClaims
{
    public readonly record struct Claimed(bool IsWorker, string? OrganizationId);

    private static readonly Claimed None = new(false, null);

    public static Claimed ReadUnvalidated(StringValues authorization)
    {
        var header = authorization.Count > 0 ? authorization[0] : null;
        if (string.IsNullOrEmpty(header) || !header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return None;

        var token = header["Bearer ".Length..].Trim();
        var parts = token.Split('.');
        if (parts.Length != 3) return None;

        try
        {
            using var payload = JsonDocument.Parse(Base64UrlDecode(parts[1]));
            var root = payload.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return None;

            var kind = root.TryGetProperty("kind", out var k) ? k.GetString() : null;
            if (!string.Equals(kind, "worker", StringComparison.Ordinal)) return None;

            var organization = root.TryGetProperty("org", out var o) ? o.GetString() : null;
            return new Claimed(true, organization);
        }
        catch
        {
            // Anything unreadable is simply not a worker token for bucketing purposes.
            return None;
        }
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '='));
    }
}
