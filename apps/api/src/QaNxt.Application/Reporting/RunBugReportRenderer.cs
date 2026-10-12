using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace QaNxt.Application.Reporting;

/// <summary>Turns a <see cref="RunBugReport"/> into files a developer can open anywhere:
/// one self-contained HTML page (screenshots embedded, prints cleanly to PDF), and a zip
/// with that page, a Markdown copy for pasting into a tracker, the JSON, and every evidence
/// file — trace, video, DOM and accessibility snapshots.</summary>
public static class RunBugReportRenderer
{
    public delegate Task<byte[]?> ArtifactReader(ReportArtifact artifact, CancellationToken ct);

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>Above these, an image is left in the evidence pack rather than embedded, so a
    /// report of a very large run still opens in a mail client.</summary>
    private const long MaxEmbeddedImageBytes = 4 * 1024 * 1024;
    private const long MaxEmbeddedTotalBytes = 50L * 1024 * 1024;
    /// <summary>Videos are the largest evidence and the least needed beside a trace; past this
    /// total they are left out of the zip, and the report says so.</summary>
    private const long MaxZipEvidenceBytes = 250L * 1024 * 1024;

    // ---- HTML ---------------------------------------------------------------------------

    /// <summary>One page, nothing external: screenshots are embedded as data URIs.</summary>
    public static async Task<string> HtmlAsync(RunBugReport report, ArtifactReader read, CancellationToken ct = default)
    {
        var images = new Dictionary<Guid, string>();
        long total = 0;
        foreach (var shot in report.Bugs.SelectMany(b => b.Screenshots).DistinctBy(s => s.Id))
        {
            if (shot.SizeBytes > MaxEmbeddedImageBytes || total + shot.SizeBytes > MaxEmbeddedTotalBytes) continue;
            var bytes = await read(shot, ct);
            if (bytes is null) continue;
            total += bytes.Length;
            images[shot.Id] = $"data:{shot.ContentType};base64,{Convert.ToBase64String(bytes)}";
        }
        return Html(report, shot => images.GetValueOrDefault(shot.Id), attachment => null);
    }

    /// <summary>The page, with images and attachments resolved by the caller: embedded data
    /// for the single file, relative paths inside the zip.</summary>
    public static string Html(RunBugReport report, Func<ReportArtifact, string?> imageSource, Func<ReportArtifact, string?> attachmentHref)
    {
        var run = report.Run;
        var html = new StringBuilder();
        html.Append("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">")
            .Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
            .Append($"<title>Bug report — {E(run.Name)}</title><style>{Css}</style></head><body><main>");

        html.Append("<header class=\"top\"><p class=\"eyebrow\">QA NXT bug report</p>")
            .Append($"<h1>{E(run.Name)}</h1>")
            .Append($"<p class=\"lede\">{E(Headline(report))}</p></header>");

        // The run, at a glance.
        html.Append("<section class=\"run\"><h2>Test run</h2><dl class=\"grid\">");
        Row(html, "Project", run.Project);
        foreach (var app in run.Applications) Row(html, "Application", $"{app.Name} — {app.BaseUrl}");
        Row(html, "Environment", run.Environment is null ? null : $"{run.Environment}{(run.EnvironmentUrl is null ? string.Empty : " — " + run.EnvironmentUrl)}");
        Row(html, "Browser", $"{run.Browser}{(run.BrowserVersion is null ? string.Empty : " " + run.BrowserVersion)}");
        Row(html, "Started", Time(run.StartedAt));
        Row(html, "Finished", Time(run.CompletedAt));
        Row(html, "Duration", Duration(run.DurationMs));
        Row(html, "Trigger", run.Trigger);
        Row(html, "Commit", run.CommitSha is null ? null : $"{run.CommitSha}{(run.Branch is null ? string.Empty : " on " + run.Branch)}");
        Row(html, "CI build", run.BuildId);
        Row(html, "Application build", run.ApplicationBuild);
        Row(html, "Run ID", run.Id.ToString());
        html.Append("</dl>");
        html.Append("<div class=\"tiles\">")
            .Append(Tile("Tests", run.Total, null)).Append(Tile("Passed", run.Passed, "good"))
            .Append(Tile("Failed", run.Failed, run.Failed > 0 ? "bad" : null)).Append(Tile("Skipped", run.Skipped, null))
            .Append(Tile("Bugs", report.Bugs.Count, report.Bugs.Count > 0 ? "bad" : "good")).Append("</div>");
        if (run.ConsoleUrl is not null) html.Append($"<p class=\"muted\">Open this run in QA NXT: <a href=\"{A(run.ConsoleUrl)}\">{E(run.ConsoleUrl)}</a></p>");
        html.Append("</section>");

        if (report.Bugs.Count > 0)
        {
            html.Append("<section><h2>Bugs found</h2><table class=\"index\"><thead><tr><th>Bug</th><th>Severity</th><th>Title</th><th>Where</th><th>Tests</th></tr></thead><tbody>");
            foreach (var bug in report.Bugs)
                html.Append($"<tr><td><a href=\"#{bug.Key}\">{bug.Key}</a>{(bug.DefectReference is null ? string.Empty : $"<br><span class=\"muted\">{bug.DefectReference}</span>")}</td>")
                    .Append($"<td>{Badge(bug.Severity)}</td><td>{E(bug.Title)}</td><td>{E(bug.Form ?? bug.PageUrl ?? string.Empty)}{(bug.Field is null ? string.Empty : $" · <code>{E(bug.Field)}</code>")}</td>")
                    .Append($"<td>{bug.AffectedTests.Count}</td></tr>");
            html.Append("</tbody></table></section>");
        }
        else
        {
            html.Append("<section><h2>Bugs found</h2><p>None. No test in this run failed because of the application.</p></section>");
        }

        foreach (var bug in report.Bugs) Bug(html, bug, imageSource, attachmentHref);

        if (report.NotProductBugs.Count > 0)
        {
            html.Append("<section class=\"aside\"><h2>Failures that are not product bugs</h2>")
                .Append("<p>These tests failed for reasons other than the application's behaviour. They are listed so the totals add up; none needs a code change in the application.</p>")
                .Append("<table><thead><tr><th>Test</th><th>Why it failed</th><th>Who acts</th></tr></thead><tbody>");
            foreach (var other in report.NotProductBugs)
                html.Append($"<tr><td><strong>{E(other.Reference)}</strong><br>{E(other.Name)}</td><td><em>{E(other.Classification)}</em><br>{E(other.Message)}</td><td>{E(other.WhoActs)}</td></tr>");
            html.Append("</tbody></table></section>");
        }
        if (report.PassedOnRetry.Count > 0)
        {
            html.Append("<section class=\"aside\"><h2>Passed only on retry</h2><p>These failed at least once and then passed. They are not counted as bugs, but an intermittent failure is often a race worth a look.</p><ul>");
            foreach (var flaky in report.PassedOnRetry)
                html.Append($"<li><strong>{E(flaky.Reference)}</strong> {E(flaky.Name)} — {flaky.Attempts} attempts; first failure: {E(flaky.FirstFailure)}</li>");
            html.Append("</ul></section>");
        }
        if (report.Skipped.Count > 0)
        {
            html.Append("<section class=\"aside\"><h2>Not run</h2><p>Skipped tests were not run, so they neither pass nor fail.</p><ul>");
            foreach (var group in report.Skipped)
                html.Append($"<li>{group.Count} × {E(group.Reason)} <span class=\"muted\">({E(string.Join(", ", group.Tests.Take(12)))}{(group.Tests.Count > 12 ? ", …" : string.Empty)})</span></li>");
            html.Append("</ul></section>");
        }

        html.Append($"<footer>Generated by QA NXT on {E(Time(report.GeneratedAt))}. Secrets, tokens, card numbers and passwords are masked in every request, response and log shown here.</footer>");
        html.Append("</main></body></html>");
        return html.ToString();
    }

    private static void Bug(StringBuilder html, ReportBug bug, Func<ReportArtifact, string?> imageSource, Func<ReportArtifact, string?> attachmentHref)
    {
        html.Append($"<article class=\"bug\" id=\"{bug.Key}\"><header><p class=\"eyebrow\">{bug.Key}{(bug.DefectReference is null ? string.Empty : $" · {bug.DefectReference} ({E(bug.DefectStatus ?? string.Empty)})")}</p>")
            .Append($"<h2>{E(bug.Title)}</h2><p>{Badge(bug.Severity)} <span class=\"tag\">Priority {E(bug.Priority)}</span>")
            .Append(bug.Category is null ? string.Empty : $" <span class=\"tag\">{E(bug.Category)}</span>")
            .Append($" <span class=\"tag\">{E(bug.Classification)}{(bug.Confidence > 0 ? $" · {bug.Confidence}% confidence" : string.Empty)}</span></p></header>");

        html.Append($"<p class=\"summary\">{E(bug.Summary)}</p>");

        html.Append("<dl class=\"grid\">");
        Row(html, "Application", bug.Application);
        Row(html, "Page", bug.PageUrl, link: true);
        Row(html, "Form", bug.Form);
        Row(html, "Field", bug.Field);
        Row(html, "Endpoint", bug.Endpoint);
        Row(html, "Browser", $"{bug.Browser}{(bug.BrowserVersion is null ? string.Empty : " " + bug.BrowserVersion)}");
        Row(html, "Viewport", bug.Viewport);
        Row(html, "First seen", Time(bug.FirstSeenAt));
        Row(html, "Times seen", bug.Occurrences?.ToString());
        Row(html, "Regression test", bug.RegressionTest);
        html.Append("</dl>");

        html.Append("<h3>Steps to reproduce</h3><ol class=\"steps\">");
        foreach (var step in bug.Steps)
        {
            var cls = step.Status switch { "failed" => "failed", "not reached" => "unreached", _ when step.Status.StartsWith("failed") => "failed-later", _ => step.IsCheck ? "check" : "" };
            html.Append($"<li class=\"{cls}\">{(step.IsCheck ? "<span class=\"kind\">Check</span> " : string.Empty)}{E(step.Description)}")
                .Append(step.Url is null ? string.Empty : $" — <a href=\"{A(step.Url)}\">{E(step.Url)}</a>")
                .Append(step.Status == "failed" ? " <strong class=\"bad\">← fails here</strong>" : step.Status is "passed" or "" ? string.Empty : $" <span class=\"muted\">({E(step.Status)})</span>")
                .Append(step.Error is null ? string.Empty : $"<div class=\"error\">{E(step.Error)}</div>")
                .Append("</li>");
        }
        html.Append("</ol>");

        if (bug.TestData is { Count: > 0 })
        {
            html.Append("<h3>Test data</h3><table class=\"data\"><tbody>");
            foreach (var (key, value) in bug.TestData)
                html.Append($"<tr><th><code>{E(key)}</code></th><td><code>{E(Shorten(value))}</code></td></tr>");
            html.Append("</tbody></table>");
        }

        html.Append("<div class=\"compare\"><div><h3>Expected</h3><p>").Append(E(bug.Expected)).Append("</p></div>")
            .Append("<div class=\"actual\"><h3>Actual</h3><p>").Append(E(bug.Actual)).Append("</p></div></div>");

        html.Append($"<div class=\"hint\"><h3>Where to look</h3><p>{E(bug.WhereToLook)}</p></div>");
        if (bug.PageText is not null) html.Append("<h3>What the page showed</h3><pre class=\"page\">").Append(E(bug.PageText)).Append("</pre>");

        if (bug.Screenshots.Count > 0)
        {
            html.Append("<h3>Screenshots</h3><div class=\"shots\">");
            foreach (var shot in bug.Screenshots)
            {
                var src = imageSource(shot);
                html.Append("<figure>")
                    .Append(src is null ? $"<div class=\"missing\">{E(shot.FileName)} — in the evidence pack</div>" : $"<a href=\"{A(src)}\"><img src=\"{A(src)}\" alt=\"{E(shot.Caption)}\" loading=\"lazy\"></a>")
                    .Append($"<figcaption>{E(shot.Caption)}</figcaption></figure>");
            }
            html.Append("</div>");
        }

        if (bug.Exchanges.Count > 0)
        {
            html.Append("<h3>API exchange</h3>");
            foreach (var x in bug.Exchanges)
            {
                html.Append($"<details{(x.StatusCode >= 400 || x.Method != "GET" ? " open" : string.Empty)}><summary><code>{E(x.Method)} {E(x.Url)}</code> → ")
                    .Append(x.StatusCode is { } status ? $"<strong class=\"{(status >= 400 ? "bad" : "good")}\">{status}</strong>" : $"<strong class=\"bad\">{E(x.FailureText ?? "no response")}</strong>")
                    .Append(x.DurationMs > 0 ? $" <span class=\"muted\">{x.DurationMs} ms</span>" : string.Empty).Append("</summary>");
                if (x.RequestHeaders is not null) html.Append($"<p class=\"label\">Request headers</p><pre>{E(x.RequestHeaders)}</pre>");
                if (x.Request is not null) html.Append($"<p class=\"label\">Request body</p><pre>{E(Pretty(x.Request))}</pre>");
                if (x.Response is not null) html.Append($"<p class=\"label\">Response body</p><pre>{E(Pretty(x.Response))}</pre>");
                html.Append("</details>");
            }
        }
        if (bug.Curl is not null)
            html.Append("<h3>Replay without a browser</h3><pre class=\"curl\">").Append(E(bug.Curl)).Append("</pre>")
                .Append("<p class=\"muted\">Masked values (***REDACTED***) and any session cookie must be replaced with your own. A form protected by an anti-forgery token needs a fresh token from the page.</p>");

        if (bug.Console.Count > 0)
        {
            html.Append("<h3>Browser console</h3><pre class=\"console\">");
            foreach (var line in bug.Console)
                html.Append(E($"[{line.Level}] {line.Message}{(line.Url is null ? string.Empty : $"  ({line.Url})")}")).Append('\n')
                    .Append(line.StackTrace is null ? string.Empty : E(Indent(line.StackTrace)) + "\n");
            html.Append("</pre>");
        }

        if (bug.Accessibility.Count > 0)
        {
            html.Append("<h3>Accessibility violations</h3><ul>");
            foreach (var v in bug.Accessibility)
                html.Append($"<li><strong>{E(v.Rule)}</strong>{(v.Impact is null ? string.Empty : $" ({E(v.Impact)})")}: {E(v.Help)}")
                    .Append(v.HelpUrl is null ? string.Empty : $" — <a href=\"{A(v.HelpUrl)}\">rule guidance</a>")
                    .Append(v.Elements.Count == 0 ? string.Empty : $"<br><span class=\"muted\">Elements:</span> {string.Join(", ", v.Elements.Select(t => $"<code>{E(t)}</code>"))}")
                    .Append("</li>");
            html.Append("</ul>");
        }

        if (bug.AffectedTests.Count > 0)
        {
            html.Append($"<h3>Affected tests ({bug.AffectedTests.Count})</h3><table class=\"affected\"><thead><tr><th>Test</th><th>Field / technique</th><th>Result</th></tr></thead><tbody>");
            foreach (var test in bug.AffectedTests)
                html.Append($"<tr><td><strong>{E(test.Reference)}</strong><br>{E(test.Name)}</td><td>{E(test.Field ?? "—")}<br><span class=\"muted\">{E(test.Technique ?? string.Empty)}</span></td><td>{E(test.Actual)}</td></tr>");
            html.Append("</tbody></table>");
        }

        if (bug.Attachments.Count > 0)
        {
            html.Append("<h3>More evidence</h3><ul>");
            foreach (var attachment in bug.Attachments)
            {
                var href = attachmentHref(attachment);
                html.Append("<li>").Append(href is null ? $"<code>{E(attachment.FileName)}</code>" : $"<a href=\"{A(href)}\"><code>{E(attachment.FileName)}</code></a>")
                    .Append($" <span class=\"muted\">({Size(attachment.SizeBytes)})</span> — {E(attachment.Caption)}")
                    .Append(href is null ? " <span class=\"muted\">Included in the evidence pack (.zip).</span>" : string.Empty).Append("</li>");
            }
            html.Append("</ul>");
        }
        if (bug.ExecutionUrl is not null) html.Append($"<p class=\"muted\">The full execution in QA NXT: <a href=\"{A(bug.ExecutionUrl)}\">{E(bug.ExecutionUrl)}</a></p>");

        html.Append($"<div class=\"verify\"><h3>Verify the fix</h3><p>{E(bug.VerifyTheFix)}</p></div></article>");
    }

    // ---- Markdown -------------------------------------------------------------------------

    /// <summary>The same report as Markdown, for pasting into an issue tracker. Images are
    /// referenced by the paths they have in the zip.</summary>
    public static string Markdown(RunBugReport report, Func<ReportArtifact, string?> path)
    {
        var run = report.Run;
        var md = new StringBuilder();
        md.AppendLine($"# Bug report — {run.Name}").AppendLine().AppendLine(Headline(report)).AppendLine();
        md.AppendLine("| | |").AppendLine("|---|---|");
        md.AppendLine($"| Project | {Cell(run.Project)} |");
        foreach (var app in run.Applications) md.AppendLine($"| Application | {Cell(app.Name)} — {Cell(app.BaseUrl)} |");
        if (run.Environment is not null) md.AppendLine($"| Environment | {Cell(run.Environment)} {Cell(run.EnvironmentUrl ?? string.Empty)} |");
        md.AppendLine($"| Browser | {run.Browser} {run.BrowserVersion} |");
        md.AppendLine($"| Started | {Time(run.StartedAt)} |").AppendLine($"| Duration | {Duration(run.DurationMs)} |");
        if (run.CommitSha is not null) md.AppendLine($"| Commit | {run.CommitSha} {run.Branch} |");
        md.AppendLine($"| Results | {run.Total} tests: {run.Passed} passed, {run.Failed} failed, {run.Skipped} skipped |");
        md.AppendLine($"| Run ID | {run.Id} |").AppendLine();

        if (report.Bugs.Count > 0)
        {
            md.AppendLine("| Bug | Severity | Title | Tests |").AppendLine("|---|---|---|---|");
            foreach (var bug in report.Bugs) md.AppendLine($"| {bug.Key} {bug.DefectReference} | {bug.Severity} | {Cell(bug.Title)} | {bug.AffectedTests.Count} |");
            md.AppendLine();
        }

        foreach (var bug in report.Bugs)
        {
            md.AppendLine($"## {bug.Key}: {bug.Title}").AppendLine();
            md.AppendLine($"**Severity:** {bug.Severity} · **Priority:** {bug.Priority}{(bug.Category is null ? string.Empty : $" · **Category:** {bug.Category}")}{(bug.DefectReference is null ? string.Empty : $" · **Defect:** {bug.DefectReference} ({bug.DefectStatus})")}").AppendLine();
            md.AppendLine(bug.Summary).AppendLine();
            md.AppendLine("| | |").AppendLine("|---|---|");
            void R(string label, string? value) { if (!string.IsNullOrWhiteSpace(value)) md.AppendLine($"| {label} | {Cell(value)} |"); }
            R("Application", bug.Application); R("Page", bug.PageUrl); R("Form", bug.Form); R("Field", bug.Field); R("Endpoint", bug.Endpoint);
            R("Browser", $"{bug.Browser} {bug.BrowserVersion}"); R("Viewport", bug.Viewport); R("First seen", Time(bug.FirstSeenAt));
            md.AppendLine().AppendLine("### Steps to reproduce").AppendLine();
            foreach (var step in bug.Steps)
                md.AppendLine($"{step.Order}. {(step.IsCheck ? "**Check:** " : string.Empty)}{step.Description}{(step.Url is null ? string.Empty : $" — {step.Url}")}"
                    + (step.Status == "failed" ? " **← fails here**" : step.Status is "passed" ? string.Empty : $" _({step.Status})_")
                    + (step.Error is null ? string.Empty : $"\n   > {step.Error.Replace("\n", " ")}"));
            if (bug.TestData is { Count: > 0 })
            {
                md.AppendLine().AppendLine("### Test data").AppendLine().AppendLine("| Field | Value |").AppendLine("|---|---|");
                foreach (var (key, value) in bug.TestData) md.AppendLine($"| `{key}` | `{Cell(Shorten(value))}` |");
            }
            md.AppendLine().AppendLine("### Expected").AppendLine().AppendLine(bug.Expected);
            md.AppendLine().AppendLine("### Actual").AppendLine().AppendLine(bug.Actual);
            md.AppendLine().AppendLine("### Where to look").AppendLine().AppendLine(bug.WhereToLook);
            if (bug.PageText is not null) md.AppendLine().AppendLine("### What the page showed").AppendLine().AppendLine("```").AppendLine(bug.PageText).AppendLine("```");
            if (bug.Screenshots.Count > 0)
            {
                md.AppendLine().AppendLine("### Screenshots").AppendLine();
                foreach (var shot in bug.Screenshots)
                    md.AppendLine(path(shot) is { } p ? $"![{shot.Caption}]({p})" : $"- {shot.Caption}: {shot.FileName}");
            }
            if (bug.Exchanges.Count > 0)
            {
                md.AppendLine().AppendLine("### API exchange").AppendLine();
                foreach (var x in bug.Exchanges)
                {
                    md.AppendLine($"**{x.Method} {x.Url}** → {(x.StatusCode?.ToString() ?? x.FailureText ?? "no response")} {(x.DurationMs > 0 ? $" ({x.DurationMs} ms)" : string.Empty)}");
                    if (x.Request is not null) md.AppendLine().AppendLine("Request:").AppendLine("```").AppendLine(Pretty(x.Request)).AppendLine("```");
                    if (x.Response is not null) md.AppendLine().AppendLine("Response:").AppendLine("```").AppendLine(Pretty(x.Response)).AppendLine("```");
                    md.AppendLine();
                }
            }
            if (bug.Curl is not null) md.AppendLine("### Replay without a browser").AppendLine().AppendLine("```sh").AppendLine(bug.Curl).AppendLine("```");
            if (bug.Console.Count > 0)
            {
                md.AppendLine().AppendLine("### Browser console").AppendLine().AppendLine("```");
                foreach (var line in bug.Console) md.AppendLine($"[{line.Level}] {line.Message}");
                md.AppendLine("```");
            }
            if (bug.Accessibility.Count > 0)
            {
                md.AppendLine().AppendLine("### Accessibility violations").AppendLine();
                foreach (var v in bug.Accessibility) md.AppendLine($"- **{v.Rule}** ({v.Impact}): {v.Help} {v.HelpUrl} — {string.Join(", ", v.Elements.Select(t => $"`{t}`"))}");
            }
            md.AppendLine().AppendLine($"### Affected tests ({bug.AffectedTests.Count})").AppendLine();
            foreach (var test in bug.AffectedTests) md.AppendLine($"- **{test.Reference}** {test.Name}: {test.Actual}");
            if (bug.Attachments.Count > 0)
            {
                md.AppendLine().AppendLine("### More evidence").AppendLine();
                foreach (var a in bug.Attachments) md.AppendLine($"- {(path(a) is { } p ? $"[{a.FileName}]({p})" : a.FileName)} — {a.Caption}");
            }
            md.AppendLine().AppendLine("### Verify the fix").AppendLine().AppendLine(bug.VerifyTheFix).AppendLine();
        }

        if (report.NotProductBugs.Count > 0)
        {
            md.AppendLine("## Failures that are not product bugs").AppendLine();
            foreach (var other in report.NotProductBugs) md.AppendLine($"- **{other.Reference}** {other.Name} — _{other.Classification}_: {other.Message} Who acts: {other.WhoActs}");
            md.AppendLine();
        }
        if (report.PassedOnRetry.Count > 0)
        {
            md.AppendLine("## Passed only on retry").AppendLine();
            foreach (var f in report.PassedOnRetry) md.AppendLine($"- **{f.Reference}** {f.Name} — {f.Attempts} attempts; first failure: {f.FirstFailure}");
            md.AppendLine();
        }
        if (report.Skipped.Count > 0)
        {
            md.AppendLine("## Not run").AppendLine();
            foreach (var g in report.Skipped) md.AppendLine($"- {g.Count} × {g.Reason}");
            md.AppendLine();
        }
        md.AppendLine($"_Generated by QA NXT on {Time(report.GeneratedAt)}. Secrets are masked in every request, response and log._");
        return md.ToString();
    }

    // ---- Zip ------------------------------------------------------------------------------

    /// <summary>The evidence pack: the report in three forms and every file it refers to.</summary>
    public static async Task<byte[]> ZipAsync(RunBugReport report, ArtifactReader read, CancellationToken ct = default)
    {
        // Each artifact gets one path, under the bug it belongs to; a screenshot of another
        // affected test is prefixed with that test so names never collide.
        var paths = new Dictionary<Guid, string>();
        var omitted = new List<string>();
        long total = 0;
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var bug in report.Bugs)
            {
                var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var artifact in bug.Screenshots.Concat(bug.Attachments))
                {
                    if (paths.ContainsKey(artifact.Id)) continue;
                    if (total + artifact.SizeBytes > MaxZipEvidenceBytes)
                    {
                        omitted.Add($"{bug.Key}/{artifact.FileName} ({Size(artifact.SizeBytes)})");
                        continue;
                    }
                    var bytes = await read(artifact, ct);
                    if (bytes is null) { omitted.Add($"{bug.Key}/{artifact.FileName} (no longer in the artifact store)"); continue; }
                    var name = SafeName(artifact.Caption.Contains(": ", StringComparison.Ordinal) && artifact.Kind == "screenshot"
                        ? $"{artifact.Caption[..artifact.Caption.IndexOf(':')]}-{artifact.FileName}" : artifact.FileName);
                    var unique = name;
                    for (var i = 2; !used.Add(unique); i++) unique = $"{Path.GetFileNameWithoutExtension(name)}-{i}{Path.GetExtension(name)}";
                    var path = $"evidence/{bug.Key}/{unique}";
                    var entry = zip.CreateEntry(path, artifact.ContentType.StartsWith("image/") || artifact.ContentType.Contains("zip") || artifact.ContentType.StartsWith("video/")
                        ? CompressionLevel.NoCompression : CompressionLevel.Optimal);
                    await using (var stream = entry.Open()) await stream.WriteAsync(bytes, ct);
                    paths[artifact.Id] = path;
                    total += bytes.Length;
                }
            }

            string? PathOf(ReportArtifact a) => paths.GetValueOrDefault(a.Id);
            await Write(zip, "bug-report.html", Html(report, PathOf, PathOf), ct);
            await Write(zip, "bug-report.md", Markdown(report, PathOf), ct);
            await Write(zip, "bug-report.json", JsonSerializer.Serialize(report, Json), ct);
            await Write(zip, "README.txt", Readme(report, omitted), ct);
        }
        return buffer.ToArray();
    }

    private static async Task Write(ZipArchive zip, string name, string content, CancellationToken ct)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        await using var stream = entry.Open();
        await stream.WriteAsync(Encoding.UTF8.GetBytes(content), ct);
    }

    private static string Readme(RunBugReport report, List<string> omitted)
    {
        var text = new StringBuilder();
        text.AppendLine($"QA NXT bug report — {report.Run.Name}").AppendLine()
            .AppendLine("bug-report.html   Open in any browser. Start here.")
            .AppendLine("bug-report.md     The same report as Markdown, to paste into an issue tracker.")
            .AppendLine("bug-report.json   The same report as data.")
            .AppendLine("evidence/BUG-nn/  Screenshots, the Playwright trace, the video and page snapshots for each bug.").AppendLine()
            .AppendLine("A Playwright trace replays the test step by step with the DOM, network and console at each step:")
            .AppendLine("    npx playwright show-trace evidence/BUG-01/trace.zip")
            .AppendLine("or drop the file on https://trace.playwright.dev (it is opened in your browser, not uploaded).").AppendLine()
            .AppendLine("Secrets, tokens, card numbers and passwords are masked in every file.");
        if (omitted.Count > 0)
        {
            text.AppendLine().AppendLine("Left out of this pack (open them from the run in QA NXT):");
            foreach (var line in omitted) text.AppendLine($"    {line}");
        }
        return text.ToString();
    }

    // ---- Helpers --------------------------------------------------------------------------

    private static string Headline(RunBugReport report)
    {
        var run = report.Run;
        var bugs = report.Bugs.Count == 0 ? "no bugs" : report.Bugs.Count == 1 ? "1 bug" : $"{report.Bugs.Count} bugs";
        var failing = report.Bugs.Sum(b => b.AffectedTests.Count);
        return $"{run.Total} tests ran: {run.Passed} passed, {run.Failed} failed, {run.Skipped} skipped. "
            + $"The failures come down to {bugs}"
            + (report.Bugs.Count > 0 ? $" ({failing} failing test{(failing == 1 ? string.Empty : "s")})" : string.Empty)
            + (report.NotProductBugs.Count > 0 ? $", plus {report.NotProductBugs.Count} failure{(report.NotProductBugs.Count == 1 ? string.Empty : "s")} that {(report.NotProductBugs.Count == 1 ? "is" : "are")} not the application's fault" : string.Empty)
            + ".";
    }

    private static void Row(StringBuilder html, string label, string? value, bool link = false)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        var shown = link && Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? $"<a href=\"{A(value)}\">{E(value)}</a>" : E(value);
        html.Append($"<div><dt>{E(label)}</dt><dd>{shown}</dd></div>");
    }

    private static string Tile(string label, int value, string? tone)
        => $"<div class=\"tile{(tone is null ? string.Empty : " " + tone)}\"><span>{value}</span>{E(label)}</div>";

    private static string Badge(string severity)
        => $"<span class=\"sev sev-{severity.ToLowerInvariant()}\">{E(severity)}</span>";

    private static string E(string? value) => WebUtility.HtmlEncode(value ?? string.Empty);

    /// <summary>An attribute value. Only http(s), data images, fragment and relative links are
    /// allowed, so nothing the application under test returned can become a script link.</summary>
    private static string A(string value)
    {
        var safe = value.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("data:image/", StringComparison.Ordinal) || value.StartsWith('#')
            || Regex.IsMatch(value, @"^[A-Za-z0-9_./ -]+$") && !value.Contains(':');
        return WebUtility.HtmlEncode(safe ? value : "#");
    }

    private static string Cell(string value) => value.Replace("|", "\\|").Replace("\n", " ");

    private static string Shorten(string value)
        => value.Length <= 200 ? value : value.Distinct().Count() == 1 ? $"\"{value[0]}\" × {value.Length}" : $"{value[..120]}… ({value.Length} characters)";

    private static string Pretty(string body)
    {
        var trimmed = body.TrimStart();
        if (!trimmed.StartsWith('{') && !trimmed.StartsWith('[')) return body;
        try
        {
            using var document = JsonDocument.Parse(body);
            return JsonSerializer.Serialize(document.RootElement, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (JsonException)
        {
            return body;
        }
    }

    private static string Indent(string text) => string.Join("\n", text.Split('\n').Take(15).Select(l => "    " + l));

    private static string Time(DateTimeOffset? at) => at is null ? string.Empty : at.Value.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss 'UTC'");

    private static string Duration(int ms) => ms <= 0 ? string.Empty : ms < 60_000 ? $"{ms / 1000.0:0.#} s" : $"{ms / 60_000} min {ms / 1000 % 60} s";

    private static string Size(long bytes) => bytes < 1024 ? $"{bytes} B" : bytes < 1024 * 1024 ? $"{bytes / 1024.0:0} KB" : $"{bytes / 1024.0 / 1024.0:0.0} MB";

    private static string SafeName(string name)
    {
        var safe = new string(name.Select(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_' ? c : '-').ToArray()).Trim('-');
        return safe.Length == 0 ? "file" : safe.Length > 100 ? safe[^100..] : safe;
    }

    private const string Css = """
:root{--ink:#1d2330;--muted:#5b6475;--line:#dfe3ea;--bg:#ffffff;--soft:#f5f7fa;--bad:#b42318;--bad-bg:#fdecea;--good:#067647;--good-bg:#e7f6ec;--warn:#b54708;--warn-bg:#fef4e6;--brand:#3b5bdb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 20px 64px}a{color:var(--brand);word-break:break-all}
h1{font-size:28px;margin:4px 0 8px}h2{font-size:21px;margin:0 0 12px}h3{font-size:15px;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.eyebrow{margin:0;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:600}.lede{font-size:17px;color:var(--muted);margin:0}
section,article{margin-top:28px}.top{border-bottom:1px solid var(--line);padding-bottom:18px}
dl.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px 24px;margin:0}dl.grid div{min-width:0}dt{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}dd{margin:0;overflow-wrap:anywhere}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.tile{border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:110px;color:var(--muted);font-size:13px}.tile span{display:block;font-size:24px;font-weight:700;color:var(--ink)}
.tile.bad span{color:var(--bad)}.tile.good span{color:var(--good)}
table{width:100%;border-collapse:collapse;margin:6px 0;font-size:14px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{background:var(--soft);font-weight:600}
.bug{border:1px solid var(--line);border-radius:14px;padding:22px 24px;page-break-before:always}.bug header{margin-bottom:10px}.summary{font-size:16px}
.sev{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:700;text-transform:uppercase}.sev-blocker,.sev-critical{background:var(--bad);color:#fff}.sev-major{background:var(--warn-bg);color:var(--warn)}.sev-minor,.sev-trivial{background:var(--soft);color:var(--muted)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 10px;font-size:12px;color:var(--muted);margin:2px 0}
ol.steps{padding-left:22px}ol.steps li{margin:4px 0}ol.steps li.failed{background:var(--bad-bg);border-radius:6px;padding:4px 8px}ol.steps li.unreached,ol.steps li.failed-later{color:var(--muted)}
.kind{font-size:11px;font-weight:700;text-transform:uppercase;color:var(--brand)}.error{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:var(--bad);margin-top:4px;white-space:pre-wrap}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:14px}.compare>div{background:var(--good-bg);border-radius:10px;padding:2px 14px}.compare>.actual{background:var(--bad-bg)}
.hint{background:var(--warn-bg);border-radius:10px;padding:2px 14px;margin-top:14px}.verify{background:var(--soft);border-radius:10px;padding:2px 14px;margin-top:18px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--soft)}figure img{display:block;width:100%;height:auto}figcaption{padding:6px 10px;font-size:13px;color:var(--muted)}.missing{padding:30px 10px;text-align:center;color:var(--muted)}
pre{background:#0f1420;color:#e6e9ef;border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:420px}
details{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:8px 0}summary{cursor:pointer}.label{margin:8px 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}.muted{color:var(--muted)}.bad{color:var(--bad)}.good{color:var(--good)}
.affected th:nth-child(1){width:28%}.affected th:nth-child(2){width:18%}pre.page{background:var(--soft);color:var(--ink);border:1px solid var(--line)}
.aside{border-top:1px solid var(--line);padding-top:18px}footer{margin-top:40px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:14px}
@media (max-width:720px){.compare{grid-template-columns:1fr}.bug{padding:16px}}
@media print{main{max-width:none;padding:0}pre{max-height:none}details{break-inside:avoid}details:not([open])>*:not(summary){display:none}a{color:inherit}}
""";
}
