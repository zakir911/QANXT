using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAccessibilityResults : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "accessibility_json",
                table: "test_actions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "accessibility_serious_count",
                table: "test_actions",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "accessibility_violation_count",
                table: "test_actions",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "accessibility_json",
                table: "test_actions");

            migrationBuilder.DropColumn(
                name: "accessibility_serious_count",
                table: "test_actions");

            migrationBuilder.DropColumn(
                name: "accessibility_violation_count",
                table: "test_actions");
        }
    }
}
