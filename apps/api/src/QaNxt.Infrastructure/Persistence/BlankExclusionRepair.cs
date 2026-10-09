namespace QaNxt.Infrastructure.Persistence;

/// <summary>Repairs applications stored with no crawl exclusions.
///
/// <para>Until the blank-field fix, <c>ExcludedPaths</c> was written as
/// <c>request.ExcludedPaths?.Trim() ?? "/logout,/signout,/delete"</c>. In C#
/// <c>""?.Trim()</c> is <c>""</c>, not null, so clearing the field in the console stored an
/// empty exclusion list: the only control stopping discovery from opening sign-out or a
/// delete link on somebody else's application, gone silently (QA pass, ISSUE-001).</para>
///
/// <para>Fixing the write path does not repair what is already stored, so a migration runs
/// this once. Every blank row is an artifact of that defect: the API has never offered a
/// supported way to ask for an empty exclusion list, so there is no deliberate empty list
/// to overwrite. The repair only ever adds protection, never removes it.</para>
///
/// <para>The statement lives here rather than inline in the migration so the migration and
/// the test that proves it both use the same text. A repair whose test asserts against a
/// copy of the SQL can pass while the migration is wrong.</para>
/// </summary>
public static class BlankExclusionRepair
{
    /// <summary>What an application excludes when nobody has chosen.</summary>
    public const string DefaultExcludedPaths = "/logout,/signout,/delete";

    /// <summary>
    /// Sets the default on every application whose exclusion list is null, empty or only
    /// whitespace, and touches nothing else. Idempotent: running it twice changes nothing
    /// the second time, because repaired rows no longer match.
    /// </summary>
    public const string Sql = """
        UPDATE applications
           SET excluded_paths = '/logout,/signout,/delete'
         WHERE COALESCE(BTRIM(excluded_paths), '') = '';
        """;
}
