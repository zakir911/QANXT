using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Testing;

public sealed record TestDataFieldRequest(
    string Key, TestDataKind Kind, string? Value, string? GeneratorJson, int? Seed, bool IsSensitive = false);

public sealed record CreateTestDataSetRequest(
    Guid ProjectId, string Name, string? Description, Guid? EnvironmentId,
    IReadOnlyList<TestDataFieldRequest>? Fields);

public sealed record UpdateTestDataSetRequest(
    string? Name, string? Description, Guid? EnvironmentId,
    /// <summary>Replaces the whole field list when given. Partial edits are not supported
    /// on purpose: a data set is small, and merging by key silently leaves behind fields
    /// somebody meant to remove.</summary>
    IReadOnlyList<TestDataFieldRequest>? Fields);

public sealed record TestDataFieldSummary(
    Guid Id, string Key, TestDataKind Kind, string? Value, string? GeneratorJson, int? Seed, bool IsSensitive);

public sealed record TestDataSetSummary(
    Guid Id, Guid ProjectId, string Name, string Description, Guid? EnvironmentId,
    IReadOnlyList<TestDataFieldSummary> Fields, DateTimeOffset CreatedAt);

/// <summary>One field resolved to the value a run would actually use.</summary>
public sealed record ResolvedField(string Key, TestDataKind Kind, string Value, bool IsSensitive);

public interface ITestDataService
{
    Task<IReadOnlyList<TestDataSetSummary>> ListAsync(Guid? projectId, CancellationToken ct = default);
    Task<Result<TestDataSetSummary>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<TestDataSetSummary>> CreateAsync(CreateTestDataSetRequest request, CancellationToken ct = default);
    Task<Result<TestDataSetSummary>> UpdateAsync(Guid id, UpdateTestDataSetRequest request, CancellationToken ct = default);
    Task<Result> DeleteAsync(Guid id, CancellationToken ct = default);

    /// <summary>
    /// What a run would use, without starting one.
    /// </summary>
    /// <remarks>
    /// The point of a seed is that a value can be predicted, and the way to check a data
    /// set is right is to see the values rather than to run a test and infer them from a
    /// screenshot. Sensitive fields are masked here: this is a preview, and a preview that
    /// prints a password is a password in somebody's terminal history.
    /// </remarks>
    Task<Result<IReadOnlyList<ResolvedField>>> PreviewAsync(Guid id, CancellationToken ct = default);
}

/// <summary>
/// Named data a test case uses, and where it comes from.
/// </summary>
/// <remarks>
/// <para>
/// The entities and the generator have existed since the first migration; the resolution
/// path in <see cref="TestRunService"/> reads them at dispatch. What was missing was any
/// way to put data in — no service, no controller. The same state schedules and
/// integrations were in.
/// </para>
/// <para>
/// <b>Credentials are never literals.</b> A password belongs in encrypted secret storage
/// and is referenced from here by name, as <c>${secret:app_password}</c>. This service
/// refuses a field that looks like a credential carrying a literal value, because a data
/// set is readable by anyone who can read the project and is exported in plain text by the
/// CLI.
/// </para>
/// </remarks>
public sealed class TestDataService : ITestDataService
{
    /// <summary>Field names whose value must be a secret reference rather than a literal.</summary>
    private static readonly string[] CredentialNames =
        ["password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "accesskey",
         "access_key", "privatekey", "private_key", "credential", "clientsecret", "client_secret",
         "authorization", "auth", "pin", "otp", "sessionid", "session_id", "cookie"];

    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IClock _clock;
    private readonly ILogger<TestDataService> _logger;

    public TestDataService(IQaNxtDbContext db, ICurrentUser user, IClock clock, ILogger<TestDataService> logger)
    {
        _db = db;
        _user = user;
        _clock = clock;
        _logger = logger;
    }

    public async Task<IReadOnlyList<TestDataSetSummary>> ListAsync(Guid? projectId, CancellationToken ct = default)
    {
        var query = _db.TestDataSets.AsNoTracking();
        if (projectId is not null) query = query.Where(s => s.ProjectId == projectId);

        var sets = await query.OrderBy(s => s.Name).ToListAsync(ct);
        var ids = sets.Select(s => s.Id).ToList();

        var fields = await _db.TestDataFields.AsNoTracking()
            .Where(f => ids.Contains(f.TestDataSetId))
            .ToListAsync(ct);

        return sets.Select(set => Project(set, fields.Where(f => f.TestDataSetId == set.Id))).ToList();
    }

    public async Task<Result<TestDataSetSummary>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var set = await _db.TestDataSets.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (set is null) return Error.NotFound("The test data set");

        var fields = await _db.TestDataFields.AsNoTracking()
            .Where(f => f.TestDataSetId == id).ToListAsync(ct);

        return Result<TestDataSetSummary>.Success(Project(set, fields));
    }

    public async Task<Result<TestDataSetSummary>> CreateAsync(CreateTestDataSetRequest request, CancellationToken ct = default)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");

        var name = (request.Name ?? string.Empty).Trim();
        if (name.Length == 0) return Error.Validation("A test data set needs a name.");

        var problems = Validate(request.Fields).ToArray();
        if (problems.Length > 0) return Problems(problems);

        if (request.EnvironmentId is not null)
        {
            var exists = await _db.Environments
                .AnyAsync(e => e.Id == request.EnvironmentId && e.ProjectId == request.ProjectId, ct);
            if (!exists) return Error.NotFound("The environment");
        }

        var set = new TestDataSet
        {
            OrganizationId = project.OrganizationId,
            ProjectId = project.Id,
            Name = name,
            Description = request.Description?.Trim() ?? string.Empty,
            EnvironmentId = request.EnvironmentId,
            CreatedByUserId = _user.UserId
        };

        _db.TestDataSets.Add(set);
        await _db.SaveChangesAsync(ct);

        var fields = Build(set, request.Fields);
        if (fields.Count > 0)
        {
            _db.TestDataFields.AddRange(fields);
            await _db.SaveChangesAsync(ct);
        }

        return Result<TestDataSetSummary>.Success(Project(set, fields));
    }

    public async Task<Result<TestDataSetSummary>> UpdateAsync(Guid id, UpdateTestDataSetRequest request, CancellationToken ct = default)
    {
        var set = await _db.TestDataSets.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (set is null) return Error.NotFound("The test data set");

        var problems = Validate(request.Fields).ToArray();
        if (problems.Length > 0) return Problems(problems);

        if (request.Name?.Trim() is { Length: > 0 } name) set.Name = name;
        if (request.Description is not null) set.Description = request.Description.Trim();
        if (request.EnvironmentId is not null) set.EnvironmentId = request.EnvironmentId;

        set.UpdatedByUserId = _user.UserId;
        set.UpdatedAt = _clock.UtcNow;

        List<TestDataField> fields;
        if (request.Fields is not null)
        {
            // Replaced wholesale. Merging by key would leave behind a field somebody
            // deleted, and a stale credential reference is the worst kind to leave behind.
            var existing = await _db.TestDataFields.Where(f => f.TestDataSetId == id).ToListAsync(ct);
            _db.TestDataFields.RemoveRange(existing);
            fields = Build(set, request.Fields);
            _db.TestDataFields.AddRange(fields);
        }
        else
        {
            fields = await _db.TestDataFields.Where(f => f.TestDataSetId == id).ToListAsync(ct);
        }

        await _db.SaveChangesAsync(ct);
        return Result<TestDataSetSummary>.Success(Project(set, fields));
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var set = await _db.TestDataSets.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (set is null) return Result.Failure(Error.NotFound("The test data set"));

        // Refused rather than cascaded: the tests would keep running and silently stop
        // getting their data, which looks like an application defect.
        var users = await _db.TestCases.CountAsync(t => t.TestDataSetId == id, ct);
        if (users > 0)
        {
            return Result.Failure(Error.Conflict("in_use",
                $"{users} test case(s) use this data set. Point them elsewhere first — deleting it "
                + "would leave them running with no data, which reads as an application defect."));
        }

        _db.TestDataFields.RemoveRange(await _db.TestDataFields.Where(f => f.TestDataSetId == id).ToListAsync(ct));
        _db.TestDataSets.Remove(set);
        await _db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<Result<IReadOnlyList<ResolvedField>>> PreviewAsync(Guid id, CancellationToken ct = default)
    {
        var set = await _db.TestDataSets.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (set is null) return Error.NotFound("The test data set");

        var fields = await _db.TestDataFields.AsNoTracking()
            .Where(f => f.TestDataSetId == id)
            .OrderBy(f => f.Key)
            .ToListAsync(ct);

        var resolved = fields.Select(field => new ResolvedField(
            field.Key,
            field.Kind,
            // A secret reference names a secret and is safe to show — seeing
            // "${secret:app_password}" is how somebody checks it points at the right one.
            // Anything else marked sensitive is masked: a preview that prints a password
            // is a password in somebody's shell history and their terminal's scrollback.
            field.Kind == TestDataKind.SecretReference
                ? field.Value ?? SecretMasker.Redacted
                : field.IsSensitive
                    ? SecretMasker.Redacted
                    : field.Kind is TestDataKind.Generated or TestDataKind.Random or TestDataKind.SeededRandom
                        ? TestDataGenerator.Generate(field.Key, field.GeneratorJson, field.Seed)
                        : field.Value ?? string.Empty,
            field.IsSensitive || field.Kind == TestDataKind.SecretReference))
            .ToList();

        return Result<IReadOnlyList<ResolvedField>>.Success(resolved);
    }

    // -----------------------------------------------------------------------

    /// <summary>
    /// Everything wrong with a submitted field list.
    /// </summary>
    /// <remarks>
    /// All of it at once rather than the first problem: somebody pasting a data set of
    /// twenty fields should not have to submit twenty times to find out about twenty typos.
    /// </remarks>
    private static IEnumerable<string> Validate(IReadOnlyList<TestDataFieldRequest>? fields)
    {
        if (fields is null) yield break;

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var field in fields)
        {
            var key = (field.Key ?? string.Empty).Trim();

            if (key.Length == 0) { yield return "A field needs a key."; continue; }
            if (!seen.Add(key)) yield return $"\"{key}\" appears more than once.";

            if (LooksLikeCredential(key) && field.Kind != TestDataKind.SecretReference)
            {
                // The rule the entity's own summary states: credentials are never stored
                // here as literals. A data set is readable by anyone who can read the
                // project and is exported in plain text by the CLI.
                yield return
                    $"\"{key}\" looks like a credential. Store it in the environment's secret storage and "
                    + $"reference it here with kind \"secretReference\" and value \"${{secret:{key}}}\" — "
                    + "a data set is readable by anyone who can read the project.";
                continue;
            }

            if (field.Kind == TestDataKind.SecretReference)
            {
                var value = field.Value ?? string.Empty;
                if (!value.StartsWith("${secret:", StringComparison.Ordinal) || !value.EndsWith('}'))
                {
                    yield return $"\"{key}\" is a secret reference, so its value must name a secret, "
                        + "as \"${secret:the_name}\". It must not contain the secret itself.";
                }
            }

            if (field.Kind is TestDataKind.Generated or TestDataKind.Random or TestDataKind.SeededRandom)
            {
                var type = TypeOf(field.GeneratorJson);
                if (type is not null && !TestDataGenerator.SupportedTypes.Contains(type))
                {
                    yield return $"\"{key}\" asks for generator type \"{type}\", which does not exist. "
                        + $"Available: {string.Join(", ", TestDataGenerator.SupportedTypes.OrderBy(t => t))}.";
                }

                if (field.Kind == TestDataKind.SeededRandom && field.Seed is null)
                {
                    // Otherwise the field is named "seeded" and is not, and a failure that
                    // depends on its value cannot be reproduced.
                    yield return $"\"{key}\" is seeded random but has no seed.";
                }
            }

            if (field.Kind == TestDataKind.Static && string.IsNullOrEmpty(field.Value))
                yield return $"\"{key}\" is static but has no value.";
        }
    }

    private static Error Problems(string[] problems) =>
        Error.Validation(
            problems.Length == 1 ? problems[0] : $"{problems.Length} problems with this data set.",
            new Dictionary<string, string[]> { ["fields"] = problems });

    /// <summary>
    /// Whether a field's name says it holds a credential.
    /// </summary>
    /// <remarks>
    /// Matched on whole words, never on substrings. Substring matching is tempting and
    /// wrong: "pin" occurs inside "shipping", "auth" inside "authorName", and a guard that
    /// refuses a shipping address teaches people to work around the guard.
    ///
    /// The key is split on separators and camel-case boundaries, and adjacent words are
    /// also joined so that "apiKey", "api_key" and "apikey" are all the same name.
    /// </remarks>
    public static bool LooksLikeCredential(string key)
    {
        var words = System.Text.RegularExpressions.Regex
            .Split(key, @"[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])")
            .Where(word => word.Length > 0)
            .Select(word => word.ToLowerInvariant())
            .ToList();

        if (words.Count == 0) return false;

        var candidates = new HashSet<string>(words);
        for (var i = 0; i + 1 < words.Count; i++) candidates.Add(words[i] + words[i + 1]);

        return CredentialNames.Any(name => candidates.Contains(name.Replace("_", string.Empty)));
    }

    private static string? TypeOf(string? generatorJson)
    {
        if (string.IsNullOrWhiteSpace(generatorJson)) return null;
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(generatorJson);
            return document.RootElement.TryGetProperty("type", out var type) && type.ValueKind == System.Text.Json.JsonValueKind.String
                ? type.GetString()
                : null;
        }
        catch (System.Text.Json.JsonException)
        {
            // A malformed spec is not refused here: the generator falls back to inferring
            // from the field's name, which is a working outcome rather than a broken one.
            return null;
        }
    }

    private static List<TestDataField> Build(TestDataSet set, IReadOnlyList<TestDataFieldRequest>? fields)
        => (fields ?? []).Select(field => new TestDataField
        {
            OrganizationId = set.OrganizationId,
            TestDataSetId = set.Id,
            Key = field.Key.Trim(),
            Kind = field.Kind,
            Value = field.Value,
            GeneratorJson = field.GeneratorJson,
            Seed = field.Seed,
            IsSensitive = field.IsSensitive || field.Kind == TestDataKind.SecretReference
        }).ToList();

    private static TestDataSetSummary Project(TestDataSet set, IEnumerable<TestDataField> fields) => new(
        set.Id, set.ProjectId, set.Name, set.Description, set.EnvironmentId,
        fields.OrderBy(f => f.Key).Select(f => new TestDataFieldSummary(
            f.Id, f.Key, f.Kind,
            // The value of a sensitive field is never returned, even to somebody who can
            // write the data set. A secret reference names a secret and is safe to show.
            f.Kind == TestDataKind.SecretReference ? f.Value
                : f.IsSensitive ? SecretMasker.Redacted
                : f.Value,
            f.GeneratorJson, f.Seed, f.IsSensitive)).ToList(),
        set.CreatedAt);
}
