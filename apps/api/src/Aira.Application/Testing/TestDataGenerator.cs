using System.Security.Cryptography;
using System.Text.Json;

namespace Aira.Application.Testing;

/// <summary>Produces test data from a declarative specification.
///
/// Generation is seedable, and a seeded field produces the same value on every run. That
/// matters more than it sounds: a test that fails only on Tuesdays because it generated a
/// different email address is indistinguishable from a real defect, and costs the same
/// investigation.</summary>
public static class TestDataGenerator
{
    private static readonly string[] FirstNames =
        { "Alex", "Priya", "Jordan", "Mei", "Samuel", "Nadia", "Tomas", "Aisha", "Ruben", "Chloe" };
    private static readonly string[] LastNames =
        { "Fernandes", "Okonkwo", "Novak", "Haddad", "Larsen", "Rossi", "Nakamura", "Dubois", "Silva", "Kowalski" };
    private static readonly string[] Streets =
        { "Alder Way", "Beech Road", "Cedar Close", "Dale Street", "Elm Avenue", "Fern Lane" };
    private static readonly string[] Cities =
        { "Ashford", "Brentwood", "Carlisle", "Dunstable", "Elmwood", "Fairview" };

    /// <summary>Generates a value for a field. The spec is JSON, e.g.
    /// <c>{"type":"email","domain":"example.test"}</c>; when absent, the field's own name
    /// decides, which is what makes generated tests usable without configuration.</summary>
    public static string Generate(string fieldKey, string? generatorJson, int? seed)
    {
        var random = seed is null ? Random.Shared : new Random(seed.Value);
        var spec = Parse(generatorJson);
        var type = spec.TryGetValue("type", out var t) ? t.ToLowerInvariant() : InferType(fieldKey);

        return type switch
        {
            "email" => $"aira.{Word(random, FirstNames).ToLowerInvariant()}.{random.Next(1000, 9999)}@{spec.GetValueOrDefault("domain", "example.test")}",
            "firstname" => Word(random, FirstNames),
            "lastname" => Word(random, LastNames),
            "fullname" => $"{Word(random, FirstNames)} {Word(random, LastNames)}",
            "phone" => $"+44 20 7946 {random.Next(0, 10000):0000}",
            "address" => $"{random.Next(1, 200)} {Word(random, Streets)}, {Word(random, Cities)}",
            "postcode" => $"{RandomLetters(random, 2)}{random.Next(1, 99)} {random.Next(1, 9)}{RandomLetters(random, 2)}",
            "number" => random.Next(
                int.TryParse(spec.GetValueOrDefault("min", "1"), out var min) ? min : 1,
                int.TryParse(spec.GetValueOrDefault("max", "1000"), out var max) ? max : 1000).ToString(),
            "amount" => (random.Next(100, 100_000) / 100m).ToString("F2"),
            "date" => DateTime.UtcNow.AddDays(random.Next(-365, 0)).ToString("yyyy-MM-dd"),
            "futuredate" => DateTime.UtcNow.AddDays(random.Next(1, 365)).ToString("yyyy-MM-dd"),
            "uuid" => Guid.NewGuid().ToString(),
            "reference" => $"AIRA-{random.Next(100_000, 999_999)}",
            "boolean" => (random.Next(2) == 1).ToString().ToLowerInvariant(),
            // A deliberately long value, for boundary tests.
            "longtext" => new string('x', int.TryParse(spec.GetValueOrDefault("length", "256"), out var len)
                ? Math.Clamp(len, 1, 10_000) : 256),
            "text" or _ => $"AIRA {fieldKey} {random.Next(1000, 9999)}"
        };
    }

    /// <summary>A cryptographically random value, for data that must not repeat between
    /// runs (a new account's username, for instance).</summary>
    public static string Unique(string prefix)
        => $"{prefix}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant()}";

    private static string InferType(string fieldKey)
    {
        var key = fieldKey.ToLowerInvariant();
        if (key.Contains("email")) return "email";
        if (key.Contains("phone") || key.Contains("mobile")) return "phone";
        if (key.Contains("firstname")) return "firstname";
        if (key.Contains("lastname") || key.Contains("surname")) return "lastname";
        if (key.Contains("name")) return "fullname";
        if (key.Contains("postcode") || key.Contains("zip")) return "postcode";
        if (key.Contains("address")) return "address";
        if (key.Contains("amount") || key.Contains("price") || key.Contains("total")) return "amount";
        if (key.Contains("date")) return "date";
        if (key.Contains("reference") || key.Contains("ref")) return "reference";
        if (key.Contains("quantity") || key.Contains("count") || key.Contains("number")) return "number";
        return "text";
    }

    private static Dictionary<string, string> Parse(string? generatorJson)
    {
        if (string.IsNullOrWhiteSpace(generatorJson)) return new Dictionary<string, string>();
        try
        {
            using var document = JsonDocument.Parse(generatorJson!);
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var property in document.RootElement.EnumerateObject())
            {
                result[property.Name] = property.Value.ValueKind == JsonValueKind.String
                    ? property.Value.GetString() ?? string.Empty
                    : property.Value.ToString();
            }
            return result;
        }
        catch (JsonException)
        {
            // A malformed spec falls back to name inference rather than failing the run.
            return new Dictionary<string, string>();
        }
    }

    private static string Word(Random random, string[] source) => source[random.Next(source.Length)];

    private static string RandomLetters(Random random, int count)
        => new(Enumerable.Range(0, count).Select(_ => (char)('A' + random.Next(26))).ToArray());
}
