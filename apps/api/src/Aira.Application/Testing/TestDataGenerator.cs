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

    /// <summary>
    /// Every generator type, by name.
    /// </summary>
    /// <remarks>
    /// Public so three things can share one list rather than three copies that drift: the
    /// API validates a submitted spec against it, the CLI prints it, and the reproducibility
    /// test enumerates it. That last one is the reason it is a set and not a comment — a
    /// type added later is automatically covered by the test that says every seeded type
    /// produces the same value twice, and cannot quietly opt out of the contract the way
    /// <c>uuid</c> did (BUG-0032).
    /// </remarks>
    public static readonly IReadOnlySet<string> SupportedTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "email", "firstName", "lastName", "fullName", "phone", "address", "postcode",
        "number", "amount", "date", "futureDate", "uuid", "reference", "boolean",
        "longText", "text"
    };

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
            // Counted from a fixed epoch when seeded and from today when not. Both halves
            // matter: a seeded field has to give the same date next month, and an unseeded
            // one is asking for "a date in the last year", which has to move with the year.
            "date" => Base(seed).AddDays(random.Next(-365, 0)).ToString("yyyy-MM-dd"),
            "futuredate" => Base(seed).AddDays(random.Next(1, 365)).ToString("yyyy-MM-dd"),
            "uuid" => Uuid(random, seed),
            "reference" => $"AIRA-{random.Next(100_000, 999_999)}",
            "boolean" => (random.Next(2) == 1).ToString().ToLowerInvariant(),
            // A deliberately long value, for boundary tests.
            "longtext" => new string('x', int.TryParse(spec.GetValueOrDefault("length", "256"), out var len)
                ? Math.Clamp(len, 1, 10_000) : 256),
            "text" or _ => $"AIRA {fieldKey} {random.Next(1000, 9999)}"
        };
    }

    /// <summary>
    /// The date a seeded field counts from.
    /// </summary>
    /// <remarks>
    /// A seeded field's whole purpose is that a failure can be reproduced, so it cannot be
    /// anchored to "today" — the value would be stable within a day and different the next,
    /// which is the exact failure this class's summary warns about (BUG-0032). The epoch is
    /// arbitrary and fixed; what matters is that it never moves.
    /// </remarks>
    private static readonly DateTime SeededEpoch = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private static DateTime Base(int? seed) => seed is null ? DateTime.UtcNow : SeededEpoch;

    /// <summary>
    /// A v4 UUID, drawn from the seeded generator when there is a seed.
    /// </summary>
    /// <remarks>
    /// <c>Guid.NewGuid()</c> cannot be seeded, so a seeded uuid field used to produce a
    /// different value on every call — and an identifier is exactly the sort of field a
    /// test asserts on. The bytes come from the seeded <see cref="Random"/> and the version
    /// and variant bits are set afterwards, so the result is still a well-formed v4.
    ///
    /// Without a seed it stays <c>Guid.NewGuid()</c>: nothing was promised, and a
    /// cryptographically random identifier is the better default.
    /// </remarks>
    private static string Uuid(Random random, int? seed)
    {
        if (seed is null) return Guid.NewGuid().ToString();

        var bytes = new byte[16];
        random.NextBytes(bytes);
        bytes[7] = (byte)((bytes[7] & 0x0F) | 0x40);   // version 4
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);   // variant 1
        return new Guid(bytes).ToString();
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
