using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentDecisionsAndPolicy : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "actions_taken",
                table: "agent_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "allow_destructive_actions",
                table: "agent_runs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "allow_production",
                table: "agent_runs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "allow_security_testing",
                table: "agent_runs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "journeys_created",
                table: "agent_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "max_actions",
                table: "agent_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "max_new_journeys",
                table: "agent_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "max_parallel_workers",
                table: "agent_runs",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "require_approval_for_high_risk",
                table: "agent_runs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "agent_approvals",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_run_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tool = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    proposal = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    evidence_json = table.Column<string>(type: "jsonb", nullable: false),
                    risk = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    expected_impact = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    status = table.Column<int>(type: "integer", nullable: false),
                    decided_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    decided_by_email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true),
                    justification = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    decided_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_approvals", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_approvals_agent_runs_agent_run_id",
                        column: x => x.agent_run_id,
                        principalTable: "agent_runs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "agent_decisions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    agent_run_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sequence = table.Column<int>(type: "integer", nullable: false),
                    phase = table.Column<int>(type: "integer", nullable: false),
                    tool = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    summary = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    reason = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    evidence_json = table.Column<string>(type: "jsonb", nullable: false),
                    result = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    allowed = table.Column<bool>(type: "boolean", nullable: false),
                    denial = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    risk = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    ai_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    ai_cost_usd = table.Column<decimal>(type: "numeric(12,6)", precision: 12, scale: 6, nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_agent_decisions", x => x.id);
                    table.ForeignKey(
                        name: "fk_agent_decisions_agent_runs_agent_run_id",
                        column: x => x.agent_run_id,
                        principalTable: "agent_runs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_agent_approvals_agent_run_id_status",
                table: "agent_approvals",
                columns: new[] { "agent_run_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_agent_decisions_agent_run_id_sequence",
                table: "agent_decisions",
                columns: new[] { "agent_run_id", "sequence" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "agent_approvals");

            migrationBuilder.DropTable(
                name: "agent_decisions");

            migrationBuilder.DropColumn(
                name: "actions_taken",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "allow_destructive_actions",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "allow_production",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "allow_security_testing",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "journeys_created",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "max_actions",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "max_new_journeys",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "max_parallel_workers",
                table: "agent_runs");

            migrationBuilder.DropColumn(
                name: "require_approval_for_high_risk",
                table: "agent_runs");
        }
    }
}
