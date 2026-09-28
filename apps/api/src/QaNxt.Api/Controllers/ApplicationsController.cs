using QaNxt.Api.Authorization;
using QaNxt.Application.Applications;
using QaNxt.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace QaNxt.Api.Controllers;

/// <summary>Applications under test: where they live, how far discovery may roam, and how
/// to sign in. Credentials are write-only — they go in encrypted and never come back out.</summary>
[RequirePermission(Permissions.ApplicationRead)]
public sealed class ApplicationsController : ApiControllerBase
{
    private readonly IApplicationService _applications;
    public ApplicationsController(IApplicationService applications) => _applications = applications;

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, CancellationToken ct)
        => Ok(await _applications.ListAsync(projectId, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
        => FromResult(await _applications.GetAsync(id, ct));

    /// <summary>Registers an application. The base URL is checked against the deployment's
    /// target policy before anything is stored.</summary>
    [HttpPost]
    [RequirePermission(Permissions.ApplicationWrite)]
    public async Task<IActionResult> Create([FromBody] CreateApplicationRequest request, CancellationToken ct)
    {
        if (request.Credentials is not null && !User.HasClaim(c => c.Type == "perm" && c.Value == Permissions.SecretWrite))
            return Problem(QaNxt.Domain.Common.Error.Forbidden("Configuring credentials requires the secret:write permission."));

        var result = await _applications.CreateAsync(request, ct);
        return FromResult(result, detail => CreatedAtAction(nameof(Get), new { id = detail.Id }, detail));
    }

    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.ApplicationWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateApplicationRequest request, CancellationToken ct)
    {
        if (request.Credentials is not null && !User.HasClaim(c => c.Type == "perm" && c.Value == Permissions.SecretWrite))
            return Problem(QaNxt.Domain.Common.Error.Forbidden("Configuring credentials requires the secret:write permission."));

        return FromResult(await _applications.UpdateAsync(id, request, ct));
    }

    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.ApplicationWrite)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
        => FromResult(await _applications.DeleteAsync(id, ct));
}
