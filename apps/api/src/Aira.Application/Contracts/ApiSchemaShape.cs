using System.Text.Json;
using System.Text.Json.Nodes;
using Aira.Domain.Enums;

namespace Aira.Application.Contracts;

/// <summary>The shape of a JSON document, as a flat map of path to type.
///
/// Deliberately not a JSON Schema. What a contract check needs to answer is "which fields
/// moved, and does that break a caller?", and a flat map answers it in one pass with a
/// message a person can read: <c>accounts[].balance: number → string</c>. A nested schema
/// would need a tree diff to say the same thing, and a tree diff reports a changed subtree
/// where what someone needs is the one field inside it.
///
/// The paths use the same grammar the response assertions use, so a breaking change and the
/// assertion that would catch it are written the same way.
///
/// Arrays collapse: every element of an array contributes to one <c>path[]</c> entry. That
/// is the only way a sample of three items can say anything about the fourth, and it is
/// also what makes the shape stable — a response with two accounts and a response with
/// nine have the same contract.</summary>
public sealed record ApiSchemaShape(IReadOnlyDictionary<string, string> Fields)
{
    /// <summary>The root type, so "the response became an array" is visible rather than
    /// implied by every path changing at once.</summary>
    public string RootType => Fields.TryGetValue("$", out var type) ? type : "unknown";

    public int FieldCount => Fields.Count;

    /// <summary>Infers the shape of a JSON document.
    ///
    /// Returns null when the text is not JSON at all: a contract cannot be inferred from an
    /// HTML error page, and guessing one would produce a baseline that fails for ever.</summary>
    public static ApiSchemaShape? Infer(string? json, int maxFields = 500)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json, documentOptions: new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip,
                MaxDepth = 32
            });
        }
        catch (JsonException)
        {
            return null;
        }

        var fields = new SortedDictionary<string, string>(StringComparer.Ordinal);
        Walk(node, "$", fields, maxFields, depth: 0);
        return new ApiSchemaShape(fields);
    }

    /// <summary>Reads a shape back from storage.</summary>
    public static ApiSchemaShape? FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            var fields = JsonSerializer.Deserialize<SortedDictionary<string, string>>(json);
            return fields is null ? null : new ApiSchemaShape(fields);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public string ToJson() => JsonSerializer.Serialize(
        new SortedDictionary<string, string>(Fields.ToDictionary(p => p.Key, p => p.Value), StringComparer.Ordinal),
        new JsonSerializerOptions { WriteIndented = false });

    private static void Walk(
        JsonNode? node, string path, SortedDictionary<string, string> fields, int maxFields, int depth)
    {
        if (fields.Count >= maxFields || depth > 32) return;

        switch (node)
        {
            case null:
                Record(fields, path, "null");
                return;

            case JsonObject obj:
                Record(fields, path, "object");
                foreach (var (name, child) in obj)
                {
                    // A name containing a dot or a bracket would produce a path that reads
                    // as structure. Quoting it keeps the path unambiguous.
                    var segment = name.Contains('.') || name.Contains('[') ? $"['{name}']" : name;
                    Walk(child, $"{path}.{segment}", fields, maxFields, depth + 1);
                }
                return;

            case JsonArray array:
                Record(fields, path, "array");
                // Every element folds into one `path[]` entry, so a two-item sample and a
                // nine-item sample produce the same contract.
                foreach (var child in array)
                {
                    Walk(child, $"{path}[]", fields, maxFields, depth + 1);
                }
                return;

            case JsonValue value:
                Record(fields, path, ScalarType(value));
                return;

            default:
                Record(fields, path, "unknown");
                return;
        }
    }

    /// <summary>Records a type at a path, merging with anything already seen there.
    ///
    /// Merging matters for arrays: if one element has a string id and another has a number,
    /// the honest answer is that the field is <c>number|string</c>, not whichever came
    /// last. A caller written against one of them is already at risk, and the contract
    /// should say so.</summary>
    private static void Record(SortedDictionary<string, string> fields, string path, string type)
    {
        if (!fields.TryGetValue(path, out var existing))
        {
            fields[path] = type;
            return;
        }
        if (existing == type) return;

        var parts = existing.Split('|').Append(type).Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal);
        fields[path] = string.Join('|', parts);
    }

    private static string ScalarType(JsonValue value)
    {
        if (value.TryGetValue<bool>(out _)) return "boolean";
        if (value.TryGetValue<string>(out _)) return "string";
        // Integers and fractions are both "number": an API that starts returning 1 instead
        // of 1.0 has not changed its contract, and reporting that it has would train
        // people to ignore contract changes.
        if (value.TryGetValue<decimal>(out _) || value.TryGetValue<double>(out _)) return "number";
        return "unknown";
    }
}

/// <summary>One difference between a baseline shape and an observed one.</summary>
public sealed record ApiContractDifference(
    ContractChangeKind Kind,
    string Path,
    string? BaselineType,
    string? ObservedType,
    string Description);

/// <summary>Compares an observed response against a stored baseline and says, for each
/// difference, whether it breaks a caller.
///
/// The classification is the whole point, and it is deliberately conservative in one
/// direction only: a change that *might* break a caller is reported as potentially
/// breaking rather than waved through. The reverse — reporting a safe change as breaking —
/// is what teaches a team to disable contract checking, so the safe cases are named
/// explicitly rather than lumped in.</summary>
public static class ApiContractComparer
{
    public static IReadOnlyList<ApiContractDifference> Compare(
        ApiSchemaShape baseline, ApiSchemaShape observed, int? baselineStatus = null, int? observedStatus = null)
    {
        var differences = new List<ApiContractDifference>();

        if (baselineStatus is not null && observedStatus is not null && baselineStatus != observedStatus)
        {
            var wasSuccess = baselineStatus is >= 200 and < 300;
            var isSuccess = observedStatus is >= 200 and < 300;

            differences.Add(new ApiContractDifference(
                wasSuccess && !isSuccess ? ContractChangeKind.Breaking
                    : !wasSuccess && isSuccess ? ContractChangeKind.NonBreaking
                    : ContractChangeKind.PotentiallyBreaking,
                "$status",
                baselineStatus.ToString(),
                observedStatus.ToString(),
                wasSuccess && !isSuccess
                    ? $"The endpoint answered {baselineStatus} and now answers {observedStatus}. "
                      + "A caller that relied on it succeeding no longer works."
                    : !wasSuccess && isSuccess
                        ? $"The endpoint answered {baselineStatus} and now answers {observedStatus}. "
                          + "It has started working."
                        : $"The status changed from {baselineStatus} to {observedStatus}. A caller "
                          + "that distinguishes these will see a different result."));
        }

        foreach (var (path, baselineType) in baseline.Fields)
        {
            if (!observed.Fields.TryGetValue(path, out var observedType))
            {
                // A field a caller could read is gone. There is no reading of this that is
                // safe for someone who was reading it.
                differences.Add(new ApiContractDifference(
                    ContractChangeKind.Breaking, path, baselineType, null,
                    $"{Describe(path)} was present as {baselineType} and is now absent. "
                    + "Any caller reading it will find nothing."));
                continue;
            }

            if (baselineType == observedType) continue;

            differences.Add(ClassifyTypeChange(path, baselineType, observedType));
        }

        foreach (var (path, observedType) in observed.Fields)
        {
            if (baseline.Fields.ContainsKey(path)) continue;

            // A new field is safe for every existing caller: nobody was reading it.
            differences.Add(new ApiContractDifference(
                ContractChangeKind.NonBreaking, path, null, observedType,
                $"{Describe(path)} is new, as {observedType}. Existing callers are unaffected."));
        }

        return differences;
    }

    private static ApiContractDifference ClassifyTypeChange(string path, string baselineType, string observedType)
    {
        var baselineParts = baselineType.Split('|').ToHashSet(StringComparer.Ordinal);
        var observedParts = observedType.Split('|').ToHashSet(StringComparer.Ordinal);

        var baselineWithoutNull = baselineParts.Where(p => p != "null").ToHashSet(StringComparer.Ordinal);
        var observedWithoutNull = observedParts.Where(p => p != "null").ToHashSet(StringComparer.Ordinal);

        var gainedNull = !baselineParts.Contains("null") && observedParts.Contains("null");
        var lostNull = baselineParts.Contains("null") && !observedParts.Contains("null");

        // The sample only ever held null, so the real type was never observed. Learning it
        // is not a change to the contract — it is the contract becoming known.
        if (baselineWithoutNull.Count == 0 && observedWithoutNull.Count > 0)
        {
            return new ApiContractDifference(
                ContractChangeKind.PotentiallyBreaking, path, baselineType, observedType,
                $"{Describe(path)} was only ever observed as null, and is now {observedType}. "
                + "The baseline never recorded its real type, so this may not be a change at all.");
        }

        if (gainedNull && observedWithoutNull.SetEquals(baselineWithoutNull))
        {
            // Same type, now sometimes absent in value. A caller that dereferences it
            // without checking will fail, but only on the rows where it is null.
            return new ApiContractDifference(
                ContractChangeKind.PotentiallyBreaking, path, baselineType, observedType,
                $"{Describe(path)} can now be null. A caller that reads it without a null "
                + "check will fail on the values where it is.");
        }

        if (lostNull && observedWithoutNull.SetEquals(baselineWithoutNull))
        {
            return new ApiContractDifference(
                ContractChangeKind.NonBreaking, path, baselineType, observedType,
                $"{Describe(path)} is no longer null in the observed response. "
                + "A caller that handled null still works.");
        }

        if (baselineWithoutNull.IsSubsetOf(observedWithoutNull))
        {
            // The old type is still possible, and another has joined it. Existing callers
            // see the old shape some of the time and something else the rest.
            return new ApiContractDifference(
                ContractChangeKind.PotentiallyBreaking, path, baselineType, observedType,
                $"{Describe(path)} was {baselineType} and can now also be "
                + $"{string.Join(" or ", observedWithoutNull.Except(baselineWithoutNull))}. "
                + "A caller that assumes one type will fail on the other.");
        }

        var structural = baselineWithoutNull.Any(IsStructural) || observedWithoutNull.Any(IsStructural);

        return new ApiContractDifference(
            ContractChangeKind.Breaking, path, baselineType, observedType,
            structural
                ? $"{Describe(path)} changed from {baselineType} to {observedType}. "
                  + "The shape of the response at this point is different, so a caller "
                  + "reading through it will not find what it expects."
                : $"{Describe(path)} changed from {baselineType} to {observedType}. "
                  + "A caller that parses it as the old type will fail.");
    }

    private static bool IsStructural(string type) => type is "object" or "array";

    /// <summary>Renders a path the way a message should read it.</summary>
    private static string Describe(string path) => path switch
    {
        "$" => "The response body",
        "$status" => "The response status",
        _ => $"\"{(path.StartsWith("$.", StringComparison.Ordinal) ? path[2..] : path)}\""
    };
}
