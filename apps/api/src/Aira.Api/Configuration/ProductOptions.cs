namespace Aira.Api.Configuration;

/// <summary>Branding is configuration, never a literal in logic. The console reads these
/// from /api/v1/meta, so renaming the product is an environment change.</summary>
public sealed class ProductOptions
{
    public string Name { get; set; } = "AIRA";
    public string Tagline { get; set; } = "Your AI Quality Engineer";
    public string Version { get; set; } = "0.1.0";
}

public sealed class SecurityOptions
{
    public string[] CorsOrigins { get; set; } = Array.Empty<string>();
    public int RateLimitPermitPerMinute { get; set; } = 300;
    /// <summary>Hosts every project may target, on top of each application's own allowlist.</summary>
    public string[] GlobalTargetAllowlist { get; set; } = Array.Empty<string>();
    /// <summary>Local development targets the demo bank on localhost, so this defaults on
    /// in Development and must be turned off for any internet-facing deployment.</summary>
    public bool AllowPrivateNetworkTargets { get; set; }
    /// <summary>Shared secret a worker presents to exchange for job-scoped tokens.</summary>
    public string WorkerToken { get; set; } = string.Empty;
}
