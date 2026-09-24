using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddSecurityScanSchedules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "application_id",
                table: "schedules",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "kind",
                table: "schedules",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateIndex(
                name: "ix_schedules_application_id",
                table: "schedules",
                column: "application_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_schedules_application_id",
                table: "schedules");

            migrationBuilder.DropColumn(
                name: "application_id",
                table: "schedules");

            migrationBuilder.DropColumn(
                name: "kind",
                table: "schedules");
        }
    }
}
