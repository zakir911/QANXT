using QaNxt.Application.Agent;
using QaNxt.Application.Ai;
using QaNxt.Application.Audit;
using QaNxt.Application.Applications;
using QaNxt.Application.Dashboard;
using QaNxt.Application.Diagnosis;
using QaNxt.Application.Discovery;
using QaNxt.Application.Identity;
using QaNxt.Application.Journeys;
using QaNxt.Application.Quality;
using QaNxt.Application.Notifications;
using QaNxt.Application.Scheduling;
using QaNxt.Application.Testing;
using QaNxt.Application.Projects;
using QaNxt.Application.Security;
using Microsoft.Extensions.DependencyInjection;

namespace QaNxt.Application;

public static class DependencyInjection
{
    /// <summary>Registers the use-case services. They are scoped because they depend on the
    /// request-scoped DbContext, tenant context and principal.</summary>
    public static IServiceCollection AddQaNxtApplicationServices(this IServiceCollection services)
    {
        services.AddScoped<IAuthService, AuthService>();
        services.AddScoped<IProjectService, ProjectService>();
        services.AddScoped<IEnvironmentService, EnvironmentService>();
        services.AddScoped<IApplicationService, ApplicationService>();
        services.AddScoped<IDiscoveryService, DiscoveryService>();
        services.AddScoped<IDiscoveryIngestService, DiscoveryIngestService>();
        services.AddScoped<ITestGenerationService, TestGenerationService>();
        services.AddScoped<IApiTestService, ApiTestService>();
        services.AddScoped<IApiContractService, ApiContractService>();
        services.AddScoped<ITestRunService, TestRunService>();
        services.AddScoped<IExecutionIngestService, ExecutionIngestService>();
        services.AddScoped<IFailureAnalysisService, FailureAnalysisService>();
        services.AddScoped<IHealingService, HealingService>();
        services.AddScoped<IJourneyImportService, JourneyImportService>();
        services.AddScoped<IQualityGateEvaluator, QualityGateEvaluator>();
        services.AddScoped<IQualityGateService, QualityGateService>();
        services.AddScoped<IRegressionSelectionService, RegressionSelectionService>();
        services.AddScoped<IScheduleService, ScheduleService>();
        services.AddScoped<INotificationService, NotificationService>();
        services.AddScoped<ITestDataService, TestDataService>();
        services.AddScoped<Security.ISecurityScanService, Security.SecurityScanService>();
        services.AddScoped<Security.ISecurityTrendService, Security.SecurityTrendService>();
        services.AddScoped<Security.ISecuritySurfaceService, Security.SecuritySurfaceService>();
        services.AddScoped<Security.ISecurityImpactService, Security.SecurityImpactService>();
        services.AddScoped<Security.ISecurityReleaseService, Security.SecurityReleaseService>();
        services.AddScoped<Security.ISecurityOverviewService, Security.SecurityOverviewService>();
        services.AddScoped<Security.ISecurityScanLauncher, Security.SecurityScanLauncher>();
        services.AddScoped<Security.ISecurityScanReaper, Security.SecurityScanReaper>();
        services.AddScoped<IRunComparisonService, RunComparisonService>();
        services.AddScoped<IAuditQueryService, AuditQueryService>();
        services.AddScoped<IAiRequestQueryService, AiRequestQueryService>();
        services.AddScoped<IUserService, UserService>();
        services.AddScoped<IAgentService, AgentService>();
        services.AddScoped<IAgentLoop, AgentLoop>();
        services.AddScoped<IAgentJournal, AgentJournal>();
        services.AddScoped<IApplicationContextService, ApplicationContextService>();
        services.AddScoped<IApplicationMemoryService, ApplicationMemoryService>();
        services.AddScoped<IAgentPlanService, AgentPlanService>();
        services.AddScoped<IAgentObservabilityService, AgentObservabilityService>();
        services.AddScoped<IAiOrchestrator, AiOrchestrator>();
        services.AddSingleton<ISchemaValidator, SchemaValidator>();
        services.AddScoped<IDashboardService, DashboardService>();
        services.AddScoped<IQualityInsightService, QualityInsightService>();
        services.AddSingleton<SecretMasker>();
        return services;
    }
}
