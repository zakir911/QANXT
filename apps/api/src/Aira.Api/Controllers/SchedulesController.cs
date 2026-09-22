using Aira.Api.Authorization;
using Aira.Application.Scheduling;
using Aira.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>Regression that happens without anybody asking.
///
/// Changing a schedule needs the same permission as changing a project: a schedule decides
/// what AIRA runs, how often, and against which environment, and that is a project-level
/// decision rather than a testing one. Firing one by hand needs permission to start a run,
/// because that is exactly what it does.</summary>
[Route("api/v1/schedules")]
[RequirePermission(Permissions.ProjectRead)]
public sealed class SchedulesController : ApiControllerBase
{
    private readonly IScheduleService _schedules;
    public SchedulesController(IScheduleService schedules) => _schedules = schedules;

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, CancellationToken ct)
        => Ok(await _schedules.ListAsync(projectId, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
        => FromResult(await _schedules.GetAsync(id, ct));

    /// <summary>The next few times this will fire, so a cron expression can be checked
    /// against what whoever typed it meant — before waiting a night to find out.</summary>
    [HttpGet("{id:guid}/preview")]
    public async Task<IActionResult> Preview(Guid id, [FromQuery] int count = 5, CancellationToken ct = default)
        => FromResult(await _schedules.PreviewAsync(id, count, ct));

    [HttpPost]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Create([FromBody] CreateScheduleRequest request, CancellationToken ct)
        => FromResult(await _schedules.CreateAsync(request, ct),
            summary => CreatedAtAction(nameof(Get), new { id = summary.Id }, summary));

    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateScheduleRequest request, CancellationToken ct)
        => FromResult(await _schedules.UpdateAsync(id, request, ct));

    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
        => FromResult(await _schedules.DeleteAsync(id, ct));
}
