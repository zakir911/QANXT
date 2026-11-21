using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    /// <summary>
    /// Says what produced each coverage gap, so that whatever rebuilds its own does not
    /// delete somebody else's.
    ///
    /// The form engine clears and rewrites its gaps on every generation, and the clause
    /// doing it took every gap on the application with no form attached. That was safe while
    /// the form engine was the only thing producing one. Discovery now records a gap for each
    /// state-changing link it refused to follow — a link has no form — and a design run
    /// deleted all of them between the crawl that found them and the report that should have
    /// shown them.
    ///
    /// Existing rows default to "form-engine", which is what every one of them is: nothing
    /// else wrote a gap before this.
    /// </summary>
    public partial class AddCoverageGapSource : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "source",
                table: "coverage_gaps",
                type: "character varying(40)",
                maxLength: 40,
                nullable: false,
                defaultValue: "form-engine");

            migrationBuilder.CreateIndex(
                name: "ix_coverage_gaps_application_id_source",
                table: "coverage_gaps",
                columns: new[] { "application_id", "source" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_coverage_gaps_application_id_source",
                table: "coverage_gaps");

            migrationBuilder.DropColumn(
                name: "source",
                table: "coverage_gaps");
        }
    }
}
