using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentRuns : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "agent_runs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    objective = table.Column<string>(type: "text", nullable: true),
                    status = table.Column<int>(type: "integer", nullable: false),
                    phase = table.Column<int>(type: "integer", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    explore_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    max_pages = table.Column<int>(type: "integer", nullable: false),
                    max_depth = table.Column<int>(type: "integer", nullable: false),
                    max_targets = table.Column<int>(type: "integer", nullable: false),
                    max_generated_tests = table.Column<int>(type: "integer", nullable: false),
                    time_budget_seconds = table.Column<int>(type: "integer", nullable: false),
                    max_ai_cost_usd = table.Column<decimal>(type: "numeric", nullable: false),
                    execute_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_suite_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    pages_considered = table.Column<int>(type: "integer", nullable: false),
                    areas_assessed = table.Column<int>(type: "integer", nullable: false),
                    tests_generated = table.Column<int>(type: "integer", nullable: false),
                    tests_executed = table.Column<int>(type: "integer", nullable: false),
                    failures_investigated = table.Column<int>(type: "integer", nullable: false),
                    proposals_made = table.Column<int>(type: "integer", nullable: false),
                    ai_cost_usd = table.Column<decimal>(type: "numeric", nullable: false),
                    stop_reason = table.Column<string>(type: "text", nullable: true),
                    error_message = table.Column<string>(type: "text", nullable: true),
                    summary = table.Column<string>(type: "text", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_runs", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_runs_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "agent_findings",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_run_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    severity = table.Column<int>(type: "integer", nullable: false),
                    title = table.Column<string>(type: "text", nullable: false),
                    detail = table.Column<string>(type: "text", nullable: false),
                    recommendation = table.Column<string>(type: "text", nullable: true),
                    confidence = table.Column<int>(type: "integer", nullable: false),
                    route = table.Column<string>(type: "text", nullable: true),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: true),
                    failure_id = table.Column<Guid>(type: "uuid", nullable: true),
                    is_ai_generated = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_findings", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_findings_agent_runs_agent_run_id",
                        column: x => x.agent_run_id,
                        principalTable: "agent_runs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "agent_steps",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_run_id = table.Column<Guid>(type: "uuid", nullable: false),
                    order = table.Column<int>(type: "integer", nullable: false),
                    phase = table.Column<int>(type: "integer", nullable: false),
                    succeeded = table.Column<bool>(type: "boolean", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false),
                    rationale = table.Column<string>(type: "text", nullable: true),
                    detail = table.Column<string>(type: "text", nullable: true),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_steps", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_steps_agent_runs_agent_run_id",
                        column: x => x.agent_run_id,
                        principalTable: "agent_runs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_agent_findings_agent_run_id",
                table: "agent_findings",
                column: "agent_run_id");

            migrationBuilder.CreateIndex(
                name: "ix_agent_runs_application_id",
                table: "agent_runs",
                column: "application_id");

            migrationBuilder.CreateIndex(
                name: "ix_agent_steps_agent_run_id",
                table: "agent_steps",
                column: "agent_run_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "agent_findings");

            migrationBuilder.DropTable(
                name: "agent_steps");

            migrationBuilder.DropTable(
                name: "agent_runs");
        }
    }
}
