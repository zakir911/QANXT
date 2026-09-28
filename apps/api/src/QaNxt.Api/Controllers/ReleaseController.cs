using QaNxt.Api.Authorization;
using QaNxt.Application.Quality;
using QaNxt.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace QaNxt.Api.Controllers;

/// <summary>
/// What changed, rather than what is broken.
/// </summary>
/// <remarks>
/// A single run answers "is it broken now". A release decision needs "what changed", and
/// they are different questions: twelve failing tests are not a reason to stop a release if
/// the same twelve failed last week and somebody already knows why. One test that used to
/// pass is.
/// </remarks>
[Route("api/v1/release")]
[RequirePermission(Permissions.ExecutionRead)]
public sealed class ReleaseController : ApiControllerBase
{
    private readonly IRunComparisonService _comparisons;
    public ReleaseController(IRunComparisonService comparisons) => _comparisons = comparisons;

    /// <summary>Two runs, side by side. Omit `previous` to use the one before it.</summary>
    [HttpGet("compare")]
    public async Task<IActionResult> Compare([FromQuery] Guid run, [FromQuery] Guid? previous, CancellationToken ct)
        => FromResult(await _comparisons.CompareAsync(run, previous, ct));

    /// <summary>Every run that tested one application build, and what it says about shipping it.</summary>
    [HttpGet("quality")]
    public async Task<IActionResult> Quality([FromQuery] Guid projectId, [FromQuery] string build, CancellationToken ct)
        => FromResult(await _comparisons.ReleaseAsync(projectId, build, ct));
}
