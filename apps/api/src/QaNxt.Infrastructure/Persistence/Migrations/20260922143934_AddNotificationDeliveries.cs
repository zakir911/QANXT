using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddNotificationDeliveries : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "notification_deliveries",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    integration_id = table.Column<Guid>(type: "uuid", nullable: false),
                    @event = table.Column<int>(name: "event", type: "integer", nullable: false),
                    channel = table.Column<int>(type: "integer", nullable: false),
                    test_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    delivered = table.Column<bool>(type: "boolean", nullable: false),
                    status_code = table.Column<int>(type: "integer", nullable: true),
                    detail = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    attempted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_notification_deliveries", x => x.id);
                    table.ForeignKey(
                        name: "fk_notification_deliveries_integrations_integration_id",
                        column: x => x.integration_id,
                        principalTable: "integrations",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_notification_deliveries_integration_id",
                table: "notification_deliveries",
                column: "integration_id");

            migrationBuilder.CreateIndex(
                name: "ix_notification_deliveries_project_id_attempted_at",
                table: "notification_deliveries",
                columns: new[] { "project_id", "attempted_at" });

            migrationBuilder.CreateIndex(
                name: "ix_notification_deliveries_test_run_id",
                table: "notification_deliveries",
                column: "test_run_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "notification_deliveries");
        }
    }
}
