using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <summary>Gives back the crawl exclusions that applications stored before the
    /// blank-field fix lost.
    ///
    /// <para>Data only: no schema changes. See <see cref="BlankExclusionRepair"/> for why
    /// every blank row is an artifact of the defect rather than somebody's choice.</para>
    /// </summary>
    public partial class RestoreBlankExcludedPaths : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(BlankExclusionRepair.Sql);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deliberately nothing. A repaired row is indistinguishable from one that was
            // always correct, so there is no set of rows to put back; blanking every
            // application that currently carries the default would hand the defect to
            // applications that never had it. Rolling this migration back leaves the data
            // repaired, which is the safe direction.
        }
    }
}
