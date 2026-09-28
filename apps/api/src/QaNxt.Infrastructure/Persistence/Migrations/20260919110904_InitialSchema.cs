using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace QaNxt.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ai_requests",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: true),
                    user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    provider = table.Column<int>(type: "integer", nullable: false),
                    model = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    prompt_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    system_prompt_excerpt = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    user_prompt_excerpt = table.Column<string>(type: "character varying(16000)", maxLength: 16000, nullable: true),
                    response_schema_name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    prompt_tokens = table.Column<int>(type: "integer", nullable: false),
                    completion_tokens = table.Column<int>(type: "integer", nullable: false),
                    total_tokens = table.Column<int>(type: "integer", nullable: false),
                    latency_ms = table.Column<int>(type: "integer", nullable: false),
                    estimated_cost_usd = table.Column<decimal>(type: "numeric(12,6)", precision: 12, scale: 6, nullable: false),
                    from_cache = table.Column<bool>(type: "boolean", nullable: false),
                    error_message = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    correlation_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_ai_requests", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "audit_logs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: true),
                    user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    user_email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true),
                    action = table.Column<int>(type: "integer", nullable: false),
                    entity_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    entity_id = table.Column<Guid>(type: "uuid", nullable: true),
                    summary = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    changes_json = table.Column<string>(type: "jsonb", nullable: true),
                    ip_address = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    user_agent = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: true),
                    correlation_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    succeeded = table.Column<bool>(type: "boolean", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_audit_logs", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "console_events",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_action_id = table.Column<Guid>(type: "uuid", nullable: true),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    level = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    message = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    stack_trace = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: true),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_console_events", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "healing_events",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_step_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_action_id = table.Column<Guid>(type: "uuid", nullable: true),
                    original_locator_json = table.Column<string>(type: "jsonb", nullable: false),
                    healed_locator_json = table.Column<string>(type: "jsonb", nullable: false),
                    reason = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    confidence = table.Column<int>(type: "integer", nullable: false),
                    score_breakdown_json = table.Column<string>(type: "jsonb", nullable: true),
                    evidence_refs_json = table.Column<string>(type: "jsonb", nullable: true),
                    policy_at_time = table.Column<int>(type: "integer", nullable: false),
                    outcome = table.Column<int>(type: "integer", nullable: false),
                    outcome_verified = table.Column<bool>(type: "boolean", nullable: false),
                    produced_by_ai = table.Column<bool>(type: "boolean", nullable: false),
                    ai_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    reviewed_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    reviewed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    review_comment = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    applied_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    application_build_ref = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_healing_events", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "network_events",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_action_id = table.Column<Guid>(type: "uuid", nullable: true),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    resource_type = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    status_code = table.Column<int>(type: "integer", nullable: true),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    request_size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    response_size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    request_headers_json = table.Column<string>(type: "jsonb", nullable: true),
                    response_headers_json = table.Column<string>(type: "jsonb", nullable: true),
                    request_body_excerpt = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    response_body_excerpt = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    is_failed = table.Column<bool>(type: "boolean", nullable: false),
                    failure_text = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_network_events", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "organizations",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    slug = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    is_active = table.Column<bool>(type: "boolean", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    max_concurrent_executions = table.Column<int>(type: "integer", nullable: false),
                    monthly_ai_budget_usd = table.Column<decimal>(type: "numeric(12,2)", precision: 12, scale: 2, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_organizations", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "permissions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    description = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    category = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_permissions", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "roles",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    system_role = table.Column<int>(type: "integer", nullable: true),
                    is_built_in = table.Column<bool>(type: "boolean", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_roles", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "schedules",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_suite_id = table.Column<Guid>(type: "uuid", nullable: true),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    cron_expression = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    time_zone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    is_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    environment_id = table.Column<Guid>(type: "uuid", nullable: true),
                    browser = table.Column<int>(type: "integer", nullable: false),
                    last_run_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    next_run_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_schedules", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "test_data_sets",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    environment_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_data_sets", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "test_runs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_suite_id = table.Column<Guid>(type: "uuid", nullable: true),
                    environment_id = table.Column<Guid>(type: "uuid", nullable: true),
                    name = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    trigger = table.Column<int>(type: "integer", nullable: false),
                    browser = table.Column<int>(type: "integer", nullable: false),
                    headless = table.Column<bool>(type: "boolean", nullable: false),
                    parallelism = table.Column<int>(type: "integer", nullable: false),
                    max_retries = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    total_count = table.Column<int>(type: "integer", nullable: false),
                    passed_count = table.Column<int>(type: "integer", nullable: false),
                    failed_count = table.Column<int>(type: "integer", nullable: false),
                    skipped_count = table.Column<int>(type: "integer", nullable: false),
                    blocked_count = table.Column<int>(type: "integer", nullable: false),
                    healed_count = table.Column<int>(type: "integer", nullable: false),
                    flaky_count = table.Column<int>(type: "integer", nullable: false),
                    quality_gate_passed = table.Column<bool>(type: "boolean", nullable: true),
                    quality_gate_summary_json = table.Column<string>(type: "jsonb", nullable: true),
                    ci_provider = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    ci_build_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    ci_commit_sha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ci_branch = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    application_build_ref = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_runs", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "ai_responses",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    ai_request_id = table.Column<Guid>(type: "uuid", nullable: false),
                    raw_content = table.Column<string>(type: "character varying(200000)", maxLength: 200000, nullable: false),
                    structured_json = table.Column<string>(type: "jsonb", nullable: true),
                    schema_valid = table.Column<bool>(type: "boolean", nullable: false),
                    schema_errors = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    finish_reason = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_ai_responses", x => x.id);
                    table.ForeignKey(
                        name: "fk_ai_responses_ai_requests_ai_request_id",
                        column: x => x.ai_request_id,
                        principalTable: "ai_requests",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "projects",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    key = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    default_browser = table.Column<int>(type: "integer", nullable: false),
                    default_retries = table.Column<int>(type: "integer", nullable: false),
                    max_parallel_executions = table.Column<int>(type: "integer", nullable: false),
                    default_action_timeout_ms = table.Column<int>(type: "integer", nullable: false),
                    capture_video = table.Column<bool>(type: "boolean", nullable: false),
                    capture_trace = table.Column<bool>(type: "boolean", nullable: false),
                    capture_har = table.Column<bool>(type: "boolean", nullable: false),
                    healing_policy = table.Column<int>(type: "integer", nullable: false),
                    healing_confidence_threshold = table.Column<int>(type: "integer", nullable: false),
                    ai_provider = table.Column<int>(type: "integer", nullable: false),
                    ai_model = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    ai_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    allow_script_execution = table.Column<bool>(type: "boolean", nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_projects", x => x.id);
                    table.ForeignKey(
                        name: "fk_projects_organizations_organization_id",
                        column: x => x.organization_id,
                        principalTable: "organizations",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "users",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    normalized_email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    display_name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    password_hash = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    last_login_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    failed_login_attempts = table.Column<int>(type: "integer", nullable: false),
                    locked_until = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    security_stamp = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_users", x => x.id);
                    table.ForeignKey(
                        name: "fk_users_organizations_organization_id",
                        column: x => x.organization_id,
                        principalTable: "organizations",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "role_permissions",
                columns: table => new
                {
                    role_id = table.Column<Guid>(type: "uuid", nullable: false),
                    permission_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_role_permissions", x => new { x.role_id, x.permission_id });
                    table.ForeignKey(
                        name: "fk_role_permissions_permissions_permission_id",
                        column: x => x.permission_id,
                        principalTable: "permissions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_role_permissions_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "test_data_fields",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_data_set_id = table.Column<Guid>(type: "uuid", nullable: false),
                    key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    value = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    generator_json = table.Column<string>(type: "jsonb", nullable: true),
                    seed = table.Column<int>(type: "integer", nullable: true),
                    is_sensitive = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_data_fields", x => x.id);
                    table.ForeignKey(
                        name: "fk_test_data_fields_test_data_sets_test_data_set_id",
                        column: x => x.test_data_set_id,
                        principalTable: "test_data_sets",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "applications",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    base_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    allowed_domains = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    excluded_paths = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    max_crawl_depth = table.Column<int>(type: "integer", nullable: false),
                    max_pages = table.Column<int>(type: "integer", nullable: false),
                    max_actions = table.Column<int>(type: "integer", nullable: false),
                    exploration_timeout_seconds = table.Column<int>(type: "integer", nullable: false),
                    respect_robots_txt = table.Column<bool>(type: "boolean", nullable: false),
                    auth_strategy = table.Column<int>(type: "integer", nullable: false),
                    login_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    login_flow_json = table.Column<string>(type: "jsonb", nullable: true),
                    encrypted_credentials = table.Column<string>(type: "text", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_applications", x => x.id);
                    table.ForeignKey(
                        name: "fk_applications_projects_project_id",
                        column: x => x.project_id,
                        principalTable: "projects",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "environments",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    base_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    is_production = table.Column<bool>(type: "boolean", nullable: false),
                    allow_destructive_tests = table.Column<bool>(type: "boolean", nullable: false),
                    variables_json = table.Column<string>(type: "text", nullable: true),
                    encrypted_secrets_json = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_environments", x => x.id);
                    table.ForeignKey(
                        name: "fk_environments_projects_project_id",
                        column: x => x.project_id,
                        principalTable: "projects",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "integrations",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    is_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    settings_json = table.Column<string>(type: "jsonb", nullable: false),
                    encrypted_credentials = table.Column<string>(type: "text", nullable: true),
                    last_used_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_integrations", x => x.id);
                    table.ForeignKey(
                        name: "fk_integrations_projects_project_id",
                        column: x => x.project_id,
                        principalTable: "projects",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "quality_gate_rules",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    metric = table.Column<int>(type: "integer", nullable: false),
                    @operator = table.Column<int>(name: "operator", type: "integer", nullable: false),
                    threshold = table.Column<decimal>(type: "numeric(12,2)", precision: 12, scale: 2, nullable: false),
                    is_blocking = table.Column<bool>(type: "boolean", nullable: false),
                    is_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_quality_gate_rules", x => x.id);
                    table.ForeignKey(
                        name: "fk_quality_gate_rules_projects_project_id",
                        column: x => x.project_id,
                        principalTable: "projects",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "test_suites",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    tags = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    is_regression_suite = table.Column<bool>(type: "boolean", nullable: false),
                    owner_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_suites", x => x.id);
                    table.ForeignKey(
                        name: "fk_test_suites_projects_project_id",
                        column: x => x.project_id,
                        principalTable: "projects",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "project_members",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_project_members", x => x.id);
                    table.ForeignKey(
                        name: "fk_project_members_projects_project_id",
                        column: x => x.project_id,
                        principalTable: "projects",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_project_members_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_project_members_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "refresh_tokens",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_hash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    revoked_reason = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    replaced_by_token_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_by_ip = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    user_agent = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_refresh_tokens", x => x.id);
                    table.ForeignKey(
                        name: "fk_refresh_tokens_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_roles",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role_id = table.Column<Guid>(type: "uuid", nullable: false),
                    assigned_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    assigned_by_user_id = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_roles", x => new { x.user_id, x.role_id });
                    table.ForeignKey(
                        name: "fk_user_roles_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_user_roles_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "api_endpoints",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    method = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    url_template = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    sample_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    times_observed = table.Column<int>(type: "integer", nullable: false),
                    last_status_code = table.Column<int>(type: "integer", nullable: true),
                    average_duration_ms = table.Column<int>(type: "integer", nullable: false),
                    request_sample_json = table.Column<string>(type: "text", nullable: true),
                    response_sample_json = table.Column<string>(type: "text", nullable: true),
                    request_content_type = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    response_content_type = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    requires_authentication = table.Column<bool>(type: "boolean", nullable: false),
                    triggered_by_page_id = table.Column<Guid>(type: "uuid", nullable: true),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_api_endpoints", x => x.id);
                    table.ForeignKey(
                        name: "fk_api_endpoints_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "application_pages",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    normalized_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    route = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    title = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    depth = table.Column<int>(type: "integer", nullable: false),
                    parent_page_id = table.Column<Guid>(type: "uuid", nullable: true),
                    requires_authentication = table.Column<bool>(type: "boolean", nullable: false),
                    http_status = table.Column<int>(type: "integer", nullable: true),
                    load_time_ms = table.Column<int>(type: "integer", nullable: false),
                    element_count = table.Column<int>(type: "integer", nullable: false),
                    console_error_count = table.Column<int>(type: "integer", nullable: false),
                    screenshot_artifact_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    dom_artifact_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    accessibility_artifact_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    visible_text_excerpt = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_application_pages", x => x.id);
                    table.ForeignKey(
                        name: "fk_application_pages_application_pages_parent_page_id",
                        column: x => x.parent_page_id,
                        principalTable: "application_pages",
                        principalColumn: "id");
                    table.ForeignKey(
                        name: "fk_application_pages_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "discovery_runs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    max_depth = table.Column<int>(type: "integer", nullable: false),
                    max_pages = table.Column<int>(type: "integer", nullable: false),
                    timeout_seconds = table.Column<int>(type: "integer", nullable: false),
                    browser = table.Column<int>(type: "integer", nullable: false),
                    pages_discovered = table.Column<int>(type: "integer", nullable: false),
                    elements_discovered = table.Column<int>(type: "integer", nullable: false),
                    api_endpoints_discovered = table.Column<int>(type: "integer", nullable: false),
                    journeys_discovered = table.Column<int>(type: "integer", nullable: false),
                    console_error_count = table.Column<int>(type: "integer", nullable: false),
                    pages_blocked_by_policy = table.Column<int>(type: "integer", nullable: false),
                    error_message = table.Column<string>(type: "text", nullable: true),
                    progress_log = table.Column<string>(type: "text", nullable: true),
                    worker_id = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_discovery_runs", x => x.id);
                    table.ForeignKey(
                        name: "fk_discovery_runs_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "journeys",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    source = table.Column<int>(type: "integer", nullable: false),
                    risk = table.Column<int>(type: "integer", nullable: false),
                    risk_score = table.Column<int>(type: "integer", nullable: false),
                    risk_rationale = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    is_critical = table.Column<bool>(type: "boolean", nullable: false),
                    tags = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_journeys", x => x.id);
                    table.ForeignKey(
                        name: "fk_journeys_applications_application_id",
                        column: x => x.application_id,
                        principalTable: "applications",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "test_cases",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_suite_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: true),
                    journey_id = table.Column<Guid>(type: "uuid", nullable: true),
                    reference = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    name = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    objective = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    preconditions = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    expected_results = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    priority = table.Column<int>(type: "integer", nullable: false),
                    risk = table.Column<int>(type: "integer", nullable: false),
                    tags = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    source = table.Column<int>(type: "integer", nullable: false),
                    is_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    generated_by_ai_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    requirement_reference = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    test_data_set_id = table.Column<Guid>(type: "uuid", nullable: true),
                    version = table.Column<int>(type: "integer", nullable: false),
                    execution_count = table.Column<int>(type: "integer", nullable: false),
                    pass_count = table.Column<int>(type: "integer", nullable: false),
                    fail_count = table.Column<int>(type: "integer", nullable: false),
                    heal_count = table.Column<int>(type: "integer", nullable: false),
                    flakiness_score = table.Column<int>(type: "integer", nullable: false),
                    last_executed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    last_status = table.Column<int>(type: "integer", nullable: true),
                    average_duration_ms = table.Column<int>(type: "integer", nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_cases", x => x.id);
                    table.ForeignKey(
                        name: "fk_test_cases_test_data_sets_test_data_set_id",
                        column: x => x.test_data_set_id,
                        principalTable: "test_data_sets",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "fk_test_cases_test_suites_test_suite_id",
                        column: x => x.test_suite_id,
                        principalTable: "test_suites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "application_elements",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_page_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    tag_name = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    aria_role = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    accessible_name = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    text = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    label = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    placeholder = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    test_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    element_id = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    type = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    value = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    css_selector = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    x_path = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    dom_path = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    parent_signature = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    neighbour_text = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    bounding_x = table.Column<int>(type: "integer", nullable: false),
                    bounding_y = table.Column<int>(type: "integer", nullable: false),
                    bounding_width = table.Column<int>(type: "integer", nullable: false),
                    bounding_height = table.Column<int>(type: "integer", nullable: false),
                    is_visible = table.Column<bool>(type: "boolean", nullable: false),
                    is_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    is_required = table.Column<bool>(type: "boolean", nullable: false),
                    attributes_json = table.Column<string>(type: "jsonb", nullable: true),
                    preferred_locator_json = table.Column<string>(type: "jsonb", nullable: true),
                    stability_score = table.Column<int>(type: "integer", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_application_elements", x => x.id);
                    table.ForeignKey(
                        name: "fk_application_elements_application_pages_application_page_id",
                        column: x => x.application_page_id,
                        principalTable: "application_pages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "page_transitions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    from_page_id = table.Column<Guid>(type: "uuid", nullable: false),
                    to_page_id = table.Column<Guid>(type: "uuid", nullable: false),
                    trigger_element_id = table.Column<Guid>(type: "uuid", nullable: true),
                    action = table.Column<int>(type: "integer", nullable: false),
                    times_observed = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_page_transitions", x => x.id);
                    table.ForeignKey(
                        name: "fk_page_transitions_application_pages_from_page_id",
                        column: x => x.from_page_id,
                        principalTable: "application_pages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_page_transitions_application_pages_to_page_id",
                        column: x => x.to_page_id,
                        principalTable: "application_pages",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "journey_steps",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    journey_id = table.Column<Guid>(type: "uuid", nullable: false),
                    order = table.Column<int>(type: "integer", nullable: false),
                    action = table.Column<int>(type: "integer", nullable: false),
                    description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    application_page_id = table.Column<Guid>(type: "uuid", nullable: true),
                    application_element_id = table.Column<Guid>(type: "uuid", nullable: true),
                    target_json = table.Column<string>(type: "jsonb", nullable: true),
                    value = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    annotation = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    expected_result = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_journey_steps", x => x.id);
                    table.ForeignKey(
                        name: "fk_journey_steps_journeys_journey_id",
                        column: x => x.journey_id,
                        principalTable: "journeys",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "test_executions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_run_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_case_version = table.Column<int>(type: "integer", nullable: false),
                    attempt = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    browser = table.Column<int>(type: "integer", nullable: false),
                    browser_version = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    worker_id = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    correlation_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    steps_total = table.Column<int>(type: "integer", nullable: false),
                    steps_passed = table.Column<int>(type: "integer", nullable: false),
                    steps_failed = table.Column<int>(type: "integer", nullable: false),
                    steps_healed = table.Column<int>(type: "integer", nullable: false),
                    console_error_count = table.Column<int>(type: "integer", nullable: false),
                    network_error_count = table.Column<int>(type: "integer", nullable: false),
                    error_message = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    error_stack = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_executions", x => x.id);
                    table.ForeignKey(
                        name: "fk_test_executions_test_cases_test_case_id",
                        column: x => x.test_case_id,
                        principalTable: "test_cases",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_test_executions_test_runs_test_run_id",
                        column: x => x.test_run_id,
                        principalTable: "test_runs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "test_steps",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: false),
                    order = table.Column<int>(type: "integer", nullable: false),
                    description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    action = table.Column<int>(type: "integer", nullable: false),
                    target_json = table.Column<string>(type: "jsonb", nullable: true),
                    value = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    timeout_ms = table.Column<int>(type: "integer", nullable: true),
                    is_critical = table.Column<bool>(type: "boolean", nullable: false),
                    continue_on_failure = table.Column<bool>(type: "boolean", nullable: false),
                    healed_from_step_version_id = table.Column<Guid>(type: "uuid", nullable: true),
                    heal_count = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_steps", x => x.id);
                    table.ForeignKey(
                        name: "fk_test_steps_test_cases_test_case_id",
                        column: x => x.test_case_id,
                        principalTable: "test_cases",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "artifacts",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_action_id = table.Column<Guid>(type: "uuid", nullable: true),
                    discovery_run_id = table.Column<Guid>(type: "uuid", nullable: true),
                    application_page_id = table.Column<Guid>(type: "uuid", nullable: true),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    name = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    storage_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    content_type = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    is_masked = table.Column<bool>(type: "boolean", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    metadata_json = table.Column<string>(type: "jsonb", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_artifacts", x => x.id);
                    table.ForeignKey(
                        name: "fk_artifacts_test_executions_test_execution_id",
                        column: x => x.test_execution_id,
                        principalTable: "test_executions",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "failures",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_action_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: false),
                    category = table.Column<int>(type: "integer", nullable: false),
                    category_confidence = table.Column<int>(type: "integer", nullable: false),
                    raw_message = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    raw_stack = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: true),
                    signature = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    is_new_failure = table.Column<bool>(type: "boolean", nullable: false),
                    is_regression = table.Column<bool>(type: "boolean", nullable: false),
                    occurrence_count = table.Column<int>(type: "integer", nullable: false),
                    first_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_failures", x => x.id);
                    table.ForeignKey(
                        name: "fk_failures_test_executions_test_execution_id",
                        column: x => x.test_execution_id,
                        principalTable: "test_executions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "test_actions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_step_id = table.Column<Guid>(type: "uuid", nullable: true),
                    order = table.Column<int>(type: "integer", nullable: false),
                    action = table.Column<int>(type: "integer", nullable: false),
                    description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    locator_used_json = table.Column<string>(type: "jsonb", nullable: true),
                    locator_alternatives_json = table.Column<string>(type: "jsonb", nullable: true),
                    masked_value = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    was_healed = table.Column<bool>(type: "boolean", nullable: false),
                    healing_confidence = table.Column<int>(type: "integer", nullable: true),
                    error_message = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    before_screenshot_id = table.Column<Guid>(type: "uuid", nullable: true),
                    after_screenshot_id = table.Column<Guid>(type: "uuid", nullable: true),
                    ai_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_test_actions", x => x.id);
                    table.ForeignKey(
                        name: "fk_test_actions_test_executions_test_execution_id",
                        column: x => x.test_execution_id,
                        principalTable: "test_executions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "assertions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_step_id = table.Column<Guid>(type: "uuid", nullable: false),
                    type = table.Column<int>(type: "integer", nullable: false),
                    target_json = table.Column<string>(type: "jsonb", nullable: true),
                    expected_value = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    attribute_name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    negate = table.Column<bool>(type: "boolean", nullable: false),
                    description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    is_soft = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_assertions", x => x.id);
                    table.ForeignKey(
                        name: "fk_assertions_test_steps_test_step_id",
                        column: x => x.test_step_id,
                        principalTable: "test_steps",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "locator_candidates",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    test_step_id = table.Column<Guid>(type: "uuid", nullable: true),
                    healing_event_id = table.Column<Guid>(type: "uuid", nullable: true),
                    application_element_id = table.Column<Guid>(type: "uuid", nullable: true),
                    strategy = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    value = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    accessible_name = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    descriptor_json = table.Column<string>(type: "jsonb", nullable: false),
                    score = table.Column<int>(type: "integer", nullable: false),
                    score_breakdown_json = table.Column<string>(type: "jsonb", nullable: true),
                    stability_score = table.Column<int>(type: "integer", nullable: false),
                    rank = table.Column<int>(type: "integer", nullable: false),
                    is_primary = table.Column<bool>(type: "boolean", nullable: false),
                    verified_in_execution = table.Column<bool>(type: "boolean", nullable: false),
                    times_used = table.Column<int>(type: "integer", nullable: false),
                    times_failed = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_locator_candidates", x => x.id);
                    table.ForeignKey(
                        name: "fk_locator_candidates_test_steps_test_step_id",
                        column: x => x.test_step_id,
                        principalTable: "test_steps",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "defects",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    failure_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_case_id = table.Column<Guid>(type: "uuid", nullable: true),
                    test_execution_id = table.Column<Guid>(type: "uuid", nullable: true),
                    title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    description = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    steps_to_reproduce = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    expected_behaviour = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    actual_behaviour = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    severity = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    confidence = table.Column<int>(type: "integer", nullable: false),
                    proposed_by_ai = table.Column<bool>(type: "boolean", nullable: false),
                    ai_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    evidence_refs_json = table.Column<string>(type: "jsonb", nullable: true),
                    external_key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    external_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    assigned_to_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    updated_by_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_defects", x => x.id);
                    table.ForeignKey(
                        name: "fk_defects_failures_failure_id",
                        column: x => x.failure_id,
                        principalTable: "failures",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "failure_analyses",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    organization_id = table.Column<Guid>(type: "uuid", nullable: false),
                    failure_id = table.Column<Guid>(type: "uuid", nullable: false),
                    summary = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    likely_cause = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    evidence = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    suggested_action = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    category = table.Column<int>(type: "integer", nullable: false),
                    confidence = table.Column<int>(type: "integer", nullable: false),
                    is_likely_application_defect = table.Column<bool>(type: "boolean", nullable: false),
                    is_healable = table.Column<bool>(type: "boolean", nullable: false),
                    evidence_refs_json = table.Column<string>(type: "jsonb", nullable: true),
                    produced_by_ai = table.Column<bool>(type: "boolean", nullable: false),
                    ai_request_id = table.Column<Guid>(type: "uuid", nullable: true),
                    provider = table.Column<int>(type: "integer", nullable: true),
                    model = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_failure_analyses", x => x.id);
                    table.ForeignKey(
                        name: "fk_failure_analyses_failures_failure_id",
                        column: x => x.failure_id,
                        principalTable: "failures",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_ai_requests_organization_id_created_at",
                table: "ai_requests",
                columns: new[] { "organization_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_ai_requests_organization_id_prompt_hash",
                table: "ai_requests",
                columns: new[] { "organization_id", "prompt_hash" });

            migrationBuilder.CreateIndex(
                name: "ix_ai_responses_ai_request_id",
                table: "ai_responses",
                column: "ai_request_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_api_endpoints_application_id_method_url_template",
                table: "api_endpoints",
                columns: new[] { "application_id", "method", "url_template" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_application_elements_application_page_id",
                table: "application_elements",
                column: "application_page_id");

            migrationBuilder.CreateIndex(
                name: "ix_application_elements_application_page_id_aria_role_accessib~",
                table: "application_elements",
                columns: new[] { "application_page_id", "aria_role", "accessible_name" });

            migrationBuilder.CreateIndex(
                name: "ix_application_elements_test_id",
                table: "application_elements",
                column: "test_id");

            migrationBuilder.CreateIndex(
                name: "ix_application_pages_application_id_normalized_url",
                table: "application_pages",
                columns: new[] { "application_id", "normalized_url" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_application_pages_parent_page_id",
                table: "application_pages",
                column: "parent_page_id");

            migrationBuilder.CreateIndex(
                name: "ix_applications_project_id",
                table: "applications",
                column: "project_id");

            migrationBuilder.CreateIndex(
                name: "ix_artifacts_discovery_run_id",
                table: "artifacts",
                column: "discovery_run_id");

            migrationBuilder.CreateIndex(
                name: "ix_artifacts_expires_at",
                table: "artifacts",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_artifacts_test_action_id",
                table: "artifacts",
                column: "test_action_id");

            migrationBuilder.CreateIndex(
                name: "ix_artifacts_test_execution_id",
                table: "artifacts",
                column: "test_execution_id");

            migrationBuilder.CreateIndex(
                name: "ix_assertions_test_step_id",
                table: "assertions",
                column: "test_step_id");

            migrationBuilder.CreateIndex(
                name: "ix_audit_logs_action",
                table: "audit_logs",
                column: "action");

            migrationBuilder.CreateIndex(
                name: "ix_audit_logs_entity_type_entity_id",
                table: "audit_logs",
                columns: new[] { "entity_type", "entity_id" });

            migrationBuilder.CreateIndex(
                name: "ix_audit_logs_organization_id_occurred_at",
                table: "audit_logs",
                columns: new[] { "organization_id", "occurred_at" });

            migrationBuilder.CreateIndex(
                name: "ix_console_events_discovery_run_id",
                table: "console_events",
                column: "discovery_run_id");

            migrationBuilder.CreateIndex(
                name: "ix_console_events_test_execution_id_level",
                table: "console_events",
                columns: new[] { "test_execution_id", "level" });

            migrationBuilder.CreateIndex(
                name: "ix_defects_failure_id",
                table: "defects",
                column: "failure_id");

            migrationBuilder.CreateIndex(
                name: "ix_defects_project_id_status_severity",
                table: "defects",
                columns: new[] { "project_id", "status", "severity" });

            migrationBuilder.CreateIndex(
                name: "ix_discovery_runs_application_id_created_at",
                table: "discovery_runs",
                columns: new[] { "application_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_discovery_runs_status",
                table: "discovery_runs",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_environments_project_id_name",
                table: "environments",
                columns: new[] { "project_id", "name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_failure_analyses_failure_id",
                table: "failure_analyses",
                column: "failure_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_failures_project_id_category_last_seen_at",
                table: "failures",
                columns: new[] { "project_id", "category", "last_seen_at" });

            migrationBuilder.CreateIndex(
                name: "ix_failures_project_id_signature",
                table: "failures",
                columns: new[] { "project_id", "signature" });

            migrationBuilder.CreateIndex(
                name: "ix_failures_test_execution_id",
                table: "failures",
                column: "test_execution_id");

            migrationBuilder.CreateIndex(
                name: "ix_healing_events_project_id_outcome_occurred_at",
                table: "healing_events",
                columns: new[] { "project_id", "outcome", "occurred_at" });

            migrationBuilder.CreateIndex(
                name: "ix_healing_events_test_step_id",
                table: "healing_events",
                column: "test_step_id");

            migrationBuilder.CreateIndex(
                name: "ix_integrations_project_id_kind",
                table: "integrations",
                columns: new[] { "project_id", "kind" });

            migrationBuilder.CreateIndex(
                name: "ix_journey_steps_journey_id_order",
                table: "journey_steps",
                columns: new[] { "journey_id", "order" });

            migrationBuilder.CreateIndex(
                name: "ix_journeys_application_id_risk_score",
                table: "journeys",
                columns: new[] { "application_id", "risk_score" });

            migrationBuilder.CreateIndex(
                name: "ix_locator_candidates_healing_event_id",
                table: "locator_candidates",
                column: "healing_event_id");

            migrationBuilder.CreateIndex(
                name: "ix_locator_candidates_test_step_id_rank",
                table: "locator_candidates",
                columns: new[] { "test_step_id", "rank" });

            migrationBuilder.CreateIndex(
                name: "ix_network_events_discovery_run_id",
                table: "network_events",
                column: "discovery_run_id");

            migrationBuilder.CreateIndex(
                name: "ix_network_events_test_execution_id",
                table: "network_events",
                column: "test_execution_id");

            migrationBuilder.CreateIndex(
                name: "ix_organizations_slug",
                table: "organizations",
                column: "slug",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_page_transitions_from_page_id_to_page_id_action",
                table: "page_transitions",
                columns: new[] { "from_page_id", "to_page_id", "action" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_page_transitions_to_page_id",
                table: "page_transitions",
                column: "to_page_id");

            migrationBuilder.CreateIndex(
                name: "ix_permissions_name",
                table: "permissions",
                column: "name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_project_members_project_id_user_id",
                table: "project_members",
                columns: new[] { "project_id", "user_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_project_members_role_id",
                table: "project_members",
                column: "role_id");

            migrationBuilder.CreateIndex(
                name: "ix_project_members_user_id",
                table: "project_members",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_projects_organization_id_key",
                table: "projects",
                columns: new[] { "organization_id", "key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_quality_gate_rules_project_id",
                table: "quality_gate_rules",
                column: "project_id");

            migrationBuilder.CreateIndex(
                name: "ix_refresh_tokens_token_hash",
                table: "refresh_tokens",
                column: "token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_refresh_tokens_user_id_expires_at",
                table: "refresh_tokens",
                columns: new[] { "user_id", "expires_at" });

            migrationBuilder.CreateIndex(
                name: "ix_role_permissions_permission_id",
                table: "role_permissions",
                column: "permission_id");

            migrationBuilder.CreateIndex(
                name: "ix_roles_organization_id_name",
                table: "roles",
                columns: new[] { "organization_id", "name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_schedules_is_enabled_next_run_at",
                table: "schedules",
                columns: new[] { "is_enabled", "next_run_at" });

            migrationBuilder.CreateIndex(
                name: "ix_test_actions_test_execution_id_order",
                table: "test_actions",
                columns: new[] { "test_execution_id", "order" });

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_project_id_last_status_last_executed_at",
                table: "test_cases",
                columns: new[] { "project_id", "last_status", "last_executed_at" });

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_project_id_reference",
                table: "test_cases",
                columns: new[] { "project_id", "reference" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_test_data_set_id",
                table: "test_cases",
                column: "test_data_set_id");

            migrationBuilder.CreateIndex(
                name: "ix_test_cases_test_suite_id",
                table: "test_cases",
                column: "test_suite_id");

            migrationBuilder.CreateIndex(
                name: "ix_test_data_fields_test_data_set_id_key",
                table: "test_data_fields",
                columns: new[] { "test_data_set_id", "key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_test_data_sets_project_id_name",
                table: "test_data_sets",
                columns: new[] { "project_id", "name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_test_executions_correlation_id",
                table: "test_executions",
                column: "correlation_id");

            migrationBuilder.CreateIndex(
                name: "ix_test_executions_test_case_id_created_at",
                table: "test_executions",
                columns: new[] { "test_case_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_test_executions_test_run_id_status",
                table: "test_executions",
                columns: new[] { "test_run_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_test_runs_project_id_created_at",
                table: "test_runs",
                columns: new[] { "project_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_test_runs_status",
                table: "test_runs",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_test_steps_test_case_id_order",
                table: "test_steps",
                columns: new[] { "test_case_id", "order" });

            migrationBuilder.CreateIndex(
                name: "ix_test_suites_project_id",
                table: "test_suites",
                column: "project_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_roles_role_id",
                table: "user_roles",
                column: "role_id");

            migrationBuilder.CreateIndex(
                name: "ix_users_organization_id_normalized_email",
                table: "users",
                columns: new[] { "organization_id", "normalized_email" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ai_responses");

            migrationBuilder.DropTable(
                name: "api_endpoints");

            migrationBuilder.DropTable(
                name: "application_elements");

            migrationBuilder.DropTable(
                name: "artifacts");

            migrationBuilder.DropTable(
                name: "assertions");

            migrationBuilder.DropTable(
                name: "audit_logs");

            migrationBuilder.DropTable(
                name: "console_events");

            migrationBuilder.DropTable(
                name: "defects");

            migrationBuilder.DropTable(
                name: "discovery_runs");

            migrationBuilder.DropTable(
                name: "environments");

            migrationBuilder.DropTable(
                name: "failure_analyses");

            migrationBuilder.DropTable(
                name: "healing_events");

            migrationBuilder.DropTable(
                name: "integrations");

            migrationBuilder.DropTable(
                name: "journey_steps");

            migrationBuilder.DropTable(
                name: "locator_candidates");

            migrationBuilder.DropTable(
                name: "network_events");

            migrationBuilder.DropTable(
                name: "page_transitions");

            migrationBuilder.DropTable(
                name: "project_members");

            migrationBuilder.DropTable(
                name: "quality_gate_rules");

            migrationBuilder.DropTable(
                name: "refresh_tokens");

            migrationBuilder.DropTable(
                name: "role_permissions");

            migrationBuilder.DropTable(
                name: "schedules");

            migrationBuilder.DropTable(
                name: "test_actions");

            migrationBuilder.DropTable(
                name: "test_data_fields");

            migrationBuilder.DropTable(
                name: "user_roles");

            migrationBuilder.DropTable(
                name: "ai_requests");

            migrationBuilder.DropTable(
                name: "failures");

            migrationBuilder.DropTable(
                name: "journeys");

            migrationBuilder.DropTable(
                name: "test_steps");

            migrationBuilder.DropTable(
                name: "application_pages");

            migrationBuilder.DropTable(
                name: "permissions");

            migrationBuilder.DropTable(
                name: "roles");

            migrationBuilder.DropTable(
                name: "users");

            migrationBuilder.DropTable(
                name: "test_executions");

            migrationBuilder.DropTable(
                name: "applications");

            migrationBuilder.DropTable(
                name: "test_cases");

            migrationBuilder.DropTable(
                name: "test_runs");

            migrationBuilder.DropTable(
                name: "test_data_sets");

            migrationBuilder.DropTable(
                name: "test_suites");

            migrationBuilder.DropTable(
                name: "projects");

            migrationBuilder.DropTable(
                name: "organizations");
        }
    }
}
