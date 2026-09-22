using Aira.Api.Authorization;
using Aira.Application.Projects;
using Aira.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>Where an application is deployed, and whether AIRA may test it.
///
/// Reading needs project access. Creating or changing one needs the same permission as
/// changing a project, because an environment decides what AIRA is pointed at. Authorizing
/// production testing is separated onto its own route so it cannot be done by accident in
/// the middle of an ordinary update.</summary>
[Route("api/v1/environments")]
[RequirePermission(Permissions.ProjectRead)]
public sealed class EnvironmentsController : ApiControllerBase
{
    private readonly IEnvironmentService _environments;
    public EnvironmentsController(IEnvironmentService environments) => _environments = environments;

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, CancellationToken ct)
        => Ok(await _environments.ListAsync(projectId, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
        => FromResult(await _environments.GetAsync(id, ct));

    /// <summary>Resolves the key a pipeline passes to `--environment`.</summary>
    [HttpGet("resolve")]
    public async Task<IActionResult> Resolve([FromQuery] Guid projectId, [FromQuery] string key, CancellationToken ct)
        => FromResult(await _environments.ResolveAsync(projectId, key, ct));

    [HttpPost]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Create([FromBody] CreateEnvironmentRequest request, CancellationToken ct)
        => FromResult(await _environments.CreateAsync(request, ct));

    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateEnvironmentRequest request, CancellationToken ct)
        => FromResult(await _environments.UpdateAsync(id, request, ct));

    /// <summary>Grants or withdraws permission to test a production environment. Recorded in
    /// the audit trail with the note and the person who did it.</summary>
    [HttpPost("{id:guid}/authorize-production")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> AuthorizeProduction(
        Guid id, [FromBody] AuthorizeProductionRequest request, CancellationToken ct)
        => FromResult(await _environments.AuthorizeProductionAsync(id, request, ct));

    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
        => FromResult(await _environments.DeleteAsync(id, ct));
}
