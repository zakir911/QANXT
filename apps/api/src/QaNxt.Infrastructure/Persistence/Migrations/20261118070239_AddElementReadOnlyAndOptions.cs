using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddElementReadOnlyAndOptions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "is_read_only",
                table: "application_elements",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "options_json",
                table: "application_elements",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "is_read_only",
                table: "application_elements");

            migrationBuilder.DropColumn(
                name: "options_json",
                table: "application_elements");
        }
    }
}
