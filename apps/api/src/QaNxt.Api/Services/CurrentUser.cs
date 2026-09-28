using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using QaNxt.Application.Abstractions;
using QaNxt.Infrastructure.Security;

namespace QaNxt.Api.Services;

/// <summary>Projects the authenticated principal into the shape use cases need. Reading
/// claims in exactly one place keeps claim names out of business code.</summary>
public sealed class CurrentUser : ICurrentUser
{
    private readonly IHttpContextAccessor _accessor;
    private IReadOnlySet<string>? _permissions;

    public CurrentUser(IHttpContextAccessor accessor) => _accessor = accessor;

    private ClaimsPrincipal? Principal => _accessor.HttpContext?.User;

    public bool IsAuthenticated => Principal?.Identity?.IsAuthenticated == true;

    public Guid? UserId =>
        Guid.TryParse(Principal?.FindFirstValue(JwtRegisteredClaimNames.Sub), out var id) ? id : null;

    public Guid? OrganizationId =>
        Guid.TryParse(Principal?.FindFirstValue(JwtTokenService.OrganizationClaim), out var id) ? id : null;

    public string? Email => Principal?.FindFirstValue(JwtRegisteredClaimNames.Email);

    public IReadOnlySet<string> Permissions =>
        _permissions ??= Principal?.FindAll(JwtTokenService.PermissionClaim)
            .Select(c => c.Value).ToHashSet(StringComparer.Ordinal)
        ?? new HashSet<string>(StringComparer.Ordinal);

    public bool HasPermission(string permission) => Permissions.Contains(permission);

    public string? CorrelationId => _accessor.HttpContext?.TraceIdentifier;
}

/// <summary>Correlation identifiers flow from the caller's header (if present) through the
/// API, into queued jobs, into worker logs and back into execution records, so one id
/// stitches a whole run together across processes.</summary>
public sealed class CorrelationContext : ICorrelationContext
{
    public const string HeaderName = "X-Correlation-Id";

    private readonly IHttpContextAccessor _accessor;
    public CorrelationContext(IHttpContextAccessor accessor) => _accessor = accessor;

    public string CorrelationId
    {
        get
        {
            var context = _accessor.HttpContext;
            if (context is null) return Guid.NewGuid().ToString("N");
            if (context.Items.TryGetValue(HeaderName, out var value) && value is string existing) return existing;
            return context.TraceIdentifier;
        }
    }

    public string? RequestId => _accessor.HttpContext?.TraceIdentifier;
}
