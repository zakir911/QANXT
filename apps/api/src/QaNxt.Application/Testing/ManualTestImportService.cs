using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.EntityFrameworkCore;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;

namespace QaNxt.Application.Testing;

public sealed record ImportManualTestsRequest(Guid ApplicationId, string FileName, byte[] Content, string? SuiteName = null);

public sealed record ImportedTestOutcome(int Row, string Title, string Reference, bool Automatable, string Reason, Guid TestCaseId, Guid? HumanTaskId);

public sealed record ImportManualTestsResult(
    string Format, int Rows, int Imported, int Automatable, int HumanVerification, int Skipped,
    Guid TestSuiteId, IReadOnlyList<ImportedTestOutcome> Tests, IReadOnlyList<string> Problems);

public interface IManualTestImportService
{
    Task<Result<ImportManualTestsResult>> ImportAsync(ImportManualTestsRequest request, CancellationToken ct = default);
}

/// <summary>Brings an organisation's existing manual test cases into the repository.
///
/// Each imported case is read for steps a machine can perform. The grammar is small and
/// literal — "Open /login", "Enter "ada" in Username", "Click Sign in", "Verify "Welcome" is
/// shown" — because a step that is guessed at is a test that tests the guess. A case whose
/// every step is understood, and which checks something, becomes an automated test, filed as
/// a draft for a person to review and activate. Anything else becomes a human verification
/// task with its steps and expected result intact, and the import says which line could not
/// be understood. Nothing an organisation wrote is lost or rewritten.</summary>
public sealed class ManualTestImportService : IManualTestImportService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;

    public ManualTestImportService(IQaNxtDbContext db, ICurrentUser currentUser, IClock clock, IAuditLogger audit)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
    }

    private sealed record ManualCase(int Row, string? Id, string Title, string Preconditions, string Steps, string Expected,
        string? Priority, string? Category, string? Tags);

    public async Task<Result<ImportManualTestsResult>> ImportAsync(ImportManualTestsRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");
        if (request.Content.Length == 0) return Error.Validation("The file is empty.");
        if (request.Content.Length > 10 * 1024 * 1024) return Error.Validation("The file is larger than 10 MB.");

        var problems = new List<string>();
        List<ManualCase> cases;
        string format;
        try
        {
            (format, cases) = Parse(request.FileName, request.Content, problems);
        }
        catch (Exception ex) when (ex is InvalidDataException or JsonException or System.Xml.XmlException or FormatException)
        {
            return Error.Validation($"The file could not be read: {ex.Message}");
        }
        if (cases.Count == 0)
            return Error.Validation(problems.Count > 0 ? string.Join(" ", problems) : "No test cases were found. The file needs a title column (Title, Name or Test Case) and a steps column.");

        var suiteName = request.SuiteName?.Trim() is { Length: > 0 } named ? named : $"{application.Name} — imported manual tests";
        var suite = await _db.TestSuites.FirstOrDefaultAsync(s => s.ProjectId == application.ProjectId && s.Name == suiteName, ct);
        if (suite is null)
        {
            suite = new TestSuite
            {
                ProjectId = application.ProjectId, Name = suiteName, CreatedByUserId = _currentUser.UserId, CreatedAt = _clock.UtcNow,
                Description = $"Imported from {request.FileName}."
            };
            _db.TestSuites.Add(suite);
            await _db.SaveChangesAsync(ct);
        }

        var outcomes = new List<ImportedTestOutcome>();
        var policy = new BrowserActionPolicy(false, true, (string url, out string reason) => { reason = string.Empty; return true; });
        var nextNumber = int.Parse((await TestRepositoryService.NextReferenceAsync(_db, application.ProjectId, ct))[3..]);
        var skipped = 0;

        foreach (var manual in cases)
        {
            if (string.IsNullOrWhiteSpace(manual.Title)) { skipped++; problems.Add($"Row {manual.Row}: no title, skipped."); continue; }

            var lines = SplitSteps(manual.Steps);
            var parsed = lines.Select(line => (Line: line, Steps: StepGrammar.Parse(line, application.BaseUrl))).ToList();
            var expectations = SplitSteps(manual.Expected).Select(e => StepGrammar.ParseExpectation(e)).ToList();
            var unparsed = parsed.Where(p => p.Steps is null).Select(p => p.Line).ToList();
            var steps = parsed.Where(p => p.Steps is not null).SelectMany(p => p.Steps!).ToList();
            var assertions = expectations.Where(e => e is not null).Select(e => e!).ToList();
            steps.AddRange(assertions);

            var invalid = steps.Select(s => BrowserActionValidator.Validate(s, policy)).FirstOrDefault(v => !v.IsValid);
            var hasCheck = steps.Any(s => BrowserActionVerbs.IsAssertion(s.Action));
            var automatable = lines.Count > 0 && unparsed.Count == 0 && invalid is null && hasCheck && expectations.All(e => e is not null);
            var reason = automatable ? "Every step and expectation maps to an action the engine runs."
                : lines.Count == 0 ? "The case has no steps."
                : unparsed.Count > 0 ? $"Not understood: \"{Truncate(unparsed[0], 120)}\"{(unparsed.Count > 1 ? $" and {unparsed.Count - 1} more line(s)" : string.Empty)}."
                : invalid is not null ? $"A step is not executable: {string.Join("; ", invalid.Errors)}"
                : !hasCheck ? "Nothing in it is checkable by a machine; the expected result needs a person."
                : "The expected result could not be turned into a check.";

            var testCase = new TestCase
            {
                ProjectId = application.ProjectId, TestSuiteId = suite.Id, ApplicationId = application.Id,
                Reference = $"TC-{nextNumber++:0000}", Name = Truncate(manual.Title.Trim(), 300),
                Objective = Truncate(manual.Id is null ? "Imported manual test." : $"Imported manual test {manual.Id}.", 2000),
                Preconditions = Truncate(manual.Preconditions, 2000), ExpectedResults = Truncate(manual.Expected, 4000),
                Priority = ParsePriority(manual.Priority), Risk = RiskLevel.Medium,
                Tags = Truncate(string.Join(',', new[] { "imported", manual.Id is null ? null : $"source:{manual.Id}" }
                    .Concat((manual.Tags ?? string.Empty).Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    .Where(t => !string.IsNullOrEmpty(t)).Distinct()), 500),
                Source = TestCaseSource.Imported, Category = ParseCategory(manual.Category),
                Technique = "imported", RequirementReference = manual.Id,
                AutomationStatus = automatable ? AutomationStatus.Automated : AutomationStatus.HumanVerification,
                CreatedByUserId = _currentUser.UserId, CreatedAt = _clock.UtcNow
            };
            // Imported tests start as drafts: they become part of "run all" when a person
            // has read them and activated them, not because a file was uploaded.
            testCase.SetLifecycle(TestCaseLifecycle.Draft);
            _db.TestCases.Add(testCase);

            if (automatable)
            {
                var order = 1;
                foreach (var step in steps)
                {
                    var testStep = new TestStep
                    {
                        TestCaseId = testCase.Id, Order = order++, Description = Truncate(step.Description, 1000), Action = step.Action,
                        TargetJson = step.Target?.ToJson(), Value = step.Value, Url = step.Url, CreatedAt = _clock.UtcNow
                    };
                    _db.TestSteps.Add(testStep);
                    if (BrowserActionVerbs.IsAssertion(step.Action))
                    {
                        _db.Assertions.Add(new Assertion
                        {
                            TestStepId = testStep.Id, Type = step.Action switch
                            {
                                BrowserActionType.AssertText => AssertionType.TextContains,
                                BrowserActionType.AssertUrl => AssertionType.UrlContains,
                                BrowserActionType.AssertVisible => AssertionType.Visible,
                                _ => AssertionType.StepVerdict
                            },
                            TargetJson = step.Target?.ToJson(), ExpectedValue = step.Expected, Description = Truncate(step.Description, 1000), CreatedAt = _clock.UtcNow
                        });
                    }
                }
            }

            HumanVerificationTask? task = null;
            if (!automatable)
            {
                task = new HumanVerificationTask
                {
                    ProjectId = application.ProjectId, ApplicationId = application.Id, TestCaseId = testCase.Id,
                    Title = Truncate(manual.Title.Trim(), 300), Category = testCase.Category ?? TestCategory.Functional,
                    Reason = Truncate(reason, 2000), Steps = Truncate(manual.Steps, 4000), ExpectedResult = Truncate(manual.Expected, 2000),
                    Origin = "imported", CreatedAt = _clock.UtcNow
                };
                _db.HumanVerificationTasks.Add(task);
            }

            outcomes.Add(new ImportedTestOutcome(manual.Row, testCase.Name, testCase.Reference, automatable, reason, testCase.Id, task?.Id));
        }

        await _db.SaveChangesAsync(ct);
        await _audit.LogAsync(AuditAction.TestCaseCreated, nameof(TestSuite), suite.Id,
            $"Imported {outcomes.Count} manual test(s) from {request.FileName}: {outcomes.Count(o => o.Automatable)} automatable, {outcomes.Count(o => !o.Automatable)} for human verification.",
            projectId: application.ProjectId, ct: ct);

        return Result<ImportManualTestsResult>.Success(new ImportManualTestsResult(format, cases.Count, outcomes.Count, outcomes.Count(o => o.Automatable),
            outcomes.Count(o => !o.Automatable), skipped, suite.Id, outcomes, problems));
    }

    // ---- Reading the file ----------------------------------------------------------

    private static (string Format, List<ManualCase> Cases) Parse(string fileName, byte[] content, List<string> problems)
    {
        var extension = Path.GetExtension(fileName).ToLowerInvariant();
        switch (extension)
        {
            case ".xlsx":
                return ("xlsx", FromRows(XlsxReader.Read(content), problems));
            case ".json":
                return ("json", FromJson(Encoding.UTF8.GetString(content), problems));
            case ".csv":
                return ("csv", FromRows(CsvReader.Read(Encoding.UTF8.GetString(content)), problems));
            case ".tsv":
                return ("tsv", FromRows(CsvReader.Read(Encoding.UTF8.GetString(content), '\t'), problems));
            case ".xls":
                throw new FormatException("The old binary Excel format (.xls) is not supported. Save the sheet as .xlsx or .csv.");
            default:
                return ("text", FromText(Encoding.UTF8.GetString(content), problems));
        }
    }

    private static readonly Dictionary<string, string> Columns = new(StringComparer.OrdinalIgnoreCase)
    {
        ["id"] = "id", ["test id"] = "id", ["test case id"] = "id", ["reference"] = "id", ["key"] = "id",
        ["title"] = "title", ["name"] = "title", ["test case"] = "title", ["test case name"] = "title", ["summary"] = "title", ["scenario"] = "title",
        ["preconditions"] = "pre", ["precondition"] = "pre", ["pre-conditions"] = "pre",
        ["steps"] = "steps", ["test steps"] = "steps", ["step"] = "steps", ["actions"] = "steps", ["procedure"] = "steps",
        ["expected"] = "expected", ["expected result"] = "expected", ["expected results"] = "expected", ["expected outcome"] = "expected",
        ["priority"] = "priority", ["category"] = "category", ["type"] = "category", ["test type"] = "category", ["tags"] = "tags", ["labels"] = "tags"
    };

    private static List<ManualCase> FromRows(List<string[]> rows, List<string> problems)
    {
        if (rows.Count < 2) return new List<ManualCase>();
        var header = rows[0].Select(h => Columns.TryGetValue(h.Trim(), out var key) ? key : null).ToArray();
        if (!header.Contains("title")) { problems.Add($"No title column. Found: {string.Join(", ", rows[0])}."); return new List<ManualCase>(); }
        string? Cell(string[] row, string key)
        {
            var index = Array.IndexOf(header, key);
            return index >= 0 && index < row.Length ? row[index] : null;
        }
        return rows.Skip(1).Select((row, i) => (row, i))
            .Where(r => r.row.Any(c => !string.IsNullOrWhiteSpace(c)))
            .Select(r => new ManualCase(r.i + 2, Blank(Cell(r.row, "id")), Cell(r.row, "title") ?? string.Empty, Cell(r.row, "pre") ?? string.Empty,
                Cell(r.row, "steps") ?? string.Empty, Cell(r.row, "expected") ?? string.Empty, Blank(Cell(r.row, "priority")),
                Blank(Cell(r.row, "category")), Blank(Cell(r.row, "tags"))))
            .ToList();
    }

    private static List<ManualCase> FromJson(string json, List<string> problems)
    {
        using var document = JsonDocument.Parse(json);
        var array = document.RootElement.ValueKind == JsonValueKind.Array ? document.RootElement
            : document.RootElement.TryGetProperty("tests", out var tests) ? tests
            : document.RootElement.TryGetProperty("testCases", out var testCases) ? testCases : default;
        if (array.ValueKind != JsonValueKind.Array) { problems.Add("Expected an array of test cases, or an object with a \"tests\" array."); return new List<ManualCase>(); }
        var result = new List<ManualCase>();
        var row = 0;
        foreach (var item in array.EnumerateArray())
        {
            row++;
            var values = new Dictionary<string, string>();
            foreach (var property in item.EnumerateObject())
            {
                if (!Columns.TryGetValue(property.Name, out var key)
                    && !Columns.TryGetValue(Regex.Replace(property.Name, "(?<=[a-z])(?=[A-Z])", " "), out key)) continue;
                values[key] = property.Value.ValueKind switch
                {
                    JsonValueKind.Array => string.Join("\n", property.Value.EnumerateArray().Select(v => v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString())),
                    JsonValueKind.String => property.Value.GetString() ?? string.Empty,
                    _ => property.Value.ToString()
                };
            }
            result.Add(new ManualCase(row, Blank(values.GetValueOrDefault("id")), values.GetValueOrDefault("title") ?? string.Empty,
                values.GetValueOrDefault("pre") ?? string.Empty, values.GetValueOrDefault("steps") ?? string.Empty,
                values.GetValueOrDefault("expected") ?? string.Empty, Blank(values.GetValueOrDefault("priority")),
                Blank(values.GetValueOrDefault("category")), Blank(values.GetValueOrDefault("tags"))));
        }
        return result;
    }

    /// <summary>Structured text: cases separated by blank lines or "---", each a block of
    /// "Field: value" lines, with steps and expected results allowed to run over lines.</summary>
    private static List<ManualCase> FromText(string text, List<string> problems)
    {
        var blocks = Regex.Split(text.Replace("\r\n", "\n"), @"\n\s*(?:---+\s*)?\n(?=\s*(?:id|title|name|test case)\s*:)", RegexOptions.IgnoreCase)
            .Where(b => !string.IsNullOrWhiteSpace(b)).ToList();
        var result = new List<ManualCase>();
        var row = 0;
        foreach (var block in blocks)
        {
            row++;
            var values = new Dictionary<string, StringBuilder>();
            string? current = null;
            foreach (var raw in block.Split('\n'))
            {
                var match = Regex.Match(raw, @"^\s*([A-Za-z][A-Za-z \-]{1,30}):\s*(.*)$");
                if (match.Success && Columns.TryGetValue(match.Groups[1].Value.Trim(), out var key))
                {
                    current = key;
                    values[key] = new StringBuilder(match.Groups[2].Value.Trim());
                }
                else if (current is not null && raw.Trim().Length > 0 && raw.Trim() != "---")
                {
                    values[current].Append('\n').Append(raw.Trim());
                }
            }
            string? Get(string key) => values.TryGetValue(key, out var sb) ? sb.ToString().Trim() : null;
            if (Get("title") is null) { problems.Add($"Block {row}: no Title line, skipped."); continue; }
            result.Add(new ManualCase(row, Blank(Get("id")), Get("title")!, Get("pre") ?? string.Empty, Get("steps") ?? string.Empty,
                Get("expected") ?? string.Empty, Blank(Get("priority")), Blank(Get("category")), Blank(Get("tags"))));
        }
        return result;
    }

    private static List<string> SplitSteps(string text)
        => Regex.Split(text.Replace("\r\n", "\n"), @"\n|(?<=\S)\s*;\s*(?=\S)")
            .Select(l => Regex.Replace(l.Trim(), @"^(?:step\s*)?\d+[\.\):]\s*|^[-*•]\s*", string.Empty, RegexOptions.IgnoreCase).Trim())
            .Where(l => l.Length > 0).ToList();

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static TestPriority ParsePriority(string? value) => (value ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        "critical" or "p0" or "blocker" or "highest" => TestPriority.Critical,
        "high" or "p1" or "major" => TestPriority.High,
        "low" or "p3" or "p4" or "minor" or "trivial" or "lowest" => TestPriority.Low,
        _ => TestPriority.Medium
    };

    private static TestCategory? ParseCategory(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return TestCategory.Functional;
        var cleaned = Regex.Replace(value, @"[\s\-_]|testing|test", string.Empty, RegexOptions.IgnoreCase);
        return Enum.TryParse<TestCategory>(cleaned, ignoreCase: true, out var category) ? category
            : cleaned.Equals("a11y", StringComparison.OrdinalIgnoreCase) ? TestCategory.Accessibility
            : cleaned.Equals("e2e", StringComparison.OrdinalIgnoreCase) || cleaned.Equals("endtoend", StringComparison.OrdinalIgnoreCase) ? TestCategory.Workflow
            : TestCategory.Functional;
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}

/// <summary>The literal step grammar manual tests are read with.</summary>
public static class StepGrammar
{
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private static readonly string Quoted = @"[""“”'‘’](?<v>[^""“”'‘’]*)[""“”'‘’]";

    private static LocatorDescriptor Label(string text) => new() { Strategy = LocatorStrategy.Label, Value = Clean(text) };
    private static LocatorDescriptor Button(string text) => new()
    {
        Strategy = LocatorStrategy.Role, Value = "button", Name = Clean(text),
        Fallbacks = new[] { new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = "link", Name = Clean(text) }, new LocatorDescriptor { Strategy = LocatorStrategy.Text, Value = Clean(text) } }
    };
    private static readonly LocatorDescriptor Page = new() { Strategy = LocatorStrategy.Css, Value = "body" };

    private static string Clean(string text) => Regex.Replace(text.Trim().Trim('.', '"', '\'', '“', '”'),
        @"^(the\s+)|(\s+(field|box|input|textbox|dropdown|button|link|checkbox))$", string.Empty, Options).Trim();

    /// <summary>The actions one line asks for, or null when the line is not understood.</summary>
    public static List<BrowserAction>? Parse(string line, string baseUrl)
    {
        Match m;
        if ((m = Regex.Match(line, @"^(?:go to|navigate to|open|visit|browse to|launch)\s+(?:the\s+)?(?<url>(?:https?://|/)\S*)\s*(?:page)?\.?$", Options)).Success)
            return One(BrowserActionType.Navigate, line, url: m.Groups["url"].Value.StartsWith('/') ? new Uri(new Uri(baseUrl), m.Groups["url"].Value).ToString() : m.Groups["url"].Value);
        if ((m = Regex.Match(line, $@"^(?:enter|type|input|fill in|key in)\s+{Quoted}\s+(?:in|into|in the|into the|for)\s+(?<f>.+?)\.?$", Options)).Success)
            return One(BrowserActionType.Fill, line, Label(m.Groups["f"].Value), m.Groups["v"].Value);
        if ((m = Regex.Match(line, $@"^(?:fill|fill in|set|populate)\s+(?:the\s+)?(?<f>.+?)\s+(?:with|to|as)\s+{Quoted}\.?$", Options)).Success)
            return One(BrowserActionType.Fill, line, Label(m.Groups["f"].Value), m.Groups["v"].Value);
        if ((m = Regex.Match(line, $@"^(?:select|choose|pick)\s+{Quoted}\s+(?:in|from|for)\s+(?<f>.+?)\.?$", Options)).Success)
            return One(BrowserActionType.Select, line, Label(m.Groups["f"].Value), m.Groups["v"].Value);
        if ((m = Regex.Match(line, @"^(?:check|tick|enable|select)\s+(?:the\s+)?(?<f>.+?)\s+checkbox\.?$", Options)).Success)
            return One(BrowserActionType.Check, line, Label(m.Groups["f"].Value));
        if ((m = Regex.Match(line, @"^(?:uncheck|untick|clear)\s+(?:the\s+)?(?<f>.+?)\s+checkbox\.?$", Options)).Success)
            return One(BrowserActionType.Uncheck, line, Label(m.Groups["f"].Value));
        if ((m = Regex.Match(line, $@"^(?:click|press|tap|hit|submit using)\s+(?:on\s+)?(?:the\s+)?(?:{Quoted}|(?<b>.+?))(?:\s+(?:button|link))?\.?$", Options)).Success)
            return One(BrowserActionType.Click, line, Button(m.Groups["v"].Success ? m.Groups["v"].Value : m.Groups["b"].Value));
        var expectation = ParseExpectation(line);
        return expectation is null ? null : new List<BrowserAction> { expectation };
    }

    /// <summary>A check, from a step or an expected-result line, or null.</summary>
    public static BrowserAction? ParseExpectation(string line)
    {
        Match m;
        if ((m = Regex.Match(line, $@"(?:url|address)\s+(?:should\s+)?(?:contains?|includes?|is)\s+{Quoted}", Options)).Success)
            return new BrowserAction { Action = BrowserActionType.AssertUrl, Description = line, Expected = m.Groups["v"].Value };
        if ((m = Regex.Match(line, $@"^(?:verify|check|confirm|assert|ensure|expect)?\s*(?:that\s+)?(?:the\s+)?(?:page|screen)?\s*(?:shows|displays|contains|should show|should display|is displayed|appears)?\s*(?:the\s+)?(?:text|message)?\s*{Quoted}\s*(?:is\s+(?:shown|displayed|visible)|appears|should (?:be shown|appear))?\.?$", Options)).Success
            && m.Groups["v"].Value.Length > 0)
            return new BrowserAction { Action = BrowserActionType.AssertText, Description = line, Target = Page, Expected = m.Groups["v"].Value };
        if ((m = Regex.Match(line, $@"^(?:verify|check|confirm|ensure|expect)\s+(?:that\s+)?(?:the\s+)?(?:message|text|heading)\s+{Quoted}", Options)).Success)
            return new BrowserAction { Action = BrowserActionType.AssertText, Description = line, Target = Page, Expected = m.Groups["v"].Value };
        return null;
    }

    private static List<BrowserAction> One(BrowserActionType action, string description, LocatorDescriptor? target = null, string? value = null, string? url = null)
        => new() { new BrowserAction { Action = action, Description = description, Target = target, Value = value, Url = url } };
}

/// <summary>RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes.</summary>
public static class CsvReader
{
    public static List<string[]> Read(string text, char separator = ',')
    {
        var rows = new List<string[]>();
        var row = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        text = text.TrimStart('﻿');
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else field.Append(c);
                continue;
            }
            if (c == '"' && field.Length == 0) quoted = true;
            else if (c == separator) { row.Add(field.ToString()); field.Clear(); }
            else if (c == '\n' || c == '\r')
            {
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                row.Add(field.ToString()); field.Clear();
                rows.Add(row.ToArray()); row.Clear();
            }
            else field.Append(c);
        }
        if (field.Length > 0 || row.Count > 0) { row.Add(field.ToString()); rows.Add(row.ToArray()); }
        return rows;
    }
}

/// <summary>Reads the first worksheet of an .xlsx file: shared strings, inline strings and
/// numbers. Formulas are read as their cached value. Enough for a sheet of test cases; not
/// a spreadsheet engine.</summary>
public static class XlsxReader
{
    private static readonly XNamespace Main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private static readonly XNamespace Rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private static readonly XNamespace PackageRel = "http://schemas.openxmlformats.org/package/2006/relationships";

    public static List<string[]> Read(byte[] content)
    {
        using var zip = new ZipArchive(new MemoryStream(content), ZipArchiveMode.Read);
        XDocument Load(string path) => XDocument.Load(zip.GetEntry(path)?.Open() ?? throw new InvalidDataException($"The workbook has no {path}."));

        var shared = zip.GetEntry("xl/sharedStrings.xml") is null ? new List<string>()
            : Load("xl/sharedStrings.xml").Root!.Elements(Main + "si").Select(si => string.Concat(si.Descendants(Main + "t").Select(t => t.Value))).ToList();

        var workbook = Load("xl/workbook.xml");
        var firstSheet = workbook.Root!.Element(Main + "sheets")?.Elements(Main + "sheet").FirstOrDefault()
            ?? throw new InvalidDataException("The workbook has no sheets.");
        var relationId = firstSheet.Attribute(Rel + "id")?.Value;
        var target = Load("xl/_rels/workbook.xml.rels").Root!.Elements(PackageRel + "Relationship")
            .FirstOrDefault(r => r.Attribute("Id")?.Value == relationId)?.Attribute("Target")?.Value ?? "worksheets/sheet1.xml";
        var sheetPath = target.StartsWith('/') ? target.TrimStart('/') : $"xl/{target}";

        var rows = new List<string[]>();
        foreach (var row in Load(sheetPath).Descendants(Main + "row"))
        {
            var cells = new SortedDictionary<int, string>();
            var position = 0;
            foreach (var cell in row.Elements(Main + "c"))
            {
                var reference = cell.Attribute("r")?.Value;
                position = reference is null ? position : ColumnIndex(reference);
                var type = cell.Attribute("t")?.Value;
                var raw = cell.Element(Main + "v")?.Value;
                cells[position] = type switch
                {
                    "s" when int.TryParse(raw, out var index) && index < shared.Count => shared[index],
                    "inlineStr" => string.Concat(cell.Descendants(Main + "t").Select(t => t.Value)),
                    _ => raw ?? string.Empty
                };
                position++;
            }
            if (cells.Count == 0) continue;
            var array = new string[cells.Keys.Max() + 1];
            for (var i = 0; i < array.Length; i++) array[i] = cells.TryGetValue(i, out var value) ? value : string.Empty;
            rows.Add(array);
        }
        return rows;
    }

    private static int ColumnIndex(string reference)
    {
        var index = 0;
        foreach (var c in reference.TakeWhile(char.IsLetter)) index = index * 26 + (char.ToUpperInvariant(c) - 'A' + 1);
        return index - 1;
    }
}
