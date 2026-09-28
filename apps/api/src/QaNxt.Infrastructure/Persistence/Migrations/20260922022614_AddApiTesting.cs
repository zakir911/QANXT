using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddApiTesting : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "api_request_json",
                table: "test_steps",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "kind",
                table: "test_cases",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AlterColumn<string>(
                name: "attribute_name",
                table: "assertions",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true,
                oldClrType: typeof(string),
                oldType: "character varying(100)",
                oldMaxLength: 100,
                oldNullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_project_id_kind",
                table: "test_cases",
                columns: new[] { "project_id", "kind" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_test_cases_project_id_kind",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "api_request_json",
                table: "test_steps");

            migrationBuilder.DropColumn(
                name: "kind",
                table: "test_cases");

            migrationBuilder.AlterColumn<string>(
                name: "attribute_name",
                table: "assertions",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true,
                oldClrType: typeof(string),
                oldType: "character varying(200)",
                oldMaxLength: 200,
                oldNullable: true);
        }
    }
}
