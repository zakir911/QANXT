using QaNxt.Application.Abstractions;
using QaNxt.Domain.Enums;
using QaNxt.Infrastructure.Security;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using System.Security.Claims;

namespace QaNxt.Api.Services;

/// <summary>Checks that a token still represents the account it was issued for.
///
/// Every access token carries a security stamp, and the stamp is rotated whenever something
/// changes that the token's own claims would otherwise keep asserting: a disabled account, a
/// changed role, a reset password. Without this check the stamp is decorative — a disabled
/// user keeps working until their token happens to expire, which is up to an hour of access
/// after somebody pressed "disable" and watched the UI say it worked.
///
/// The cost is one indexed lookup of two columns per authenticated request. That is the
/// price of revocation meaning something; a platform that stores other people's credentials
/// should pay it.</summary>
public static class SecurityStampValidator
{
    public static async Task ValidateAsync(TokenValidatedContext context)
    {
        var principal = context.Principal;
        if (principal is null)
        {
            context.Fail("The token carried no identity.");
            return;
        }

        // Worker tokens are minted for one job and carry no user, so there is no stamp to
        // check and nothing to look up.
        if (principal.FindFirstValue(JwtTokenService.TokenKindClaim) != "user") return;

        var stamp = principal.FindFirstValue(JwtTokenService.SecurityStampClaim);
        var subject = principal.FindFirstValue("sub");

        if (string.IsNullOrEmpty(stamp) || !Guid.TryParse(subject, out var userId))
        {
            context.Fail("The token is missing the claims needed to check whether it is still valid.");
            return;
        }

        var services = context.HttpContext.RequestServices;
        var tenant = services.GetRequiredService<ITenantContext>();

        // The tenant context is set by middleware that has not run yet, so the lookup is
        // made in a system context and scoped explicitly by the id from the token.
        using var _ = tenant.EnterSystemContext("validating a token's security stamp");
        var db = services.GetRequiredService<IQaNxtDbContext>();

        var account = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.SecurityStamp, u.Status, u.DeletedAt })
            .FirstOrDefaultAsync(context.HttpContext.RequestAborted);

        if (account is null || account.DeletedAt is not null)
        {
            context.Fail("This account no longer exists.");
            return;
        }

        if (account.Status != UserStatus.Active && account.Status != UserStatus.Invited)
        {
            context.Fail("This account is not active.");
            return;
        }

        if (!string.Equals(account.SecurityStamp, stamp, StringComparison.Ordinal))
        {
            // The account changed in a way this token's claims no longer describe.
            context.Fail("This session ended because the account changed. Sign in again.");
        }
    }
}
