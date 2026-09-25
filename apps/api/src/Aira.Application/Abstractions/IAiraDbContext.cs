using Microsoft.EntityFrameworkCore;
using Aira.Domain.Ai;
using Aira.Domain.Agent;
using Aira.Domain.Applications;
using Aira.Domain.Audit;
using Aira.Domain.Diagnosis;
using Aira.Domain.Evidence;
using Aira.Domain.Identity;
using Aira.Domain.Projects;
using Aira.Domain.Security;
using Aira.Domain.Testing;

namespace Aira.Application.Abstractions;

/// <summary>The persistence surface use cases work against. Exposing DbSets keeps LINQ
/// composition (and therefore query efficiency) available without a repository layer that
/// would only re-implement it. Tenant filtering is applied inside the implementation, not
/// by callers.</summary>
public interface IAiraDbContext
{
    DbSet<Organization> Organizations { get; }
    DbSet<User> Users { get; }
    DbSet<Role> Roles { get; }
    DbSet<Permission> Permissions { get; }
    DbSet<RolePermission> RolePermissions { get; }
    DbSet<UserRole> UserRoles { get; }
    DbSet<ProjectMember> ProjectMembers { get; }
    DbSet<RefreshToken> RefreshTokens { get; }

    DbSet<Project> Projects { get; }
    DbSet<Domain.Projects.Environment> Environments { get; }
    DbSet<QualityGateRule> QualityGateRules { get; }
    DbSet<Integration> Integrations { get; }
    DbSet<Schedule> Schedules { get; }
    DbSet<NotificationDelivery> NotificationDeliveries { get; }
    DbSet<VisualBaseline> VisualBaselines { get; }

    DbSet<Domain.Applications.Application> Applications { get; }
    DbSet<DiscoveryRun> DiscoveryRuns { get; }

    DbSet<AgentRun> AgentRuns { get; }
    DbSet<AgentStep> AgentSteps { get; }
    DbSet<AgentFinding> AgentFindings { get; }
    DbSet<AgentDecision> AgentDecisions { get; }
    DbSet<AgentApproval> AgentApprovals { get; }
    DbSet<ApplicationContext> ApplicationContexts { get; }
    DbSet<ApplicationMemory> ApplicationMemories { get; }
    DbSet<AgentTestPlan> AgentTestPlans { get; }
    DbSet<AgentTestPlanItem> AgentTestPlanItems { get; }
    DbSet<ApplicationPage> ApplicationPages { get; }
    DbSet<PageTransition> PageTransitions { get; }
    DbSet<ApplicationElement> ApplicationElements { get; }
    DbSet<ApiEndpoint> ApiEndpoints { get; }
    DbSet<ApiContract> ApiContracts { get; }
    DbSet<ChangeImpactRule> ChangeImpactRules { get; }
    DbSet<ApiContractChange> ApiContractChanges { get; }
    DbSet<Journey> Journeys { get; }
    DbSet<JourneyStep> JourneySteps { get; }

    DbSet<TestSuite> TestSuites { get; }
    DbSet<TestCase> TestCases { get; }
    DbSet<TestStep> TestSteps { get; }
    DbSet<Assertion> Assertions { get; }
    DbSet<TestDataSet> TestDataSets { get; }
    DbSet<TestDataField> TestDataFields { get; }
    DbSet<TestRun> TestRuns { get; }
    DbSet<TestExecution> TestExecutions { get; }
    DbSet<TestAction> TestActions { get; }

    DbSet<Artifact> Artifacts { get; }
    DbSet<NetworkEvent> NetworkEvents { get; }
    DbSet<ConsoleEvent> ConsoleEvents { get; }

    DbSet<Failure> Failures { get; }
    DbSet<FailureAnalysis> FailureAnalyses { get; }
    DbSet<LocatorCandidate> LocatorCandidates { get; }
    DbSet<HealingEvent> HealingEvents { get; }
    DbSet<Defect> Defects { get; }

    DbSet<AiRequest> AiRequests { get; }
    DbSet<AiResponse> AiResponses { get; }
    DbSet<AuditLog> AuditLogs { get; }

    DbSet<SecurityScope> SecurityScopes { get; }
    DbSet<SecurityScan> SecurityScans { get; }
    DbSet<SecurityFinding> SecurityFindings { get; }
    DbSet<SecurityBlockedRequest> SecurityBlockedRequests { get; }
    DbSet<SecurityScanFinding> SecurityScanFindings { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);

    /// <summary>Runs a unit of work that must span several SaveChanges calls atomically.</summary>
    Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken ct = default);
}
