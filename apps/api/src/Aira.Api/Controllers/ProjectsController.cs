using Aira.Api.Authorization;
using Aira.Application.Projects;
using Aira.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

[RequirePermission(Permissions.ProjectRead)]
public sealed class ProjectsController : ApiControllerBase
{
    private readonly IProjectService _projects;
    public ProjectsController(IProjectService projects) => _projects = projects;

    /// <summary>Projects in the caller's organization, with rollup counts.</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await _projects.ListAsync(ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => FromResult(await _projects.GetAsync(id, ct));

    [HttpPost]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Create([FromBody] CreateProjectRequest request, CancellationToken ct)
    {
        var result = await _projects.CreateAsync(request, ct);
        return FromResult(result, detail => CreatedAtAction(nameof(Get), new { id = detail.Id }, detail));
    }

    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateProjectRequest request, CancellationToken ct)
        => FromResult(await _projects.UpdateAsync(id, request, ct));

    /// <summary>Soft-deletes a project; historical runs and evidence are retained.</summary>
    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.ProjectDelete)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct) => FromResult(await _projects.DeleteAsync(id, ct));
}
