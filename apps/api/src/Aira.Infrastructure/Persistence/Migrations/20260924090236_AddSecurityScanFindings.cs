using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddSecurityScanFindings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "security_scan_findings",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    security_scan_id = table.Column<Guid>(type: "uuid", nullable: false),
                    security_finding_id = table.Column<Guid>(type: "uuid", nullable: false),
                    severity = table.Column<int>(type: "integer", nullable: false),
                    confidence = table.Column<int>(type: "integer", nullable: false),
                    was_new = table.Column<bool>(type: "boolean", nullable: false),
                    was_regression = table.Column<bool>(type: "boolean", nullable: false),
                    reported_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_security_scan_findings", x => x.id);
                    table.ForeignKey(
                        name: "fk_security_scan_findings_security_findings_security_finding_id",
                        column: x => x.security_finding_id,
                        principalTable: "security_findings",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_security_scan_findings_security_scans_security_scan_id",
                        column: x => x.security_scan_id,
                        principalTable: "security_scans",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_security_scan_findings_security_finding_id",
                table: "security_scan_findings",
                column: "security_finding_id");

            migrationBuilder.CreateIndex(
                name: "ix_security_scan_findings_security_scan_id_security_finding_id",
                table: "security_scan_findings",
                columns: new[] { "security_scan_id", "security_finding_id" },
                unique: true);

            // Backfill from what the finding rows already say.
            //
            // Until now a scan's findings were read off security_findings.security_scan_id,
            // which names each flaw's latest sighting. That is a lossy record — a flaw seen by
            // three scans left a trace on only the newest — but it is the only record there is,
            // and leaving it behind would make every historical scan read as a clean run the
            // moment this migration landed. Which is the exact failure the table exists to stop.
            //
            // was_new and was_regression are derived the way the old read path derived them, so
            // a backfilled row says no more and no less than the page it replaces did.
            migrationBuilder.Sql(@"
                INSERT INTO security_scan_findings (
                    id, organization_id, security_scan_id, security_finding_id,
                    severity, confidence, was_new, was_regression, reported_at, created_at)
                SELECT gen_random_uuid(), f.organization_id, f.security_scan_id, f.id,
                       f.severity, f.confidence,
                       f.first_seen_at = f.last_seen_at, f.regressed_at IS NOT NULL,
                       f.last_seen_at, now()
                FROM security_findings f
                WHERE f.security_scan_id IS NOT NULL
                ON CONFLICT DO NOTHING;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "security_scan_findings");
        }
    }
}
