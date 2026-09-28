using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddScheduleRunnerFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "consecutive_failure_count",
                table: "schedules",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "disabled_reason",
                table: "schedules",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "include_tags",
                table: "schedules",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "last_run_id",
                table: "schedules",
                type: "uuid",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "consecutive_failure_count",
                table: "schedules");

            migrationBuilder.DropColumn(
                name: "disabled_reason",
                table: "schedules");

            migrationBuilder.DropColumn(
                name: "include_tags",
                table: "schedules");

            migrationBuilder.DropColumn(
                name: "last_run_id",
                table: "schedules");
        }
    }
}
