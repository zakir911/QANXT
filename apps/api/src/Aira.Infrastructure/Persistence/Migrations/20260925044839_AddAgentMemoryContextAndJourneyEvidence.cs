using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentMemoryContextAndJourneyEvidence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "evidence",
                table: "journeys",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "application_contexts",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    critical_journeys = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: false),
                    high_risk_areas = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: false),
                    excluded_areas = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: false),
                    notes = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_application_contexts", x => x.id);
                    table.ForeignKey(
                        name: "fk_application_contexts_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "application_memories",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    subject = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    fact = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    provenance = table.Column<int>(type: "integer", nullable: false),
                    confidence = table.Column<int>(type: "integer", nullable: false),
                    last_confirmed_by_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    first_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    times_seen = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_application_memories", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_application_contexts_application_id",
                table: "application_contexts",
                column: "application_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_application_memories_application_id_kind_subject",
                table: "application_memories",
                columns: new[] { "application_id", "kind", "subject" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_application_memories_application_id_last_seen_at",
                table: "application_memories",
                columns: new[] { "application_id", "last_seen_at" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "application_contexts");

            migrationBuilder.DropTable(
                name: "application_memories");

            migrationBuilder.DropColumn(
                name: "evidence",
                table: "journeys");
        }
    }
}
