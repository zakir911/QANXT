using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddCrawlInteractionMode : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "allow_state_changing_clicks",
                table: "applications",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            // "links" and not "": the worker reads this mode directly, and an empty string is
            // not "links", so every application that already existed would have been
            // upgraded from following links to clicking controls by running a migration.
            // The defaultValue covers new rows; the UPDATE covers the ones already there.
            migrationBuilder.AddColumn<string>(
                name: "interaction_mode",
                table: "applications",
                type: "text",
                nullable: false,
                defaultValue: "links");

            migrationBuilder.Sql(
                "UPDATE applications SET interaction_mode = 'links' "
                + "WHERE COALESCE(BTRIM(interaction_mode), '') = '';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "allow_state_changing_clicks",
                table: "applications");

            migrationBuilder.DropColumn(
                name: "interaction_mode",
                table: "applications");
        }
    }
}
