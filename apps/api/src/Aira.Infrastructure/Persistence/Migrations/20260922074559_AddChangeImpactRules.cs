using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddChangeImpactRules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "change_impact_rules",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    path_pattern = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    value = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    notes = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    is_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_change_impact_rules", x => x.id);
                    table.ForeignKey(
                        name: "fk_change_impact_rules_projects_project_id",
                        column: x => x.project_id,
                        principalTable: "projects",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_change_impact_rules_project_id_is_enabled",
                table: "change_impact_rules",
                columns: new[] { "project_id", "is_enabled" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "change_impact_rules");
        }
    }
}
