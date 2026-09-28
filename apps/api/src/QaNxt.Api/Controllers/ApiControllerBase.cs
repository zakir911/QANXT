using QaNxt.Api.Contracts;
using QaNxt.Api.Services;
using QaNxt.Domain.Common;
using Microsoft.AspNetCore.Mvc;

namespace QaNxt.Api.Controllers;

/// <summary>Translates domain results into HTTP responses in one place, so every endpoint
/// reports failures the same way and no controller invents its own status-code mapping.</summary>
[ApiController]
[Route("api/v1/[controller]")]
[Produces("application/json")]
public abstract class ApiControllerBase : ControllerBase
{
    protected string CorrelationId =>
        HttpContext.Items[CorrelationContext.HeaderName] as string ?? HttpContext.TraceIdentifier;

    protected IActionResult FromResult<T>(Result<T> result, Func<T, IActionResult>? onSuccess = null)
        => result.IsSuccess
            ? onSuccess?.Invoke(result.Value!) ?? Ok(result.Value)
            : Problem(result.Error!);

    protected IActionResult FromResult(Result result, Func<IActionResult>? onSuccess = null)
        => result.IsSuccess
            ? onSuccess?.Invoke() ?? NoContent()
            : Problem(result.Error!);

    protected IActionResult Problem(Error error)
    {
        var status = error.Kind switch
        {
            ErrorKind.Validation => StatusCodes.Status400BadRequest,
            ErrorKind.NotFound => StatusCodes.Status404NotFound,
            ErrorKind.Conflict => StatusCodes.Status409Conflict,
            ErrorKind.Forbidden => StatusCodes.Status403Forbidden,
            ErrorKind.Unauthorized => StatusCodes.Status401Unauthorized,
            ErrorKind.RateLimited => StatusCodes.Status429TooManyRequests,
            ErrorKind.Dependency => StatusCodes.Status503ServiceUnavailable,
            _ => StatusCodes.Status500InternalServerError
        };

        return StatusCode(status, new ApiError(error.Code, error.Message, status, CorrelationId, error.Details));
    }
}
