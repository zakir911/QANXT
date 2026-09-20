using Aira.Api.Authorization;
using Aira.Application.Quality;
using Aira.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>The rules that decide whether a run blocks a pipeline.
///
/// Reading them needs only project access; changing one needs an explicit permission,
/// because weakening a gate is a release decision, not a configuration tweak.</summary>
[Route("api/v1/quality-gates")]
[RequirePermission(Permissions.ProjectRead)]
public sealed class QualityGatesController : ApiControllerBase
{
    private readonly IQualityGateService _gates;
    public QualityGatesController(IQualityGateService gates) => _gates = gates;

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid projectId, CancellationToken ct)
        => FromResult(await _gates.ListAsync(projectId, ct));

    [HttpPost]
    [RequirePermission(Permissions.QualityGateWrite)]
    public async Task<IActionResult> Create(
        [FromQuery] Guid projectId, [FromBody] QualityGateRuleRequest request, CancellationToken ct)
        => FromResult(await _gates.CreateAsync(projectId, request, ct));

    [HttpPut("{id:guid}")]
    [RequirePermission(Permissions.QualityGateWrite)]
    public async Task<IActionResult> Update(
        Guid id, [FromBody] QualityGateRuleRequest request, CancellationToken ct)
        => FromResult(await _gates.UpdateAsync(id, request, ct));

    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.QualityGateWrite)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
        => FromResult(await _gates.DeleteAsync(id, ct));
}
