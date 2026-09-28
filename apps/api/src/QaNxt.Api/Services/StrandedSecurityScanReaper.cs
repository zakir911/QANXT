using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;

namespace QaNxt.Api.Services;

/// <summary>Runs <see cref="ISecurityScanReaper"/> on a timer.
///
/// Deliberately thin: everything that decides anything lives in the reaper, where it can be
/// tested without waiting an hour for a sweep. What is left here is the schedule, the grace
/// period and the promise that one bad sweep does not take the loop down.</summary>
public sealed class StrandedSecurityScanReaper : BackgroundService
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromMinutes(2);

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _configuration;
    private readonly ILogger<StrandedSecurityScanReaper> _logger;

    public StrandedSecurityScanReaper(IServiceScopeFactory scopes, IConfiguration configuration,
        ILogger<StrandedSecurityScanReaper> logger)
    {
        _scopes = scopes;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Longer than the execution grace, because a scan legitimately takes longer than a test:
        // a scope's own MaxScanDurationMinutes runs to tens of minutes, and a scan cut off while
        // it is still working would throw away real findings.
        var graceMinutes = _configuration.GetValue("Security:StrandedAfterMinutes", 60);
        var grace = TimeSpan.FromMinutes(Math.Clamp(graceMinutes, 1, 720));

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopes.CreateScope();
                var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
                using var _ = tenant.EnterSystemContext("reconciling security scans no worker is reporting");

                var reaper = scope.ServiceProvider.GetRequiredService<ISecurityScanReaper>();
                var swept = await reaper.SweepAsync(grace, stoppingToken);

                if (swept.Abandoned > 0)
                {
                    _logger.LogWarning("Abandoned {Count} security scan(s) no worker reported: {References}",
                        swept.Abandoned, string.Join(", ", swept.References));
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                // A failed sweep must not take the reaper down; the next one may succeed.
                _logger.LogError(exception, "The stranded-security-scan sweep failed");
            }

            await Task.Delay(SweepInterval, stoppingToken);
        }
    }
}
