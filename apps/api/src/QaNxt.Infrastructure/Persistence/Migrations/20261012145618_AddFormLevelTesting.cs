using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddFormLevelTesting : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "application_form_id",
                table: "test_cases",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "automation_status",
                table: "test_cases",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "category",
                table: "test_cases",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "coverage_keys_json",
                table: "test_cases",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "evidence_requirements",
                table: "test_cases",
                type: "character varying(1000)",
                maxLength: 1000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "field_key",
                table: "test_cases",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "generation_key",
                table: "test_cases",
                type: "character varying(400)",
                maxLength: 400,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "lifecycle",
                table: "test_cases",
                type: "integer",
                nullable: false,
                // Every test that existed before the column did stays runnable: Active is 1.
                // Only the backfill uses this; the model sends a value on every insert.
                defaultValue: 1);

            migrationBuilder.AddColumn<Guid>(
                name: "source_defect_id",
                table: "test_cases",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "technique",
                table: "test_cases",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "test_data_json",
                table: "test_cases",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "defect_id",
                table: "failures",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "affected_test_count",
                table: "defects",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<Guid>(
                name: "application_form_id",
                table: "defects",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "application_id",
                table: "defects",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "category",
                table: "defects",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "first_seen_at",
                table: "defects",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "last_seen_at",
                table: "defects",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "occurrence_count",
                table: "defects",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<Guid>(
                name: "regression_test_case_id",
                table: "defects",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "signature",
                table: "defects",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "testing_config_json",
                table: "applications",
                type: "jsonb",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "application_forms",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_page_id = table.Column<Guid>(type: "uuid", nullable: false),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    form_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    name = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    route = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    page_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    action = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    has_form_element = table.Column<bool>(type: "boolean", nullable: false),
                    no_validate = table.Column<bool>(type: "boolean", nullable: false),
                    has_csrf_token = table.Column<bool>(type: "boolean", nullable: false),
                    is_multi_step = table.Column<bool>(type: "boolean", nullable: false),
                    group_count = table.Column<int>(type: "integer", nullable: false),
                    field_count = table.Column<int>(type: "integer", nullable: false),
                    required_field_count = table.Column<int>(type: "integer", nullable: false),
                    dependency_count = table.Column<int>(type: "integer", nullable: false),
                    model_json = table.Column<string>(type: "jsonb", nullable: false),
                    model_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    changed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    is_present = table.Column<bool>(type: "boolean", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_application_forms", x => x.id);
                    table.ForeignKey(
                        name: "fk_application_forms_application_pages_application_page_id",
                        column: x => x.application_page_id,
                        principalTable: "application_pages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "coverage_gaps",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_form_id = table.Column<Guid>(type: "uuid", nullable: true),
                    field_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    category = table.Column<int>(type: "integer", nullable: false),
                    missing = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    recommended_action = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_coverage_gaps", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "form_findings",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_form_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    code = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    field_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    message = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    severity = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_form_findings", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "human_verification_tasks",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: true),
                    application_form_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: true),
                    title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    category = table.Column<int>(type: "integer", nullable: false),
                    reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    steps = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    expected_result = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    comments = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    evidence_json = table.Column<string>(type: "jsonb", nullable: true),
                    assigned_to_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    completed_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    origin = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    generation_key = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_human_verification_tasks", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "test_case_versions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: false),
                    version = table.Column<int>(type: "integer", nullable: false),
                    snapshot_json = table.Column<string>(type: "jsonb", nullable: false),
                    change_summary = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    changed_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_case_versions", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_application_form_id",
                table: "test_cases",
                column: "application_form_id");

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_application_id_category",
                table: "test_cases",
                columns: new[] { "application_id", "category" });

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_project_id_generation_key",
                table: "test_cases",
                columns: new[] { "project_id", "generation_key" });

            migrationBuilder.CreateIndex(
                name: "ix_defects_project_id_signature",
                table: "defects",
                columns: new[] { "project_id", "signature" });

            migrationBuilder.CreateIndex(
                name: "ix_application_forms_application_id",
                table: "application_forms",
                column: "application_id");

            migrationBuilder.CreateIndex(
                name: "ix_application_forms_application_page_id_form_key",
                table: "application_forms",
                columns: new[] { "application_page_id", "form_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_coverage_gaps_application_form_id",
                table: "coverage_gaps",
                column: "application_form_id");

            migrationBuilder.CreateIndex(
                name: "ix_coverage_gaps_application_id",
                table: "coverage_gaps",
                column: "application_id");

            migrationBuilder.CreateIndex(
                name: "ix_form_findings_application_form_id",
                table: "form_findings",
                column: "application_form_id");

            migrationBuilder.CreateIndex(
                name: "ix_human_verification_tasks_application_form_id",
                table: "human_verification_tasks",
                column: "application_form_id");

            migrationBuilder.CreateIndex(
                name: "ix_human_verification_tasks_project_id_generation_key",
                table: "human_verification_tasks",
                columns: new[] { "project_id", "generation_key" });

            migrationBuilder.CreateIndex(
                name: "ix_human_verification_tasks_project_id_status",
                table: "human_verification_tasks",
                columns: new[] { "project_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_test_case_versions_test_case_id_version",
                table: "test_case_versions",
                columns: new[] { "test_case_id", "version" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "application_forms");

            migrationBuilder.DropTable(
                name: "coverage_gaps");

            migrationBuilder.DropTable(
                name: "form_findings");

            migrationBuilder.DropTable(
                name: "human_verification_tasks");

            migrationBuilder.DropTable(
                name: "test_case_versions");

            migrationBuilder.DropIndex(
                name: "ix_test_cases_application_form_id",
                table: "test_cases");

            migrationBuilder.DropIndex(
                name: "ix_test_cases_application_id_category",
                table: "test_cases");

            migrationBuilder.DropIndex(
                name: "ix_test_cases_project_id_generation_key",
                table: "test_cases");

            migrationBuilder.DropIndex(
                name: "ix_defects_project_id_signature",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "application_form_id",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "automation_status",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "category",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "coverage_keys_json",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "evidence_requirements",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "field_key",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "generation_key",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "lifecycle",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "source_defect_id",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "technique",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "test_data_json",
                table: "test_cases");

            migrationBuilder.DropColumn(
                name: "defect_id",
                table: "failures");

            migrationBuilder.DropColumn(
                name: "affected_test_count",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "application_form_id",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "application_id",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "category",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "first_seen_at",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "last_seen_at",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "occurrence_count",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "regression_test_case_id",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "signature",
                table: "defects");

            migrationBuilder.DropColumn(
                name: "testing_config_json",
                table: "applications");
        }
    }
}
