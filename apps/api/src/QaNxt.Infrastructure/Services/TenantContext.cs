using QaNxt.Application.Abstractions;
using Microsoft.Extensions.Logging;

namespace QaNxt.Infrastructure.Services;

/// <summary>Scoped per request (or per job). Middleware binds it from the caller's token;
/// background jobs elevate explicitly, and every elevation is logged so a cross-tenant
/// read is never invisible.</summary>
public sealed class TenantContext : ITenantContext
{
    private readonly ILogger<TenantContext> _logger;
    private int _systemDepth;

    public TenantContext(ILogger<TenantContext> logger) => _logger = logger;

    public Guid? OrganizationId { get; private set; }
    public bool IsSystemContext => _systemDepth > 0;

    public void SetOrganization(Guid organizationId) => OrganizationId = organizationId;

    public IDisposable EnterSystemContext(string reason)
    {
        _systemDepth++;
        _logger.LogInformation("Entering cross-tenant system context: {Reason}", reason);
        return new Scope(this, reason);
    }

    private sealed class Scope : IDisposable
    {
        private readonly TenantContext _owner;
        private readonly string _reason;
        private bool _disposed;
        public Scope(TenantContext owner, string reason) { _owner = owner; _reason = reason; }
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _owner._systemDepth--;
            _owner._logger.LogDebug("Left cross-tenant system context: {Reason}", _reason);
        }
    }
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}
