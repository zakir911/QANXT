using QaNxt.Application.Abstractions;
using QaNxt.Infrastructure.Security;
using Microsoft.AspNetCore.Authorization;

namespace QaNxt.Api.Authorization;

public sealed class PermissionRequirement : IAuthorizationRequirement
{
    public PermissionRequirement(string permission) => Permission = permission;
    public string Permission { get; }
}

/// <summary>Authorizes on capabilities rather than role names, and refuses worker tokens
/// outright: a worker's token exists to report results for one job, never to act as a user.</summary>
public sealed class PermissionAuthorizationHandler : AuthorizationHandler<PermissionRequirement>
{
    private readonly ICurrentUser _currentUser;
    private readonly ILogger<PermissionAuthorizationHandler> _logger;

    public PermissionAuthorizationHandler(ICurrentUser currentUser, ILogger<PermissionAuthorizationHandler> logger)
    {
        _currentUser = currentUser;
        _logger = logger;
    }

    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, PermissionRequirement requirement)
    {
        var kind = context.User.FindFirst(JwtTokenService.TokenKindClaim)?.Value;
        if (kind == "worker")
        {
            _logger.LogWarning("A worker token attempted a user-scoped operation requiring {Permission}.", requirement.Permission);
            return Task.CompletedTask;
        }

        if (_currentUser.HasPermission(requirement.Permission))
            context.Succeed(requirement);

        return Task.CompletedTask;
    }
}

/// <summary>Builds permission policies on demand so endpoints can reference any permission
/// constant without registering each policy by hand.</summary>
public sealed class PermissionPolicyProvider : IAuthorizationPolicyProvider
{
    public const string Prefix = "perm:";
    private readonly DefaultAuthorizationPolicyProvider _fallback;

    public PermissionPolicyProvider(Microsoft.Extensions.Options.IOptions<AuthorizationOptions> options)
        => _fallback = new DefaultAuthorizationPolicyProvider(options);

    public Task<AuthorizationPolicy> GetDefaultPolicyAsync() => _fallback.GetDefaultPolicyAsync();
    public Task<AuthorizationPolicy?> GetFallbackPolicyAsync() => _fallback.GetFallbackPolicyAsync();

    public Task<AuthorizationPolicy?> GetPolicyAsync(string policyName)
    {
        if (!policyName.StartsWith(Prefix, StringComparison.Ordinal))
            return _fallback.GetPolicyAsync(policyName);

        var policy = new AuthorizationPolicyBuilder()
            .RequireAuthenticatedUser()
            .AddRequirements(new PermissionRequirement(policyName[Prefix.Length..]))
            .Build();
        return Task.FromResult<AuthorizationPolicy?>(policy);
    }
}

/// <summary>Declarative capability check: <c>[RequirePermission(Permissions.TestWrite)]</c>.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
public sealed class RequirePermissionAttribute : AuthorizeAttribute
{
    public RequirePermissionAttribute(string permission) => Policy = PermissionPolicyProvider.Prefix + permission;
}

/// <summary>Restricts an endpoint to worker callbacks, which authenticate with a
/// job-scoped token rather than a user token.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class RequireWorkerTokenAttribute : AuthorizeAttribute
{
    public const string PolicyName = "worker-token";
    public RequireWorkerTokenAttribute() => Policy = PolicyName;
}
