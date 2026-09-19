using Aira.Api.Services;
using Serilog.Context;

namespace Aira.Api.Middleware;

/// <summary>Establishes the correlation id for the request and pushes the identifiers every
/// log line should carry. Without this, tracing one test execution across the API, the queue
/// and a worker means guessing.</summary>
public sealed class CorrelationMiddleware
{
    private readonly RequestDelegate _next;
    public CorrelationMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = context.Request.Headers[CorrelationContext.HeaderName].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(correlationId) || correlationId.Length > 64)
            correlationId = Guid.NewGuid().ToString("N");

        context.Items[CorrelationContext.HeaderName] = correlationId;
        context.Response.Headers[CorrelationContext.HeaderName] = correlationId;

        using (LogContext.PushProperty("CorrelationId", correlationId))
        using (LogContext.PushProperty("RequestId", context.TraceIdentifier))
        {
            await _next(context);
        }
    }
}
