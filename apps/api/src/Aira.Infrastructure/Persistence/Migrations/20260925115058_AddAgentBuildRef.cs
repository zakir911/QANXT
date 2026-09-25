using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentBuildRef : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "application_build_ref",
                table: "agent_runs",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "application_build_ref",
                table: "agent_runs");
        }
    }
}
