using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class FreezeDiscoveryActionBudget : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "max_actions",
                table: "discovery_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            // Existing rows are backfilled from their application's current action budget,
            // not left at 0 and not given a guessed constant.
            //
            // 0 would say those runs were allowed no clicks at all, which is false and would
            // be read as fact by anyone looking at why an old crawl stopped. The honest
            // value is the one they actually ran under, and until this migration the payload
            // read the application's MaxActions live at dispatch time — so the application's
            // current setting is exactly what those runs used, unless somebody has since
            // changed it. That is the best available reconstruction and it reproduces the
            // old behaviour rather than inventing a number.
            //
            // A run whose application has since been deleted keeps 0 and is covered by the
            // guard below, because a value of 0 reaching the clamp would otherwise become a
            // budget of 1.
            migrationBuilder.Sql(@"
                UPDATE discovery_runs AS r
                SET max_actions = a.max_actions
                FROM applications AS a
                WHERE a.id = r.application_id AND a.max_actions > 0;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "max_actions",
                table: "discovery_runs");
        }
    }
}
