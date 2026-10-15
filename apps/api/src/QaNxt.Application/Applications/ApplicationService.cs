using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ApplicationEntity = QaNxt.Domain.Applications.Application;

namespace QaNxt.Application.Applications;

/// <param name="OtpMode">The second step some sign-ins ask for after the password:
/// <c>none</c>; <c>fixed</c>, a code a test environment always accepts; or <c>totp</c>, the
/// secret behind an authenticator app, from which a fresh code is made at each sign-in. An SMS
/// or email code cannot be read from here and needs one of the two.</param>
/// <param name="OtpValue">The fixed code, or the authenticator secret (base32).</param>
public sealed record ApplicationCredentials(string? Username, string? Password, string? BearerToken, string? StorageStateJson,
    string? OtpMode = null, string? OtpValue = null);

public sealed record CreateApplicationRequest(
    Guid ProjectId, string Name, string BaseUrl, string? Description,
    string? AllowedDomains, string? ExcludedPaths,
    int? MaxCrawlDepth, int? MaxPages, int? MaxActions, int? ExplorationTimeoutSeconds,
    AuthenticationStrategy AuthStrategy, string? LoginUrl, string? LoginFlowJson,
    ApplicationCredentials? Credentials, bool? RespectRobotsTxt = null,
    string? InteractionMode = null, bool? AllowStateChangingClicks = null,
    string? SeedUrls = null, bool? UseSitemap = null);

public sealed record UpdateApplicationRequest(
    string? Name, string? BaseUrl, string? Description, string? AllowedDomains, string? ExcludedPaths,
    int? MaxCrawlDepth, int? MaxPages, int? MaxActions, int? ExplorationTimeoutSeconds,
    AuthenticationStrategy? AuthStrategy, string? LoginUrl, string? LoginFlowJson,
    ApplicationCredentials? Credentials, bool? RespectRobotsTxt = null,
    string? InteractionMode = null, bool? AllowStateChangingClicks = null,
    string? SeedUrls = null, bool? UseSitemap = null);

public sealed record ApplicationSummary(
    Guid Id, Guid ProjectId, string Name, string BaseUrl, string Description,
    AuthenticationStrategy AuthStrategy, bool HasCredentials,
    int PageCount, int ElementCount, int ApiEndpointCount, int JourneyCount,
    DateTimeOffset? LastDiscoveredAt, DiscoveryStatus? LastDiscoveryStatus,
    // Part of the summary and not only the detail, because it changes what a crawl will do
    // and the console lists applications rather than opening them one at a time.
    bool RespectRobotsTxt, string InteractionMode, DateTimeOffset CreatedAt);

public sealed record ApplicationDetail(
    Guid Id, Guid ProjectId, string Name, string BaseUrl, string Description,
    string AllowedDomains, string ExcludedPaths, int MaxCrawlDepth, int MaxPages, int MaxActions,
    int ExplorationTimeoutSeconds, bool RespectRobotsTxt,
    string InteractionMode, bool AllowStateChangingClicks,
    string SeedUrls, bool UseSitemap,
    AuthenticationStrategy AuthStrategy, string? LoginUrl, string? LoginFlowJson,
    bool HasCredentials, DateTimeOffset CreatedAt, DateTimeOffset? UpdatedAt);

public interface IApplicationService
{
    Task<IReadOnlyList<ApplicationSummary>> ListAsync(Guid? projectId, CancellationToken ct = default);
    Task<Result<ApplicationDetail>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<ApplicationDetail>> CreateAsync(CreateApplicationRequest request, CancellationToken ct = default);
    Task<Result<ApplicationDetail>> UpdateAsync(Guid id, UpdateApplicationRequest request, CancellationToken ct = default);
    Task<Result> DeleteAsync(Guid id, CancellationToken ct = default);
    /// <summary>Decrypts an application's credentials for dispatch to a worker. Never exposed over HTTP.</summary>
    Task<ApplicationCredentials> ResolveCredentialsAsync(ApplicationEntity application, CancellationToken ct = default);
}

public sealed class ApplicationService : IApplicationService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly ISecretProtector _protector;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ITargetPolicy _targetPolicy;
    private readonly ILogger<ApplicationService> _logger;

    public ApplicationService(IQaNxtDbContext db, ICurrentUser currentUser, ISecretProtector protector,
        IClock clock, IAuditLogger audit, ITargetPolicy targetPolicy, ILogger<ApplicationService> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _protector = protector;
        _clock = clock;
        _audit = audit;
        _targetPolicy = targetPolicy;
        _logger = logger;
    }

    public async Task<IReadOnlyList<ApplicationSummary>> ListAsync(Guid? projectId, CancellationToken ct = default)
    {
        var query = _db.Applications.AsQueryable();
        if (projectId is not null) query = query.Where(a => a.ProjectId == projectId);

        return await query
            .OrderBy(a => a.Name)
            .Select(a => new ApplicationSummary(
                a.Id, a.ProjectId, a.Name, a.BaseUrl, a.Description, a.AuthStrategy,
                a.EncryptedCredentials != null,
                _db.ApplicationPages.Count(p => p.ApplicationId == a.Id),
                _db.ApplicationElements.Count(e => _db.ApplicationPages
                    .Where(p => p.ApplicationId == a.Id).Select(p => p.Id).Contains(e.ApplicationPageId)),
                _db.ApiEndpoints.Count(e => e.ApplicationId == a.Id),
                _db.Journeys.Count(j => j.ApplicationId == a.Id),
                // When the application was last explored, which is when a run FINISHED. This
                // was the newest run's CreatedAt — the moment it was queued — so the console
                // said "last explored just now" the instant somebody pressed Run discovery,
                // beside a Queued badge and four zeroes. Nothing had been explored yet.
                _db.DiscoveryRuns.Where(r => r.ApplicationId == a.Id && r.CompletedAt != null)
                    .OrderByDescending(r => r.CompletedAt).Select(r => r.CompletedAt).FirstOrDefault(),
                // The newest run's status, queued ones included: that is the badge, and a
                // queued run is exactly what it should say.
                _db.DiscoveryRuns.Where(r => r.ApplicationId == a.Id)
                    .OrderByDescending(r => r.CreatedAt).Select(r => (DiscoveryStatus?)r.Status).FirstOrDefault(),
                a.RespectRobotsTxt,
                a.InteractionMode,
                a.CreatedAt))
            .ToListAsync(ct);
    }

    public async Task<Result<ApplicationDetail>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == id, ct);
        return application is null ? Error.NotFound("The application") : Result<ApplicationDetail>.Success(Map(application));
    }

    public async Task<Result<ApplicationDetail>> CreateAsync(CreateApplicationRequest request, CancellationToken ct = default)
    {
        var organizationId = _currentUser.OrganizationId;
        if (organizationId is null) return Error.Unauthorized();

        if (!await _db.Projects.AnyAsync(p => p.Id == request.ProjectId, ct))
            return Error.NotFound("The project");

        var validation = ValidateUrls(request.BaseUrl, request.LoginUrl, request.AllowedDomains);
        if (validation is not null) return Result<ApplicationDetail>.Failure(validation);

        var budget = ValidateBudget(request.MaxCrawlDepth, request.MaxPages, request.MaxActions, request.ExplorationTimeoutSeconds);
        if (budget is not null) return Result<ApplicationDetail>.Failure(budget);

        if (string.IsNullOrWhiteSpace(request.Name))
            return Error.Validation("An application name is required.");

        var application = new ApplicationEntity
        {
            OrganizationId = organizationId.Value,
            ProjectId = request.ProjectId,
            Name = request.Name.Trim(),
            BaseUrl = request.BaseUrl.Trim(),
            Description = request.Description?.Trim() ?? string.Empty,
            // The base URL's own host is always permitted; anything else has to be asked for.
            AllowedDomains = NormalizeAllowlist(request.AllowedDomains, request.BaseUrl),
            ExcludedPaths = ExclusionsOrDefault(request.ExcludedPaths),
            MaxCrawlDepth = request.MaxCrawlDepth ?? 3,
            MaxPages = request.MaxPages ?? 50,
            MaxActions = request.MaxActions ?? 400,
            ExplorationTimeoutSeconds = request.ExplorationTimeoutSeconds ?? 600,
            // On unless somebody says otherwise. The crawler enforces this, so turning it
            // off is a decision about somebody else's application and is audited below.
            RespectRobotsTxt = request.RespectRobotsTxt ?? true,
            AuthStrategy = request.AuthStrategy,
            LoginUrl = request.LoginUrl?.Trim(),
            LoginFlowJson = request.LoginFlowJson,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        var createMode = NormalizeInteractionMode(request.InteractionMode);
        if (!createMode.IsSuccess) return Result<ApplicationDetail>.Failure(createMode.Error!);
        application.InteractionMode = createMode.Value!;
        application.AllowStateChangingClicks = request.AllowStateChangingClicks ?? false;
        application.SeedUrls = NormalizeSeedUrls(request.SeedUrls);
        application.UseSitemap = request.UseSitemap ?? true;

        if (request.Credentials is not null)
        {
            if (OtpProblem(request.Credentials, valueRequired: true) is { } otpProblem) return Error.Validation(otpProblem);
            var otpMode = NormalizeOtpMode(request.Credentials.OtpMode);
            application.EncryptedCredentials = Protect(request.Credentials with
            {
                OtpMode = otpMode is "none" ? null : otpMode,
                OtpValue = otpMode is null or "none" ? null : request.Credentials.OtpValue?.Trim()
            });
        }

        _db.Applications.Add(application);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ApplicationCreated, nameof(ApplicationEntity), application.Id,
            $"Application '{application.Name}' added for {application.BaseUrl}.",
            projectId: application.ProjectId, ct: ct);

        if (!application.RespectRobotsTxt)
        {
            // ConfigurationChanged rather than ApplicationCreated or ApplicationUpdated: this
            // is one decision about how the crawler treats somebody else's site, and it reads
            // the same in the trail whether it was made at registration or afterwards.
            await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(ApplicationEntity), application.Id,
                $"robots.txt will NOT be respected when exploring '{application.Name}'.",
                projectId: application.ProjectId, ct: ct);
        }

        await LogInteractionAsync(application, ct);

        if (request.Credentials is not null)
        {
            await _audit.LogAsync(AuditAction.SecretConfigured, nameof(ApplicationEntity), application.Id,
                $"Credentials configured for application '{application.Name}'.",
                projectId: application.ProjectId, ct: ct);
        }

        return Result<ApplicationDetail>.Success(Map(application));
    }

    public async Task<Result<ApplicationDetail>> UpdateAsync(Guid id, UpdateApplicationRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (application is null) return Error.NotFound("The application");

        var baseUrl = request.BaseUrl?.Trim() ?? application.BaseUrl;
        var validation = ValidateUrls(baseUrl, request.LoginUrl ?? application.LoginUrl, request.AllowedDomains ?? application.AllowedDomains);
        if (validation is not null) return Result<ApplicationDetail>.Failure(validation);

        var budget = ValidateBudget(request.MaxCrawlDepth, request.MaxPages, request.MaxActions, request.ExplorationTimeoutSeconds);
        if (budget is not null) return Result<ApplicationDetail>.Failure(budget);

        if (request.Name is not null) application.Name = request.Name.Trim();
        if (request.BaseUrl is not null) application.BaseUrl = baseUrl;
        if (request.Description is not null) application.Description = request.Description.Trim();
        if (request.AllowedDomains is not null) application.AllowedDomains = NormalizeAllowlist(request.AllowedDomains, application.BaseUrl);
        if (request.ExcludedPaths is not null) application.ExcludedPaths = ExclusionsOrDefault(request.ExcludedPaths);
        if (request.MaxCrawlDepth is not null) application.MaxCrawlDepth = request.MaxCrawlDepth.Value;
        if (request.MaxPages is not null) application.MaxPages = request.MaxPages.Value;
        if (request.MaxActions is not null) application.MaxActions = request.MaxActions.Value;
        if (request.ExplorationTimeoutSeconds is not null) application.ExplorationTimeoutSeconds = request.ExplorationTimeoutSeconds.Value;
        if (request.RespectRobotsTxt is { } respectRobots && respectRobots != application.RespectRobotsTxt)
        {
            application.RespectRobotsTxt = respectRobots;
            await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(ApplicationEntity), application.Id,
                respectRobots
                    ? $"robots.txt will be respected when exploring '{application.Name}'."
                    : $"robots.txt will NOT be respected when exploring '{application.Name}'.",
                projectId: application.ProjectId, ct: ct);
        }
        if (request.InteractionMode is not null || request.AllowStateChangingClicks is not null)
        {
            var mode = NormalizeInteractionMode(request.InteractionMode ?? application.InteractionMode);
            if (!mode.IsSuccess) return Result<ApplicationDetail>.Failure(mode.Error!);

            var changed = mode.Value! != application.InteractionMode
                       || (request.AllowStateChangingClicks ?? application.AllowStateChangingClicks)
                          != application.AllowStateChangingClicks;

            application.InteractionMode = mode.Value!;
            application.AllowStateChangingClicks =
                request.AllowStateChangingClicks ?? application.AllowStateChangingClicks;

            if (changed) await LogInteractionAsync(application, ct);
        }

        if (request.SeedUrls is not null) application.SeedUrls = NormalizeSeedUrls(request.SeedUrls);
        if (request.UseSitemap is not null) application.UseSitemap = request.UseSitemap.Value;

        if (request.AuthStrategy is not null) application.AuthStrategy = request.AuthStrategy.Value;
        if (request.LoginUrl is not null) application.LoginUrl = request.LoginUrl.Trim();
        if (request.LoginFlowJson is not null) application.LoginFlowJson = request.LoginFlowJson;

        if (request.Credentials is not null)
        {
            // Credentials are write-only, so an edit that sets only the one-time code must not
            // wipe the stored username and password: blanks keep what is stored.
            var stored = string.IsNullOrEmpty(application.EncryptedCredentials) ? null : await ResolveCredentialsAsync(application, ct);
            var incoming = request.Credentials;
            var mode = NormalizeOtpMode(incoming.OtpMode) ?? stored?.OtpMode;
            // A blank value keeps the stored one only while the kind of code stays the same:
            // a fixed code is not an authenticator secret.
            var valueRequired = incoming.OtpMode is not null && mode != stored?.OtpMode;
            if (OtpProblem(incoming, valueRequired) is { } otpProblem) return Error.Validation(otpProblem);
            application.EncryptedCredentials = Protect(new ApplicationCredentials(
                Blank(incoming.Username) ? stored?.Username : incoming.Username,
                Blank(incoming.Password) ? stored?.Password : incoming.Password,
                incoming.BearerToken ?? stored?.BearerToken,
                incoming.StorageStateJson ?? stored?.StorageStateJson,
                mode is "none" ? null : mode,
                mode is null or "none" ? null : Blank(incoming.OtpValue) ? stored?.OtpValue : incoming.OtpValue!.Trim()));
            await _audit.LogAsync(AuditAction.SecretConfigured, nameof(ApplicationEntity), application.Id,
                $"Credentials updated for application '{application.Name}'.",
                projectId: application.ProjectId, ct: ct);
        }

        application.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ApplicationUpdated, nameof(ApplicationEntity), application.Id,
            $"Application '{application.Name}' updated.", projectId: application.ProjectId, ct: ct);

        return Result<ApplicationDetail>.Success(Map(application));
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (application is null) return Result.Failure(Error.NotFound("The application"));

        application.DeletedAt = _clock.UtcNow;
        application.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ApplicationUpdated, nameof(ApplicationEntity), application.Id,
            $"Application '{application.Name}' deleted.", projectId: application.ProjectId, ct: ct);
        return Result.Success();
    }

    public Task<ApplicationCredentials> ResolveCredentialsAsync(ApplicationEntity application, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(application.EncryptedCredentials))
            return Task.FromResult(new ApplicationCredentials(null, null, null, null));

        if (!_protector.TryUnprotect(application.EncryptedCredentials, out var json))
        {
            // A credential that will not decrypt is an operational problem, not a silent
            // no-op: the run would otherwise fail later with a confusing login error.
            _logger.LogError("Stored credentials for application {ApplicationId} could not be decrypted.", application.Id);
            throw new InvalidOperationException(
                $"The stored credentials for application '{application.Name}' could not be decrypted. They must be re-entered.");
        }

        var credentials = JsonSerializer.Deserialize<ApplicationCredentials>(json, JsonDefaults.Options)
            ?? new ApplicationCredentials(null, null, null, null);
        return Task.FromResult(credentials);
    }

    private static bool Blank(string? value) => string.IsNullOrWhiteSpace(value);

    /// <summary>Why a one-time-code setting cannot work, before it is stored and fails at the
    /// first sign-in instead.</summary>
    internal static string? OtpProblem(ApplicationCredentials credentials, bool valueRequired)
    {
        var mode = NormalizeOtpMode(credentials.OtpMode);
        if (mode is null or "none") return null;
        var value = credentials.OtpValue?.Trim() ?? string.Empty;
        return mode switch
        {
            "fixed" or "totp" when value.Length == 0 && valueRequired =>
                mode == "fixed" ? "Enter the fixed one-time code the test environment accepts."
                                : "Enter the authenticator secret for this test account.",
            "fixed" when value.Length == 0 => null, // keeps the stored code on an edit
            "fixed" when !System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z0-9]{4,10}$") =>
                "A fixed one-time code is 4 to 10 letters or digits, as the application expects it.",
            "totp" when value.Length == 0 => null,
            "totp" when !System.Text.RegularExpressions.Regex.IsMatch(value.Replace(" ", "").TrimEnd('='), "^[A-Za-z2-7]{16,}$") =>
                "An authenticator secret is the base32 key shown when the authenticator is set up (letters A–Z and digits 2–7, usually 16 or 32 of them), not a code from the app.",
            "fixed" or "totp" => null,
            _ => "The one-time code setting must be none, fixed or totp."
        };
    }

    internal static string? NormalizeOtpMode(string? mode)
        => string.IsNullOrWhiteSpace(mode) ? null : mode.Trim().ToLowerInvariant();

    private string Protect(ApplicationCredentials credentials)
        => _protector.Protect(JsonSerializer.Serialize(credentials, JsonDefaults.Options));

    private Error? ValidateUrls(string baseUrl, string? loginUrl, string? allowedDomains)
    {
        var allowlist = ParseAllowlist(allowedDomains, baseUrl);

        if (!_targetPolicy.IsAllowed(baseUrl, allowlist, out var reason))
            return Error.Validation($"The base URL is not permitted: {reason}");

        if (!string.IsNullOrWhiteSpace(loginUrl) && !_targetPolicy.IsAllowed(loginUrl!, allowlist, out var loginReason))
            return Error.Validation($"The login URL is not permitted: {loginReason}");

        return null;
    }

    private static Error? ValidateBudget(int? depth, int? pages, int? actions, int? timeout)
    {
        if (depth is < 1 or > 10) return Error.Validation("The crawl depth must be between 1 and 10.");
        if (pages is < 1 or > 1000) return Error.Validation("The page budget must be between 1 and 1000.");
        if (actions is < 1 or > 10_000) return Error.Validation("The action budget must be between 1 and 10000.");
        if (timeout is < 30 or > 7200) return Error.Validation("The exploration timeout must be between 30 and 7200 seconds.");
        return null;
    }

    /// <summary>Tidies the owner's route list into one comma-separated line.
    ///
    /// People paste these from a browser, a spreadsheet or a sitemap, so newlines, blank
    /// lines and stray spaces all arrive. Duplicates are dropped because a route listed
    /// twice is not two routes, and the crawl would skip the second anyway while the
    /// stored value implied otherwise.</summary>
    private static string NormalizeSeedUrls(string? requested)
    {
        if (string.IsNullOrWhiteSpace(requested)) return string.Empty;

        var entries = requested
            .Split(new[] { ',', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries
                                              | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase);

        return string.Join(',', entries);
    }

    /// <summary>The modes a crawl may run in. Anything else is refused rather than quietly
    /// treated as the safe default, because silently downgrading "interactive" to "links"
    /// would look like the setting did nothing.</summary>
    private static readonly string[] InteractionModes = { "links", "navigation", "interactive" };

    private static Result<string> NormalizeInteractionMode(string? requested)
    {
        var mode = requested?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(mode)) return Result<string>.Success("links");
        return InteractionModes.Contains(mode)
            ? Result<string>.Success(mode)
            : Error.Validation(
                $"'{requested}' is not a crawl interaction mode. Use links, navigation or interactive.");
    }

    public const string DefaultExcludedPaths = "/logout,/signout,/delete";

    /// <summary>The paths discovery must never open, or the default when none were chosen.</summary>
    /// <remarks>
    /// Blank means "I did not choose", which is the default. It used to mean "exclude
    /// nothing": the original was <c>request.ExcludedPaths?.Trim() ?? Default</c>, and
    /// <c>""?.Trim()</c> is <c>""</c>, not null, so the <c>??</c> never fired. Clearing the
    /// field in the console stored an empty list and silently dropped the only control
    /// stopping a crawl from opening sign-out or a delete link on somebody else's
    /// application (QA pass, ISSUE-001).
    ///
    /// Both Create and Update route through here so the rule cannot drift between them.
    /// There is deliberately no way to store an empty exclusion list: nobody has asked for
    /// one, and an accident is exactly what this prevents.
    /// </remarks>
    private static string ExclusionsOrDefault(string? requested)
    {
        var trimmed = requested?.Trim();
        return string.IsNullOrEmpty(trimmed) ? DefaultExcludedPaths : trimmed;
    }

    /// <summary>The base URL's host is always included, so a caller cannot lock the
    /// platform out of the application it was just asked to test.</summary>
    private static string NormalizeAllowlist(string? allowedDomains, string baseUrl)
        => string.Join(',', ParseAllowlist(allowedDomains, baseUrl));

    /// <param name="extraUrls">Further URLs whose hosts belong in the list — an
    /// environment's API base URL, say, when the API is not on the UI's origin. Hosts, not
    /// wildcards: this widens the allowlist by exactly the origins the configuration
    /// already names.</param>
    public static IReadOnlyList<string> ParseAllowlist(string? allowedDomains, string baseUrl, params string[] extraUrls)
    {
        var hosts = new List<string>();
        if (Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri)) hosts.Add(uri.Host);

        foreach (var extra in extraUrls)
        {
            if (!string.IsNullOrWhiteSpace(extra) && Uri.TryCreate(extra, UriKind.Absolute, out var extraUri))
                hosts.Add(extraUri.Host);
        }

        if (!string.IsNullOrWhiteSpace(allowedDomains))
        {
            hosts.AddRange(allowedDomains
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(h => h.ToLowerInvariant()));
        }

        return hosts.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }


    /// <summary>Records what a crawl of this application is now permitted to do.
    ///
    /// Written whenever it is anything other than the default, and written as a
    /// configuration change rather than an application update, because "the crawler may now
    /// click controls on this system" is a decision somebody should be able to find in the
    /// trail without reading a diff of every field.</summary>
    private async Task LogInteractionAsync(ApplicationEntity application, CancellationToken ct)
    {
        if (application.InteractionMode == "links" && !application.AllowStateChangingClicks) return;

        var what = application.InteractionMode switch
        {
            "navigation" => "click navigation controls",
            "interactive" => "click any control that does not look like it changes data",
            _ => "follow links only"
        };

        var andThen = application.AllowStateChangingClicks
            ? " It may ALSO click controls that look like they change data, including form submits."
            : string.Empty;

        await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(ApplicationEntity), application.Id,
            $"Discovery of '{application.Name}' may {what}.{andThen}",
            projectId: application.ProjectId, ct: ct);
    }

    private static ApplicationDetail Map(ApplicationEntity a) => new(
        a.Id, a.ProjectId, a.Name, a.BaseUrl, a.Description, a.AllowedDomains, a.ExcludedPaths,
        a.MaxCrawlDepth, a.MaxPages, a.MaxActions, a.ExplorationTimeoutSeconds, a.RespectRobotsTxt,
        a.InteractionMode, a.AllowStateChangingClicks,
        a.SeedUrls, a.UseSitemap,
        a.AuthStrategy, a.LoginUrl, a.LoginFlowJson, a.EncryptedCredentials != null, a.CreatedAt, a.UpdatedAt);
}

/// <summary>Applies the deployment's global target policy on top of an application's own
/// allowlist. Defined as a port so the policy (which depends on configuration) stays out
/// of the use case.</summary>
public interface ITargetPolicy
{
    bool IsAllowed(string url, IReadOnlyCollection<string> applicationAllowlist, out string reason);
    bool AllowPrivateNetworks { get; }
}
