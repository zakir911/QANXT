using QaNxt.Application.Identity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace QaNxt.Api.Controllers;

/// <summary>Registration, sign-in, refresh-token rotation and sign-out. Rate limited far
/// more tightly than the rest of the API because these endpoints are the credential surface.</summary>
[AllowAnonymous]
[EnableRateLimiting("auth")]
public sealed class AuthController : ApiControllerBase
{
    private readonly IAuthService _auth;
    public AuthController(IAuthService auth) => _auth = auth;

    public sealed record RegisterBody(string OrganizationName, string Email, string Password, string DisplayName);
    public sealed record LoginBody(string Email, string Password, string? OrganizationSlug);
    public sealed record RefreshBody(string RefreshToken);

    /// <summary>Creates an organization and its first administrator.</summary>
    [HttpPost("register")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> Register([FromBody] RegisterBody body, CancellationToken ct)
    {
        var result = await _auth.RegisterOrganizationAsync(
            new RegisterOrganizationRequest(body.OrganizationName, body.Email, body.Password, body.DisplayName),
            ClientIp, UserAgent, ct);
        return FromResult(result);
    }

    /// <summary>Exchanges credentials for an access token and a refresh token.</summary>
    [HttpPost("login")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Login([FromBody] LoginBody body, CancellationToken ct)
    {
        var result = await _auth.LoginAsync(new LoginRequest(body.Email, body.Password, body.OrganizationSlug),
            ClientIp, UserAgent, ct);
        return FromResult(result);
    }

    /// <summary>Rotates a refresh token. The presented token is revoked as part of the exchange.</summary>
    [HttpPost("refresh")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Refresh([FromBody] RefreshBody body, CancellationToken ct)
        => FromResult(await _auth.RefreshAsync(body.RefreshToken, ClientIp, UserAgent, ct));

    /// <summary>Revokes a refresh token. Always succeeds so that it cannot be used to probe
    /// which tokens exist.</summary>
    [HttpPost("logout")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> Logout([FromBody] RefreshBody body, CancellationToken ct)
        => FromResult(await _auth.LogoutAsync(body.RefreshToken, ct));

    /// <summary>The signed-in user with their effective roles and permissions.</summary>
    [HttpGet("me")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Me(CancellationToken ct) => FromResult(await _auth.GetCurrentUserAsync(ct));

    private string? ClientIp => HttpContext.Connection.RemoteIpAddress?.ToString();
    private string? UserAgent => Request.Headers.UserAgent.FirstOrDefault();
}
