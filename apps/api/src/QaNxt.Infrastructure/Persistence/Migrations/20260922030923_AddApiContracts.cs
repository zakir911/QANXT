using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddApiContracts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "contract_breaking_change_count",
                table: "test_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "contract_checked_at",
                table: "test_runs",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "contract_potentially_breaking_change_count",
                table: "test_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "api_contracts",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    api_endpoint_id = table.Column<Guid>(type: "uuid", nullable: true),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    url_template = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    status_code = table.Column<int>(type: "integer", nullable: true),
                    response_schema_json = table.Column<string>(type: "jsonb", nullable: false),
                    request_schema_json = table.Column<string>(type: "jsonb", nullable: true),
                    response_content_type = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    source_sample_sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    source = table.Column<int>(type: "integer", nullable: false),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    version = table.Column<int>(type: "integer", nullable: false),
                    is_baseline = table.Column<bool>(type: "boolean", nullable: false),
                    accepted_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    accepted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    note = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_api_contracts", x => x.id);
                    table.ForeignKey(
                        name: "fk_api_contracts_api_endpoints_api_endpoint_id",
                        column: x => x.api_endpoint_id,
                        principalTable: "api_endpoints",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "fk_api_contracts_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "api_contract_changes",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    api_endpoint_id = table.Column<Guid>(type: "uuid", nullable: true),
                    baseline_contract_id = table.Column<Guid>(type: "uuid", nullable: false),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    url_template = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    path = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    baseline_type = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    observed_type = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    test_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    is_acknowledged = table.Column<bool>(type: "boolean", nullable: false),
                    acknowledged_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    acknowledged_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    acknowledgement_note = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    detected_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_api_contract_changes", x => x.id);
                    table.ForeignKey(
                        name: "fk_api_contract_changes_api_contracts_baseline_contract_id",
                        column: x => x.baseline_contract_id,
                        principalTable: "api_contracts",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_api_contract_changes_application_id_detected_at",
                table: "api_contract_changes",
                columns: new[] { "application_id", "detected_at" });

            migrationBuilder.CreateIndex(
                name: "ix_api_contract_changes_baseline_contract_id",
                table: "api_contract_changes",
                column: "baseline_contract_id");

            migrationBuilder.CreateIndex(
                name: "ix_api_contract_changes_test_run_id_kind",
                table: "api_contract_changes",
                columns: new[] { "test_run_id", "kind" });

            migrationBuilder.CreateIndex(
                name: "ix_api_contracts_api_endpoint_id",
                table: "api_contracts",
                column: "api_endpoint_id");

            migrationBuilder.CreateIndex(
                name: "ix_api_contracts_application_id_method_url_template_is_baseline",
                table: "api_contracts",
                columns: new[] { "application_id", "method", "url_template", "is_baseline" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "api_contract_changes");

            migrationBuilder.DropTable(
                name: "api_contracts");

            migrationBuilder.DropColumn(
                name: "contract_breaking_change_count",
                table: "test_runs");

            migrationBuilder.DropColumn(
                name: "contract_checked_at",
                table: "test_runs");

            migrationBuilder.DropColumn(
                name: "contract_potentially_breaking_change_count",
                table: "test_runs");
        }
    }
}
