using System.Text.Json;
using System.Text.Json.Serialization;
using Aira.Domain.Enums;

namespace Aira.Application.Contracts;

/// <summary>How an HTTP request is described so it can be executed identically every time.
///
/// The API-testing counterpart to <see cref="LocatorDescriptor"/>: declarative data, not
/// code. That is what lets a request be stored, diffed, replayed, reported on and — the
/// point of this file — validated against a closed shape before anything is sent.
///
/// Credentials are never stored here literally. They travel as <c>${secret:name}</c>
/// references and are resolved at dispatch, exactly as step values are.</summary>
public sealed record ApiRequestDescriptor
{
    [JsonPropertyName("method")] public string Method { get; init; } = "GET";

    /// <summary>Absolute, or relative to the environment's API base URL.</summary>
    [JsonPropertyName("path")] public string Path { get; init; } = string.Empty;

    [JsonPropertyName("query")] public Dictionary<string, string>? Query { get; init; }
    [JsonPropertyName("headers")] public Dictionary<string, string>? Headers { get; init; }
    [JsonPropertyName("body")] public string? Body { get; init; }
    [JsonPropertyName("contentType")] public string? ContentType { get; init; }
    [JsonPropertyName("auth")] public ApiAuthDescriptor? Auth { get; init; }
    [JsonPropertyName("timeoutMs")] public int? TimeoutMs { get; init; }

    /// <summary>When false, a 4xx or 5xx is not a step failure in itself and only the
    /// assertions decide. A negative test needs this: asserting a 401 must not also fail
    /// on the 401.</summary>
    [JsonPropertyName("failOnErrorStatus")] public bool? FailOnErrorStatus { get; init; }

    /// <summary>Pulls values out of the response for later steps: <c>{"accountId":
    /// "data[0].id"}</c> binds <c>${data:accountId}</c>.</summary>
    [JsonPropertyName("capture")] public Dictionary<string, string>? Capture { get; init; }
}

public sealed record ApiAuthDescriptor
{
    [JsonPropertyName("mode")] public ApiAuthMode Mode { get; init; } = ApiAuthMode.InheritSession;
    [JsonPropertyName("token")] public string? Token { get; init; }
    [JsonPropertyName("username")] public string? Username { get; init; }
    [JsonPropertyName("password")] public string? Password { get; init; }
    [JsonPropertyName("keyName")] public string? KeyName { get; init; }
    [JsonPropertyName("keyValue")] public string? KeyValue { get; init; }
    [JsonPropertyName("tokenUrl")] public string? TokenUrl { get; init; }
    [JsonPropertyName("clientId")] public string? ClientId { get; init; }
    [JsonPropertyName("clientSecret")] public string? ClientSecret { get; init; }
    [JsonPropertyName("scope")] public string? Scope { get; init; }
}

/// <summary>Strict, closed-world validation of a request before it is stored or executed.
///
/// Held to the same standard as <see cref="BrowserActionValidator"/>, and for the same
/// reason: a request may have been proposed by a model, and a model's output is data to be
/// checked rather than an instruction to be followed. What is enforced here is the part
/// that cannot be enforced later — a method outside the set, a path that is not a path, a
/// credential written into the test instead of referenced, an absolute URL outside the
/// project's boundary.</summary>
public static class ApiRequestValidator
{
    public static readonly string[] AllowedMethods =
        { "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" };

    public static readonly string[] MutatingMethods = { "POST", "PUT", "PATCH", "DELETE" };

    /// <summary>Headers AIRA sets itself, or that would let a test override the boundary.
    /// A test that sets Host can make a request arrive somewhere the allowlist cleared a
    /// different name for.</summary>
    private static readonly string[] ForbiddenHeaders = { "host", "content-length", "connection", "transfer-encoding" };

    /// <summary>Values that look like a real credential rather than a reference.</summary>
    private static readonly string[] CredentialHints = { "bearer ", "basic ", "password=", "apikey=", "api_key=" };

    public static BrowserActionValidationResult Validate(ApiRequestDescriptor request, BrowserActionPolicy policy)
    {
        var errors = new List<string>();

        var method = (request.Method ?? string.Empty).Trim().ToUpperInvariant();
        if (!AllowedMethods.Contains(method))
            errors.Add($"'{request.Method}' is not a supported HTTP method. Use one of {string.Join(", ", AllowedMethods)}.");

        if (string.IsNullOrWhiteSpace(request.Path))
            errors.Add("An API request requires a path.");
        else if (request.Path.Length > 2000)
            errors.Add("The request path exceeds 2000 characters.");
        else if (IsAbsolute(request.Path))
        {
            // A relative path is resolved against the environment at execution time and
            // guarded there. An absolute one is checked now as well, so a request that
            // could never be allowed is refused at authoring time rather than at 3am.
            if (!policy.UrlGuard(request.Path, out var reason))
                errors.Add($"The request to '{request.Path}' is not allowed: {reason}");
        }
        else if (!request.Path.StartsWith('/'))
        {
            errors.Add("A relative request path must start with '/'.");
        }

        if (request.Body is { Length: > 1_000_000 })
            errors.Add("The request body exceeds 1MB.");

        if (request.TimeoutMs is < 0 or > 300_000)
            errors.Add("timeoutMs must be between 0 and 300000.");

        foreach (var (name, value) in request.Headers ?? new Dictionary<string, string>())
        {
            if (string.IsNullOrWhiteSpace(name))
                errors.Add("A request header must have a name.");
            else if (ForbiddenHeaders.Contains(name.Trim().ToLowerInvariant()))
                errors.Add($"The header '{name}' is set by the execution engine and cannot be overridden by a test.");
            else if (name.Any(c => c is '\r' or '\n' or ':'))
                errors.Add($"The header name '{name}' contains characters that are not permitted in a header name.");

            if (value is not null && value.Any(c => c is '\r' or '\n'))
                errors.Add($"The value of header '{name}' contains a line break.");

            if (LooksLikeACredential(value))
                errors.Add($"The header '{name}' appears to contain a literal credential. Use a ${{secret:name}} reference.");
        }

        foreach (var (name, path) in request.Capture ?? new Dictionary<string, string>())
        {
            if (!IsIdentifier(name))
                errors.Add($"'{name}' is not a usable test-data name. Use letters, digits, '_', '-' and '.'.");
            if (string.IsNullOrWhiteSpace(path))
                errors.Add($"The capture '{name}' has no JSON path.");
            else if (!IsJsonPath(path))
                errors.Add($"'{path}' is not a supported JSON path. Use names, dots and [n] indexes.");
        }

        if (LooksLikeACredential(request.Body))
            errors.Add("The request body appears to contain a literal credential. Use a ${secret:name} reference.");

        ValidateAuth(request.Auth, policy, errors);

        return errors.Count == 0
            ? BrowserActionValidationResult.Valid
            : new BrowserActionValidationResult(false, errors);
    }

    /// <summary>True when this request changes state, and so needs an environment that
    /// permits writes.</summary>
    public static bool IsMutating(ApiRequestDescriptor request) =>
        MutatingMethods.Contains((request.Method ?? string.Empty).Trim().ToUpperInvariant());

    private static void ValidateAuth(ApiAuthDescriptor? auth, BrowserActionPolicy policy, List<string> errors)
    {
        if (auth is null) return;

        if (!Enum.IsDefined(typeof(ApiAuthMode), auth.Mode))
        {
            errors.Add("Unknown API authentication mode.");
            return;
        }

        switch (auth.Mode)
        {
            case ApiAuthMode.Bearer:
                if (string.IsNullOrWhiteSpace(auth.Token))
                    errors.Add("Bearer authentication requires a token, normally a ${secret:name} reference.");
                else if (!IsReference(auth.Token!))
                    errors.Add("A bearer token must be a ${secret:name} reference rather than a literal.");
                break;

            case ApiAuthMode.Basic:
                if (string.IsNullOrWhiteSpace(auth.Username))
                    errors.Add("Basic authentication requires a username.");
                if (!string.IsNullOrEmpty(auth.Password) && !IsReference(auth.Password!))
                    errors.Add("A basic-auth password must be a ${secret:name} reference rather than a literal.");
                break;

            case ApiAuthMode.ApiKeyHeader:
            case ApiAuthMode.ApiKeyQuery:
                if (string.IsNullOrWhiteSpace(auth.KeyName))
                    errors.Add("API-key authentication requires the name of the header or query parameter.");
                if (string.IsNullOrWhiteSpace(auth.KeyValue))
                    errors.Add("API-key authentication requires a value, normally a ${secret:name} reference.");
                else if (!IsReference(auth.KeyValue!))
                    errors.Add("An API key must be a ${secret:name} reference rather than a literal.");
                break;

            case ApiAuthMode.OAuth2ClientCredentials:
                if (string.IsNullOrWhiteSpace(auth.TokenUrl))
                    errors.Add("OAuth2 authentication requires a token URL.");
                else if (!policy.UrlGuard(auth.TokenUrl!, out var reason))
                    errors.Add($"The token endpoint '{auth.TokenUrl}' is outside this project's allowed hosts: {reason}");
                if (string.IsNullOrWhiteSpace(auth.ClientId))
                    errors.Add("OAuth2 authentication requires a client id.");
                if (string.IsNullOrWhiteSpace(auth.ClientSecret))
                    errors.Add("OAuth2 authentication requires a client secret, as a ${secret:name} reference.");
                else if (!IsReference(auth.ClientSecret!))
                    errors.Add("An OAuth2 client secret must be a ${secret:name} reference rather than a literal.");
                break;

            case ApiAuthMode.None:
            case ApiAuthMode.InheritSession:
            default:
                break;
        }
    }

    private static bool IsAbsolute(string path) =>
        path.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
        || path.StartsWith("https://", StringComparison.OrdinalIgnoreCase);

    private static bool IsReference(string value) =>
        value.StartsWith("${secret:", StringComparison.Ordinal) || value.StartsWith("${data:", StringComparison.Ordinal);

    private static bool LooksLikeACredential(string? value)
    {
        if (string.IsNullOrEmpty(value) || IsReference(value)) return false;
        var lowered = value.ToLowerInvariant();
        return CredentialHints.Any(hint => lowered.Contains(hint));
    }

    private static bool IsIdentifier(string value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 64
        && value.All(c => char.IsLetterOrDigit(c) || c is '_' or '-' or '.');

    /// <summary>The supported path grammar: <c>a.b[0].c</c>, optionally prefixed with
    /// <c>$.</c>. Deliberately small — a wildcard or filter expression would make a
    /// generated assertion's behaviour unpredictable to the person reviewing it.</summary>
    public static bool IsJsonPath(string path)
    {
        if (path.Length > 200) return false;
        var body = path.StartsWith("$.", StringComparison.Ordinal) ? path[2..]
            : path == "$" ? string.Empty
            : path;
        if (body.Length == 0) return true;
        return System.Text.RegularExpressions.Regex.IsMatch(
            body, @"^[A-Za-z_][A-Za-z0-9_-]*(\[\d+\]|\.[A-Za-z_][A-Za-z0-9_-]*|\.\d+)*$");
    }

    /// <summary>Serialises a descriptor for storage on the step.</summary>
    public static string Serialize(ApiRequestDescriptor request) =>
        JsonSerializer.Serialize(request, SerializerOptions);

    public static ApiRequestDescriptor? Deserialize(string? json) =>
        string.IsNullOrWhiteSpace(json) ? null : JsonSerializer.Deserialize<ApiRequestDescriptor>(json, SerializerOptions);

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };
}
