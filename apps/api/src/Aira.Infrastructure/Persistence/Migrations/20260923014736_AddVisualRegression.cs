using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddVisualRegression : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<decimal>(
                name: "visual_difference_percent",
                table: "test_actions",
                type: "numeric",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "visual_json",
                table: "test_actions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "visual_verdict",
                table: "test_actions",
                type: "text",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "visual_baselines",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    browser = table.Column<int>(type: "integer", nullable: false),
                    viewport_width = table.Column<int>(type: "integer", nullable: false),
                    viewport_height = table.Column<int>(type: "integer", nullable: false),
                    storage_key = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    width = table.Column<int>(type: "integer", nullable: false),
                    height = table.Column<int>(type: "integer", nullable: false),
                    size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    approved_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    approved_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    source_test_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_visual_baselines", x => x.id);
                    table.ForeignKey(
                        name: "fk_visual_baselines_test_cases_test_case_id",
                        column: x => x.test_case_id,
                        principalTable: "test_cases",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_visual_baselines_test_case_id_name_browser_viewport_width_v~",
                table: "visual_baselines",
                columns: new[] { "test_case_id", "name", "browser", "viewport_width", "viewport_height" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "visual_baselines");

            migrationBuilder.DropColumn(
                name: "visual_difference_percent",
                table: "test_actions");

            migrationBuilder.DropColumn(
                name: "visual_json",
                table: "test_actions");

            migrationBuilder.DropColumn(
                name: "visual_verdict",
                table: "test_actions");
        }
    }
}
