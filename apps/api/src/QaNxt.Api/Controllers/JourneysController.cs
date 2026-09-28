using QaNxt.Api.Authorization;
using QaNxt.Application.Journeys;
using QaNxt.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace QaNxt.Api.Controllers;

/// <summary>User journeys: discovered, recorded or authored paths through an application.</summary>
[RequirePermission(Permissions.ApplicationRead)]
public sealed class JourneysController : ApiControllerBase
{
    private readonly IJourneyImportService _journeys;
    public JourneysController(IJourneyImportService journeys) => _journeys = journeys;

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? applicationId, CancellationToken ct)
        => Ok(await _journeys.ListAsync(applicationId, ct));

    /// <summary>Imports a journey recorded with the browser extension, and by default
    /// generates an executable test from it.</summary>
    [HttpPost("import")]
    [RequirePermission(Permissions.TestWrite)]
    [RequestSizeLimit(4 * 1024 * 1024)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Import([FromBody] ImportJourneyRequest request, CancellationToken ct)
        => FromResult(await _journeys.ImportAsync(request, ct));
}
