using QaNxt.Api.Authorization;
using QaNxt.Application.Applications;
using QaNxt.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace QaNxt.Api.Controllers;

/// <summary>The API surface QA NXT has observed, the contracts accepted for it, and what has
/// moved since.
///
/// Reading the inventory needs only project read. Accepting a baseline and acknowledging a
/// breaking change are both decisions about a release, so both need write.</summary>
[Route("api/v1/api-contracts")]
[RequirePermission(Permissions.ProjectRead)]
public sealed class ApiContractsController : ApiControllerBase
{
    private readonly IApiContractService _contracts;

    public ApiContractsController(IApiContractService contracts)
    {
        _contracts = contracts;
    }

    /// <summary>Every endpoint discovery has seen for an application, with whether it has a
    /// contract baseline, how many API tests call it, and how many unacknowledged breaking
    /// changes are open against it. The coverage gap is the point: an endpoint with
    /// <c>testCount: 0</c> is one nothing checks.</summary>
    [HttpGet("inventory")]
    public async Task<IActionResult> Inventory([FromQuery] Guid applicationId, CancellationToken ct)
        => FromResult(await _contracts.InventoryAsync(applicationId, ct));

    /// <summary>Accepts the currently observed shapes as the baseline to compare against.
    /// Replacing an existing baseline requires a note: accepting a contract change is a
    /// decision, and it has to be attributable.</summary>
    [HttpPost("baselines")]
    [RequirePermission(Permissions.ProjectWrite)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CaptureBaselines(
        [FromBody] CaptureBaselinesRequest request, CancellationToken ct)
        => FromResult(await _contracts.CaptureBaselinesAsync(request, ct));

    /// <summary>Compares the responses a finished run observed against the baselines, and
    /// classifies each difference. Runs automatically when a run completes and the
    /// application has baselines; this endpoint is for asking again, or for a run that
    /// gained baselines afterwards.</summary>
    [HttpPost("check/run/{testRunId:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> CheckRun(Guid testRunId, CancellationToken ct)
        => FromResult(await _contracts.CheckRunAsync(testRunId, ct));

    /// <summary>The same comparison against what a crawl saw, for teams whose contract
    /// coverage comes from driving the UI rather than from API tests.</summary>
    [HttpPost("check/discovery/{discoveryRunId:guid}")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> CheckDiscovery(Guid discoveryRunId, CancellationToken ct)
        => FromResult(await _contracts.CheckDiscoveryAsync(discoveryRunId, ct));

    /// <summary>What a run's contract check found, without running it again — which is what
    /// a report or a pipeline reads.</summary>
    [HttpGet("changes/run/{testRunId:guid}")]
    public async Task<IActionResult> ChangesForRun(Guid testRunId, CancellationToken ct)
        => FromResult(await _contracts.ChangesForRunAsync(testRunId, ct));

    public sealed record AcknowledgeBody(string Note);

    /// <summary>Records that someone has looked at a change and decided it is acceptable.
    /// The change still counts in its own run's gate — that decision is already made — but
    /// it stops failing later ones.</summary>
    [HttpPost("changes/{changeId:guid}/acknowledge")]
    [RequirePermission(Permissions.ProjectWrite)]
    public async Task<IActionResult> Acknowledge(
        Guid changeId, [FromBody] AcknowledgeBody body, CancellationToken ct)
        => FromResult(await _contracts.AcknowledgeAsync(changeId, body.Note, ct));
}
