using QaNxt.Api.Configuration;
using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace QaNxt.Api.Controllers;

/// <summary>Non-tenant metadata the console needs before a user signs in: branding, the
/// capability vocabulary and the enum values the UI renders.</summary>
[AllowAnonymous]
public sealed class MetaController : ApiControllerBase
{
    private readonly ProductOptions _product;

    public MetaController(IOptions<ProductOptions> product) => _product = product.Value;

    /// <summary>Branding and API version. The console reads this so the product name is
    /// never compiled into the front end.</summary>
    [HttpGet]
    public IActionResult Get() => Ok(new
    {
        product = _product.Name,
        tagline = _product.Tagline,
        version = _product.Version,
        apiVersion = "v1"
    });

    /// <summary>The full permission catalogue and the built-in role matrix, used by the
    /// roles administration screen.</summary>
    [HttpGet("permissions")]
    public IActionResult GetPermissions() => Ok(new
    {
        permissions = Permissions.All.Select(p => new { name = p.Name, category = p.Category, description = p.Description }),
        roles = Enum.GetValues<SystemRole>().Select(r => new
        {
            role = r.ToString(),
            description = RolePermissionMatrix.DescriptionOf(r),
            permissions = RolePermissionMatrix.For(r)
        })
    });

    /// <summary>Enum vocabularies, so dropdowns in the console cannot drift from the server.</summary>
    [HttpGet("enums")]
    public IActionResult GetEnums() => Ok(new
    {
        browsers = Enum.GetNames<BrowserType>(),
        executionStatuses = Enum.GetNames<ExecutionStatus>(),
        failureCategories = Enum.GetNames<FailureCategory>(),
        healingPolicies = Enum.GetNames<HealingPolicy>(),
        priorities = Enum.GetNames<TestPriority>(),
        riskLevels = Enum.GetNames<RiskLevel>(),
        actions = Enum.GetNames<BrowserActionType>(),
        assertionTypes = Enum.GetNames<AssertionType>(),
        authStrategies = Enum.GetNames<AuthenticationStrategy>(),
        aiProviders = Enum.GetNames<LlmProviderKind>(),
        defectSeverities = Enum.GetNames<DefectSeverity>(),
        defectStatuses = Enum.GetNames<DefectStatus>(),
        qualityGateMetrics = Enum.GetNames<QualityGateMetric>(),
        qualityGateOperators = Enum.GetNames<QualityGateOperator>()
    });
}
