using Aira.Api.Authorization;
using Aira.Application.Security;
using Aira.Application.Testing;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>
/// Named data a test case uses.
/// </summary>
/// <remarks>
/// Reading needs test read permission, because the data is part of what a test does.
/// Writing needs test write. A sensitive field's value is never returned by any of these —
/// a secret reference names a secret and is safe to show; a value is not.
/// </remarks>
[Route("api/v1/test-data")]
[RequirePermission(Permissions.TestRead)]
public sealed class TestDataController : ApiControllerBase
{
    private readonly ITestDataService _data;
    public TestDataController(ITestDataService data) => _data = data;

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, CancellationToken ct)
        => Ok(await _data.ListAsync(projectId, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
        => FromResult(await _data.GetAsync(id, ct));

    /// <summary>What a run would use, without starting one.</summary>
    /// <remarks>
    /// The way to check a seeded data set is right is to see the values, not to run a test
    /// and infer them from a screenshot. Sensitive fields are masked.
    /// </remarks>
    [HttpGet("{id:guid}/preview")]
    public async Task<IActionResult> Preview(Guid id, CancellationToken ct)
        => FromResult(await _data.PreviewAsync(id, ct));

    /// <summary>The generator types a field may ask for.</summary>
    [HttpGet("generator-types")]
    public IActionResult GeneratorTypes()
        => Ok(TestDataGenerator.SupportedTypes.OrderBy(type => type));

    [HttpPost]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Create([FromBody] CreateTestDataSetRequest request, CancellationToken ct)
        => FromResult(await _data.CreateAsync(request, ct),
            summary => CreatedAtAction(nameof(Get), new { id = summary.Id }, summary));

    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateTestDataSetRequest request, CancellationToken ct)
        => FromResult(await _data.UpdateAsync(id, request, ct));

    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
        => FromResult(await _data.DeleteAsync(id, ct));
}
