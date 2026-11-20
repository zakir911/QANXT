using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddRetainHeavyArtifactsOnPass : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // False for every existing project, deliberately.
            //
            // Until now a trace and a video were kept for every execution whatever its
            // verdict. A 6,354-test run wrote 7.3GB of them, filled the disk, took the
            // database down twice and left 992 tests with no verdict at all - and not one
            // of the passing traces was ever opened. Backfilling true would preserve that
            // behaviour for every project already in the database, which is the behaviour
            // being fixed.
            //
            // A pass keeps its step results and its final screenshot either way, so no
            // project loses the evidence of a verdict. What it loses is the debugging aid
            // for executions nobody is debugging, and anyone who wants it back sets this.
            migrationBuilder.AddColumn<bool>(
                name: "retain_heavy_artifacts_on_pass",
                table: "projects",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "retain_heavy_artifacts_on_pass",
                table: "projects");
        }
    }
}
