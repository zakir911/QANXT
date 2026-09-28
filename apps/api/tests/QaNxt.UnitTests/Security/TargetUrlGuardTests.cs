using QaNxt.Application.Security;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>The URL guard is the SSRF control. A user can point the platform at any address,
/// so the guard's refusals are asserted explicitly rather than assumed.</summary>
public class TargetUrlGuardTests
{
    private static UrlGuardOptions Options(bool allowPrivate = false, params string[] hosts)
        => new(hosts, Array.Empty<string>(), allowPrivate);

    [Theory]
    [InlineData("ftp://example.com/file")]
    [InlineData("file:///etc/passwd")]
    [InlineData("javascript:alert(1)")]
    [InlineData("data:text/html,<script>")]
    public void Rejects_non_http_schemes(string url)
    {
        TargetUrlGuard.IsAllowed(url, Options(true), out var reason).Should().BeFalse();
        reason.Should().Contain("scheme");
    }

    [Theory]
    [InlineData("http://169.254.169.254/latest/meta-data/")]
    [InlineData("http://metadata.google.internal/computeMetadata/v1/")]
    public void Rejects_cloud_metadata_endpoints(string url)
        => TargetUrlGuard.IsAllowed(url, Options(), out _).Should().BeFalse();

    [Theory]
    [InlineData("http://10.0.0.5/admin")]
    [InlineData("http://172.16.4.1/")]
    [InlineData("http://192.168.1.1/")]
    [InlineData("http://127.0.0.1:8080/")]
    [InlineData("http://localhost:3000/")]
    [InlineData("http://[::1]/")]
    public void Rejects_private_and_loopback_targets_when_disallowed(string url)
        => TargetUrlGuard.IsAllowed(url, Options(), out _).Should().BeFalse();

    [Fact]
    public void Allows_loopback_when_explicitly_permitted_for_local_development()
        => TargetUrlGuard.IsAllowed("http://localhost:4200/login", Options(true), out _).Should().BeTrue();

    [Fact]
    public void Rejects_credentials_embedded_in_the_url()
        => TargetUrlGuard.IsAllowed("https://user:pass@example.com/", Options(true), out _).Should().BeFalse();

    [Fact]
    public void Enforces_the_host_allowlist()
    {
        var options = Options(true, "app.example.com");
        TargetUrlGuard.IsAllowed("https://app.example.com/dashboard", options, out _).Should().BeTrue();
        TargetUrlGuard.IsAllowed("https://evil.example.net/", options, out var reason).Should().BeFalse();
        reason.Should().Contain("allowed domains");
    }

    [Fact]
    public void Allowlist_suffix_entries_match_subdomains_only()
    {
        var allowed = new[] { ".example.com" };
        TargetUrlGuard.MatchesAllowlist("app.example.com", allowed).Should().BeTrue();
        TargetUrlGuard.MatchesAllowlist("example.com", allowed).Should().BeTrue();
        // The classic bypass: a host that merely ends with the same characters.
        TargetUrlGuard.MatchesAllowlist("notexample.com", allowed).Should().BeFalse();
        TargetUrlGuard.MatchesAllowlist("evilexample.com", allowed).Should().BeFalse();
    }

    [Fact]
    public void Honours_excluded_paths()
    {
        var options = new UrlGuardOptions(new[] { "app.example.com" }, new[] { "/logout", "/admin/delete" }, true);
        TargetUrlGuard.IsAllowed("https://app.example.com/logout", options, out var reason).Should().BeFalse();
        reason.Should().Contain("excluded");
        TargetUrlGuard.IsAllowed("https://app.example.com/accounts", options, out _).Should().BeTrue();
    }

    [Theory]
    [InlineData("https://app.example.com/accounts/123", "https://app.example.com/accounts/{id}")]
    [InlineData("https://app.example.com/accounts/123/", "https://app.example.com/accounts/{id}")]
    [InlineData("https://APP.example.com/Accounts", "https://app.example.com/accounts")]
    [InlineData("https://app.example.com/u/2b9f1c4e-1111-2222-3333-444455556666", "https://app.example.com/u/{guid}")]
    [InlineData("https://app.example.com/search?q=hello&page=2", "https://app.example.com/search?page={v}&q={v}")]
    [InlineData("https://app.example.com/page#section", "https://app.example.com/page")]
    public void Normalize_collapses_urls_that_represent_the_same_page(string input, string expected)
        => TargetUrlGuard.Normalize(input).Should().Be(expected);

    [Fact]
    public void Normalize_keeps_non_default_ports()
        => TargetUrlGuard.Normalize("http://app.example.com:8080/x").Should().Be("http://app.example.com:8080/x");
}


/// <summary>Regression cover for BUG-0001: allowing private networks is a development
/// convenience and must not also unlock the cloud metadata service. These are the cases the
/// independent security suite found accepted.</summary>
public class TargetUrlGuardAlwaysForbiddenTests
{
    private static UrlGuardOptions Permissive(bool allowPrivate = true)
        => new(Array.Empty<string>(), Array.Empty<string>(), allowPrivate);

    [Theory]
    [InlineData("http://169.254.169.254/latest/meta-data/")]
    [InlineData("http://169.254.169.254/latest/meta-data/iam/security-credentials/")]
    [InlineData("http://[::ffff:169.254.169.254]/")]
    [InlineData("http://169.254.1.1/")]
    public void Link_local_is_refused_even_when_private_networks_are_allowed(string url)
    {
        // 169.254.169.254 returns instance credentials on every major cloud, and the worker
        // stores whatever it fetches as evidence the caller can download.
        TargetUrlGuard.IsAllowed(url, Permissive(), out var reason).Should().BeFalse();
        reason.Should().Contain("never a permitted target");
    }

    [Theory]
    [InlineData("http://100.64.0.1/")]
    [InlineData("http://0.0.0.0/")]
    [InlineData("http://239.255.255.250/")]
    public void Other_never_routable_space_is_refused_regardless_of_configuration(string url)
        => TargetUrlGuard.IsAllowed(url, Permissive(), out _).Should().BeFalse();

    [Theory]
    [InlineData("http://localhost:4200/")]
    [InlineData("http://127.0.0.1:4200/")]
    [InlineData("http://10.0.0.5/")]
    [InlineData("http://192.168.1.10/")]
    public void What_the_flag_is_actually_for_still_works(string url)
    {
        // Loopback and RFC1918 are exactly what a developer enables the flag to reach.
        TargetUrlGuard.IsAllowed(url, Permissive(), out var reason).Should().BeTrue(reason);
    }

    [Theory]
    [InlineData("http://localhost:4200/")]
    [InlineData("http://10.0.0.5/")]
    public void And_is_still_refused_when_the_flag_is_off(string url)
    {
        TargetUrlGuard.IsAllowed(url, Permissive(allowPrivate: false), out _).Should().BeFalse();
    }
}
