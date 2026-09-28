using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddEnvironmentsAndGateActions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "action",
                table: "quality_gate_rules",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "environment",
                table: "quality_gate_rules",
                type: "character varying(40)",
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "message",
                table: "quality_gate_rules",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "self_healing_gate_policy",
                table: "projects",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "allowed_domains",
                table: "environments",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "api_base_url",
                table: "environments",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "is_enabled",
                table: "environments",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "key",
                table: "environments",
                type: "character varying(40)",
                maxLength: 40,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<int>(
                name: "kind",
                table: "environments",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "production_authorization_note",
                table: "environments",
                type: "character varying(1000)",
                maxLength: 1000,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "production_authorized_at",
                table: "environments",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "production_authorized_by_user_id",
                table: "environments",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "production_testing_authorized",
                table: "environments",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "rate_limit_per_minute",
                table: "environments",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            // Every existing row would take the "" default and collide on the unique index
            // below. Derived from the name instead: lowercased, non-alphanumerics collapsed
            // to a hyphen, and the row's own id appended if two names still slug alike.
            migrationBuilder.Sql("""
                UPDATE environments
                SET key = LEFT(REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g'), 40)
                WHERE key = '' OR key IS NULL;

                UPDATE environments e
                SET key = LEFT(e.key, 32) || '-' || LEFT(REPLACE(e.id::text, '-', ''), 7)
                WHERE EXISTS (
                    SELECT 1 FROM environments other
                    WHERE other.project_id = e.project_id
                      AND other.key = e.key
                      AND other.id <> e.id
                );
                """);

            migrationBuilder.CreateIndex(
                name: "ix_environments_project_id_key",
                table: "environments",
                columns: new[] { "project_id", "key" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_environments_project_id_key",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "action",
                table: "quality_gate_rules");

            migrationBuilder.DropColumn(
                name: "environment",
                table: "quality_gate_rules");

            migrationBuilder.DropColumn(
                name: "message",
                table: "quality_gate_rules");

            migrationBuilder.DropColumn(
                name: "self_healing_gate_policy",
                table: "projects");

            migrationBuilder.DropColumn(
                name: "allowed_domains",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "api_base_url",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "is_enabled",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "key",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "kind",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "production_authorization_note",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "production_authorized_at",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "production_authorized_by_user_id",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "production_testing_authorized",
                table: "environments");

            migrationBuilder.DropColumn(
                name: "rate_limit_per_minute",
                table: "environments");
        }
    }
}
