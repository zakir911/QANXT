using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aira.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAgentDecisionActor : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "actor_user_id",
                table: "agent_decisions",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_agent_decisions_actor_user_id",
                table: "agent_decisions",
                column: "actor_user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_agent_decisions_actor_user_id",
                table: "agent_decisions");

            migrationBuilder.DropColumn(
                name: "actor_user_id",
                table: "agent_decisions");
        }
    }
}
