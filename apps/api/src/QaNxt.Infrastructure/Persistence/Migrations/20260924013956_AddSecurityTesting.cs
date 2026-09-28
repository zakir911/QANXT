using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddSecurityTesting : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "security_blocked_requests",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    security_scan_id = table.Column<Guid>(type: "uuid", nullable: false),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    http_method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    risk = table.Column<int>(type: "integer", nullable: false),
                    reason = table.Column<int>(type: "integer", nullable: false),
                    explanation = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    test_id = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_security_blocked_requests", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "security_scans",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    environment_id = table.Column<Guid>(type: "uuid", nullable: true),
                    reference = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    profile = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    scope_snapshot_json = table.Column<string>(type: "jsonb", nullable: true),
                    authorization_note = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    requests_issued = table.Column<int>(type: "integer", nullable: false),
                    requests_blocked = table.Column<int>(type: "integer", nullable: false),
                    tests_executed = table.Column<int>(type: "integer", nullable: false),
                    tests_skipped = table.Column<int>(type: "integer", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_security_scans", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "security_scopes",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    enabled = table.Column<bool>(type: "boolean", nullable: false),
                    allowed_domains = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    allowed_api_domains = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    allowed_paths = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    blocked_paths = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    environment_id = table.Column<Guid>(type: "uuid", nullable: true),
                    max_requests_per_second = table.Column<int>(type: "integer", nullable: false),
                    max_concurrent_requests = table.Column<int>(type: "integer", nullable: false),
                    max_scan_duration_minutes = table.Column<int>(type: "integer", nullable: false),
                    allow_active_testing = table.Column<bool>(type: "boolean", nullable: false),
                    allow_destructive_testing = table.Column<bool>(type: "boolean", nullable: false),
                    allow_production = table.Column<bool>(type: "boolean", nullable: false),
                    authorization_note = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    authorized_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    authorized_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_security_scopes", x => x.id);
                    table.ForeignKey(
                        name: "fk_security_scopes_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_security_scopes_environments_environment_id",
                        column: x => x.environment_id,
                        principalTable: "environments",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "security_findings",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    security_scan_id = table.Column<Guid>(type: "uuid", nullable: true),
                    fingerprint = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    reference = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    title = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    category = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    test_id = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    endpoint = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: true),
                    http_method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: true),
                    parameter = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    observed_as_role = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    severity = table.Column<int>(type: "integer", nullable: false),
                    confidence = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    severity_factors_json = table.Column<string>(type: "jsonb", nullable: true),
                    cwe = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    cwe_confidence = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    owasp_api_category = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    owasp_web_category = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    owasp_edition = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    description = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    impact = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    remediation = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    reproduction_steps = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    evidence_path = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    first_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    resolved_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    regressed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    disposition_note = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    disposition_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    disposition_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_security_findings", x => x.id);
                    table.ForeignKey(
                        name: "fk_security_findings_security_scans_security_scan_id",
                        column: x => x.security_scan_id,
                        principalTable: "security_scans",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "ix_security_blocked_requests_security_scan_id",
                table: "security_blocked_requests",
                column: "security_scan_id");

            migrationBuilder.CreateIndex(
                name: "ix_security_findings_application_id_fingerprint",
                table: "security_findings",
                columns: new[] { "application_id", "fingerprint" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_security_findings_organization_id_status",
                table: "security_findings",
                columns: new[] { "organization_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_security_findings_security_scan_id",
                table: "security_findings",
                column: "security_scan_id");

            migrationBuilder.CreateIndex(
                name: "ix_security_scans_application_id_started_at",
                table: "security_scans",
                columns: new[] { "application_id", "started_at" });

            migrationBuilder.CreateIndex(
                name: "ix_security_scans_organization_id_reference",
                table: "security_scans",
                columns: new[] { "organization_id", "reference" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_security_scopes_application_id",
                table: "security_scopes",
                column: "application_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_security_scopes_environment_id",
                table: "security_scopes",
                column: "environment_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "security_blocked_requests");

            migrationBuilder.DropTable(
                name: "security_findings");

            migrationBuilder.DropTable(
                name: "security_scopes");

            migrationBuilder.DropTable(
                name: "security_scans");
        }
    }
}
