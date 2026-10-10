using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddSeedUrlsAndSitemap : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "seed_urls",
                table: "applications",
                type: "text",
                nullable: false,
                defaultValue: "");

            // true, matching the entity default. EF generates false for a bool, which would
            // have left every existing application quietly different from every new one:
            // reading a sitemap is a plain GET of a file the application publishes about
            // itself, and the applications that most need the extra coverage are the ones
            // that already exist.
            migrationBuilder.AddColumn<bool>(
                name: "use_sitemap",
                table: "applications",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.Sql("UPDATE applications SET use_sitemap = TRUE;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "seed_urls",
                table: "applications");

            migrationBuilder.DropColumn(
                name: "use_sitemap",
                table: "applications");
        }
    }
}
