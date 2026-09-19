using System.Text;
using Microsoft.EntityFrameworkCore;

namespace Aira.Infrastructure.Persistence;

/// <summary>PostgreSQL folds unquoted identifiers to lower case, so PascalCase columns end up
/// needing quotes in every hand-written query, migration script and psql session. Converting
/// the whole model to snake_case once keeps the database ergonomic for operators.</summary>
public static class SnakeCaseNaming
{
    public static void ApplySnakeCaseNames(this ModelBuilder builder)
    {
        foreach (var entity in builder.Model.GetEntityTypes())
        {
            var tableName = entity.GetTableName();
            if (tableName is not null) entity.SetTableName(ToSnakeCase(tableName));

            var storeObject = Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier
                .Table(entity.GetTableName()!, entity.GetSchema());

            foreach (var property in entity.GetProperties())
            {
                var columnName = property.GetColumnName(storeObject) ?? property.Name;
                property.SetColumnName(ToSnakeCase(columnName));
            }

            foreach (var key in entity.GetKeys())
                key.SetName(ToSnakeCase(key.GetName()!));

            foreach (var foreignKey in entity.GetForeignKeys())
                foreignKey.SetConstraintName(ToSnakeCase(foreignKey.GetConstraintName()!));

            foreach (var index in entity.GetIndexes())
                index.SetDatabaseName(ToSnakeCase(index.GetDatabaseName()!));
        }
    }

    public static string ToSnakeCase(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;

        var builder = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var current = name[i];
            if (char.IsUpper(current))
            {
                var isStart = i == 0;
                var previousIsLower = !isStart && char.IsLower(name[i - 1]);
                var previousIsDigit = !isStart && char.IsDigit(name[i - 1]);
                // "TestCaseId" -> test_case_id, "AiRequestId" -> ai_request_id, and an
                // acronym run like "URLValue" -> url_value rather than u_r_l_value.
                var nextIsLower = i + 1 < name.Length && char.IsLower(name[i + 1]);
                var previousIsUpper = !isStart && char.IsUpper(name[i - 1]);

                if (!isStart && (previousIsLower || previousIsDigit || (previousIsUpper && nextIsLower)) && builder[^1] != '_')
                    builder.Append('_');

                builder.Append(char.ToLowerInvariant(current));
            }
            else if (current == ' ' || current == '-')
            {
                if (builder.Length > 0 && builder[^1] != '_') builder.Append('_');
            }
            else
            {
                builder.Append(char.ToLowerInvariant(current));
            }
        }

        return builder.ToString();
    }
}
