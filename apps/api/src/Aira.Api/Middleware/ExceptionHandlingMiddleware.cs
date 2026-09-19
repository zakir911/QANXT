using System.Text.Json;
using Aira.Application.Contracts;
using Aira.Domain.Common;

namespace Aira.Api.Middleware;

/// <summary>Turns unhandled exceptions into RFC7807-shaped problem responses that carry the
/// correlation id. Exceptions are always logged in full; clients get a structured, actionable
/// message without internal detail. Nothing is swallowed.</summary>
public sealed class ExceptionHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ExceptionHandlingMiddleware> _logger;
    private readonly IHostEnvironment _environment;

    public ExceptionHandlingMiddleware(RequestDelegate next, ILogger<ExceptionHandlingMiddleware> logger, IHostEnvironment environment)
    {
        _next = next;
        _logger = logger;
        _environment = environment;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            _logger.LogInformation("Request {Path} was cancelled by the client.", context.Request.Path);
            if (!context.Response.HasStarted) context.Response.StatusCode = 499;
        }
        catch (Exception ex)
        {
            var correlationId = context.Items[Services.CorrelationContext.HeaderName] as string ?? context.TraceIdentifier;
            _logger.LogError(ex, "Unhandled exception on {Method} {Path}", context.Request.Method, context.Request.Path);

            if (context.Response.HasStarted)
            {
                _logger.LogWarning("Response already started; cannot write an error payload for {CorrelationId}.", correlationId);
                return;
            }

            var (status, code, message) = ex switch
            {
                InvalidOperationException e when e.Message.StartsWith("Cross-tenant write blocked", StringComparison.Ordinal)
                    => (StatusCodes.Status403Forbidden, "tenant_violation", "The operation was blocked because it crosses an organization boundary."),
                UnauthorizedAccessException => (StatusCodes.Status403Forbidden, "forbidden", "You do not have permission to perform this action."),
                ArgumentException => (StatusCodes.Status400BadRequest, "invalid_argument", ex.Message),
                TimeoutException => (StatusCodes.Status504GatewayTimeout, "timeout", "The operation timed out."),
                _ => (StatusCodes.Status500InternalServerError, "internal_error", "An unexpected error occurred.")
            };

            context.Response.StatusCode = status;
            context.Response.ContentType = "application/problem+json";

            var payload = new
            {
                type = $"https://docs.aira.dev/errors/{code}",
                title = message,
                status,
                code,
                correlationId,
                detail = _environment.IsDevelopment() ? ex.ToString() : null
            };

            await context.Response.WriteAsync(JsonSerializer.Serialize(payload, JsonDefaults.Options));
        }
    }
}
