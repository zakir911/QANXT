using QaNxt.Application.Abstractions;
using QaNxt.Infrastructure.Security;
using Serilog.Context;

namespace QaNxt.Api.Middleware;

/// <summary>Binds the ambient tenant from the authenticated principal before any handler
/// runs, so the DbContext's global filters are already in force by the time a controller
/// touches data.</summary>
public sealed class TenantMiddleware
{
    private readonly RequestDelegate _next;
    public TenantMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context, ITenantContext tenant)
    {
        var claim = context.User.FindFirst(JwtTokenService.OrganizationClaim)?.Value;
        if (Guid.TryParse(claim, out var organizationId))
        {
            tenant.SetOrganization(organizationId);
            using (LogContext.PushProperty("TenantId", organizationId))
            {
                await _next(context);
                return;
            }
        }

        await _next(context);
    }
}
