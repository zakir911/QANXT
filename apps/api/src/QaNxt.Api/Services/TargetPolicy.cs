using QaNxt.Api.Configuration;
using QaNxt.Application.Applications;
using QaNxt.Application.Security;
using Microsoft.Extensions.Options;

namespace QaNxt.Api.Services;

/// <summary>Combines the deployment's global policy with an application's own allowlist.
///
/// Both must permit a URL. A deployment can therefore confine every project in it to a set
/// of hosts, and a project cannot widen that by editing its own application configuration.</summary>
public sealed class TargetPolicy : ITargetPolicy
{
    private readonly SecurityOptions _options;
    private readonly ILogger<TargetPolicy> _logger;

    public TargetPolicy(IOptions<SecurityOptions> options, ILogger<TargetPolicy> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public bool AllowPrivateNetworks => _options.AllowPrivateNetworkTargets;

    public bool IsAllowed(string url, IReadOnlyCollection<string> applicationAllowlist, out string reason)
    {
        var guardOptions = new UrlGuardOptions(
            applicationAllowlist,
            Array.Empty<string>(),
            _options.AllowPrivateNetworkTargets);

        if (!TargetUrlGuard.IsAllowed(url, guardOptions, out reason))
        {
            _logger.LogWarning("Target URL refused: {Url} ({Reason})", url, reason);
            return false;
        }

        if (_options.GlobalTargetAllowlist.Length > 0)
        {
            var host = new Uri(url).Host;
            if (!TargetUrlGuard.MatchesAllowlist(host, _options.GlobalTargetAllowlist))
            {
                reason = $"host '{host}' is not in this deployment's global target allowlist";
                _logger.LogWarning("Target URL refused by the global allowlist: {Url}", url);
                return false;
            }
        }

        return true;
    }
}

/// <summary>Where the platform can be reached from elsewhere. Configured explicitly
/// because a worker in a container cannot use the URL the API sees itself on.</summary>
public sealed class PlatformUrls : QaNxt.Application.Discovery.IPlatformUrls
{
    public PlatformUrls(IConfiguration configuration)
    {
        ApiBaseUrl = (configuration["API_URL"] ?? configuration["Platform:ApiBaseUrl"] ?? "http://localhost:5080").TrimEnd('/');
        ConsoleBaseUrl = (configuration["Platform:ConsoleBaseUrl"] ?? "http://localhost:5173").TrimEnd('/');
    }

    public string ApiBaseUrl { get; }
    public string ConsoleBaseUrl { get; }
}
