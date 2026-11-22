using QaNxt.Application.Abstractions;
using QaNxt.Application.Discovery;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Security;

public interface ISecuritySurfaceService
{
    Task<Result<SecurityAttackSurface>> ForApplicationAsync(
        Guid applicationId, CancellationToken ct = default);
}

/// <summary>Reads the knowledge graph and hands it to the attack surface derivation.
///
/// Everything interesting is in <see cref="SecurityAttackSurfaceBuilder"/>, which is pure and
/// unit tested. This is the part that talks to the database, and it is deliberately thin so
/// the rules stay arguable in a test rather than inferred from a query.</summary>
public sealed class SecuritySurfaceService : ISecuritySurfaceService
{
    private readonly IQaNxtDbContext _db;
    public SecuritySurfaceService(IQaNxtDbContext db) => _db = db;

    public async Task<Result<SecurityAttackSurface>> ForApplicationAsync(
        Guid applicationId, CancellationToken ct = default)
    {
        var application = await _db.Applications.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null)
            return Result<SecurityAttackSurface>.Failure(Error.NotFound("The application"));

        var pages = await _db.ApplicationPages.AsNoTracking()
            .Where(p => p.ApplicationId == applicationId)
            .Select(p => new
            {
                p.Id, p.Route, p.NormalizedUrl, p.Kind, p.RequiresAuthentication, p.LastSeenAt, p.Url
            })
            .ToListAsync(ct);

        var pageIds = pages.Select(p => p.Id).ToList();
        var elements = await _db.ApplicationElements.AsNoTracking()
            .Where(e => pageIds.Contains(e.ApplicationPageId))
            .Select(e => new { e.ApplicationPageId, e.Kind, e.Name, e.Type, e.Label })
            .ToListAsync(ct);

        var elementsByPage = elements
            .GroupBy(e => e.ApplicationPageId)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<SecurityAttackSurfaceBuilder.ElementInput>)group
                    .Select(e => new SecurityAttackSurfaceBuilder.ElementInput(e.Kind, e.Name, e.Type, e.Label))
                    .ToList());

        var endpoints = await _db.ApiEndpoints.AsNoTracking()
            .Where(e => e.ApplicationId == applicationId)
            .Select(e => new SecurityAttackSurfaceBuilder.EndpointInput(
                e.Id, e.Method, e.UrlTemplate, e.SampleUrl, e.RequiresAuthentication,
                e.RequestContentType, e.RequestSampleJson, e.LastSeenAt))
            .ToListAsync(ct);

        // Forms, for the endpoints they declare they write to. Discovery never submits one, so
        // without this an API's writes are never on the surface and every write check is
        // skipped for the endpoints that actually write.
        var forms = await _db.ApplicationForms.AsNoTracking()
            .Where(f => f.ApplicationId == applicationId && f.IsPresent)
            .Select(f => new SecurityAttackSurfaceBuilder.FormInput(
                f.Id, f.Route, f.Action, f.Method, f.PageUrl, f.HasCsrfToken,
                f.Page!.RequiresAuthentication, f.LastSeenAt))
            .ToListAsync(ct);

        var pageInputs = pages.Select(p => new SecurityAttackSurfaceBuilder.PageInput(
            p.Id, p.Route, p.NormalizedUrl, p.Kind, p.RequiresAuthentication, p.LastSeenAt,
            elementsByPage.TryGetValue(p.Id, out var found)
                ? found
                : Array.Empty<SecurityAttackSurfaceBuilder.ElementInput>(),
            p.Url)).ToList();

        // Where the application signs in, from its own configuration: the login URL, or the
        // token endpoint a JSON sign-in declares in its login flow. A crawl cannot find this
        // — the authenticator uses it before the crawl starts, so it is never an observed
        // request, and a JSON sign-in has no login page to classify either.
        var signIn = SignInFrom(application);

        return Result<SecurityAttackSurface>.Success(
            SecurityAttackSurfaceBuilder.Build(applicationId, pageInputs, endpoints, forms, signIn));
    }

    /// <summary>
    /// The sign-in address the owner configured, preferring the token endpoint where the
    /// application signs in with one.
    ///
    /// The login flow's tokenEndpoint comes first because for a token sign-in the login URL
    /// may be a page a person visits while the endpoint is what receives the credentials, and
    /// the endpoint is the one worth testing. Relative values are resolved against the base
    /// URL; anything that is not an address is left out rather than guessed at.
    /// </summary>
    private static SecurityAttackSurfaceBuilder.SignInInput? SignInFrom(Domain.Applications.Application application)
    {
        var declared = DeclaredSignIn(application);
        return declared is null
            ? null
            : new SecurityAttackSurfaceBuilder.SignInInput(
                declared.Endpoint, application.UpdatedAt ?? application.CreatedAt);
    }

    /// <summary>What the owner said about this application's sign-in, resolved to an address
    /// and the names of the two fields that carry the credentials.
    ///
    /// Shared with the scan launcher, which passes it to the worker. The authentication
    /// checks have to be able to make a failed sign-in happen, and against a JSON API there
    /// is no form to submit: the engine's fallback was a guessed <c>POST /api/session</c>
    /// with a guessed body, so on an API whose sign-in is anywhere else every attempt was a
    /// 404 and the lockout check could only report that it had concluded nothing. The
    /// application has declared all of this since token sign-in was added; it was never
    /// handed to the scan.
    ///
    /// Field names are left null when unset rather than defaulted here, so the one place
    /// that knows the usual spellings stays the one place that tries them.</summary>
    public static DeclaredSignInDetails? DeclaredSignIn(Domain.Applications.Application application)
    {
        var declared = LoginFlowHints.Read(application.LoginFlowJson, "tokenEndpoint")
                       ?? application.LoginUrl;
        if (string.IsNullOrWhiteSpace(declared)) return null;

        if (!Uri.TryCreate(declared, UriKind.Absolute, out var absolute))
        {
            if (!Uri.TryCreate(application.BaseUrl, UriKind.Absolute, out var baseUri)) return null;
            if (!Uri.TryCreate(baseUri, declared, out absolute)) return null;
        }

        if (absolute.Scheme != Uri.UriSchemeHttp && absolute.Scheme != Uri.UriSchemeHttps) return null;

        // A token sign-in takes JSON; a form login is form-encoded. Where the owner declared
        // a token endpoint, that is what they declared it for.
        var isToken = LoginFlowHints.Read(application.LoginFlowJson, "tokenEndpoint") is not null
                      || application.AuthStrategy == AuthenticationStrategy.TokenLogin;

        return new DeclaredSignInDetails(
            absolute.ToString(),
            "POST",
            isToken ? "json" : "form",
            LoginFlowHints.Read(application.LoginFlowJson, "usernameField"),
            LoginFlowHints.Read(application.LoginFlowJson, "passwordField"));
    }
}

/// <summary>A sign-in the owner declared: the address, how the credentials are carried, and
/// the field names when they were given.</summary>
public sealed record DeclaredSignInDetails(
    string Endpoint, string Method, string ContentType, string? UsernameField, string? PasswordField);
