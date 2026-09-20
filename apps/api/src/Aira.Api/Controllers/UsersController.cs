using Aira.Api.Authorization;
using Aira.Application.Identity;
using Aira.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>The people in an organization.
///
/// Reading the list needs only <c>user:read</c>; everything that changes an account needs
/// <c>user:write</c>, because adding a person, changing what they can do and ending their
/// sessions are all decisions with consequences beyond this screen.</summary>
[Route("api/v1/users")]
[RequirePermission(Permissions.UserRead)]
public sealed class UsersController : ApiControllerBase
{
    private readonly IUserService _users;
    public UsersController(IUserService users) => _users = users;

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await _users.ListAsync(ct));

    /// <summary>Adds someone to the organization and returns a one-time password for them.
    ///
    /// The password is in the response because this platform sends no mail. It is returned
    /// once and cannot be retrieved again; losing it means resetting the account.</summary>
    [HttpPost]
    [RequirePermission(Permissions.UserWrite)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> Invite([FromBody] InviteUserRequest request, CancellationToken ct)
        => FromResult(await _users.InviteAsync(request, ct));

    /// <summary>Changes a name, a role or a status. Changing a role or suspending an account
    /// ends that account's sessions immediately rather than when its token expires.</summary>
    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.UserWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateUserRequest request, CancellationToken ct)
        => FromResult(await _users.UpdateAsync(id, request, ct));

    /// <summary>Issues a new one-time password and ends every session the account holds.</summary>
    [HttpPost("{id:guid}/reset-password")]
    [RequirePermission(Permissions.UserWrite)]
    public async Task<IActionResult> ResetPassword(Guid id, CancellationToken ct)
        => FromResult(await _users.ResetPasswordAsync(id, ct));
}
