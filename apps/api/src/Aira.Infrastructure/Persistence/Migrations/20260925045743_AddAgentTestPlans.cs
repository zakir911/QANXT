using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentTestPlans : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "agent_test_plans",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_run_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    objective = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    pages_discovered = table.Column<int>(type: "integer", nullable: false),
                    endpoints_discovered = table.Column<int>(type: "integer", nullable: false),
                    journeys_known = table.Column<int>(type: "integer", nullable: false),
                    roles_known = table.Column<int>(type: "integer", nullable: false),
                    summary = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    not_covered = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    decided_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    decided_by_email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true),
                    decided_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    decision_note = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_test_plans", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_test_plans_agent_runs_agent_run_id",
                        column: x => x.agent_run_id,
                        principalTable: "agent_runs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "agent_test_plan_items",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_test_plan_id = table.Column<Guid>(type: "uuid", nullable: false),
                    category = table.Column<int>(type: "integer", nullable: false),
                    test_count = table.Column<int>(type: "integer", nullable: false),
                    to_generate = table.Column<int>(type: "integer", nullable: false),
                    why = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    risk = table.Column<int>(type: "integer", nullable: false),
                    coverage = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    estimated_seconds = table.Column<int>(type: "integer", nullable: false),
                    estimate_from_history = table.Column<bool>(type: "boolean", nullable: false),
                    potential_impact = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    included = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_test_plan_items", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_test_plan_items_agent_test_plans_agent_test_plan_id",
                        column: x => x.agent_test_plan_id,
                        principalTable: "agent_test_plans",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_agent_test_plan_items_agent_test_plan_id_category",
                table: "agent_test_plan_items",
                columns: new[] { "agent_test_plan_id", "category" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_agent_test_plans_agent_run_id",
                table: "agent_test_plans",
                column: "agent_run_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "agent_test_plan_items");

            migrationBuilder.DropTable(
                name: "agent_test_plans");
        }
    }
}
