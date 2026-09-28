using System.Reflection;
using QaNxt.Application.Agent;
using QaNxt.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Agent;

/// <summary>
/// What the autonomous loop can actually reach.
/// </summary>
/// <remarks>
/// <para>
/// These exist because of the finding that opened this phase. The loop carried a
/// <c>using QaNxt.Application.Security;</c> and used nothing from that namespace: it injected
/// discovery, test generation, test runs and the database, so an autonomous pass produced UI
/// tests and nothing else — no API tests however many endpoints the crawl found, no security
/// scan however the application was authorized, and no re-run of the tests most likely to
/// catch a regression.
/// </para>
/// <para>
/// Nothing about that was visible from reading the code, and no test failed because of it.
/// It was found by asking what the class depends on. These tests ask the same question every
/// time they run, so the connection cannot quietly come undone again — a phase deleted, a
/// dependency dropped during a refactor, an engine swapped for a stub.
/// </para>
/// </remarks>
public class AgentReachTests
{
    private static readonly Type Loop = typeof(AgentLoop);

    private static IReadOnlyList<Type> ConstructorParameters =>
        Loop.GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .Single()
            .GetParameters()
            .Select(p => p.ParameterType)
            .ToList();

    private static IReadOnlyList<string> PhaseMethods =>
        Loop.GetMethods(BindingFlags.NonPublic | BindingFlags.Instance)
            .Select(m => m.Name)
            .ToList();

    [Fact]
    public void The_loop_can_reach_the_api_testing_engine()
    {
        ConstructorParameters.Should().Contain(typeof(QaNxt.Application.Testing.IApiTestService),
            "an autonomous pass that cannot call the API engine produces UI tests however many "
            + "endpoints the crawl found");
    }

    [Fact]
    public void The_loop_can_reach_the_security_engine()
    {
        ConstructorParameters.Should().Contain(typeof(QaNxt.Application.Security.ISecurityScanLauncher),
            "this is the dependency the loop claimed with an unused using and did not have");
    }

    [Fact]
    public void The_loop_reaches_the_security_engine_through_the_launcher_and_not_around_it()
    {
        // The launcher re-checks the scope, the profile, the permissions and the environment
        // before anything is queued. Depending on anything below it would be a second path to
        // issuing a security request, and a control with two doors is a control with one door.
        //
        // Named rather than matched on the namespace: SecretMasker lives there too and is a
        // text utility, so a namespace rule would fail for a reason that has nothing to do
        // with what it is protecting.
        var scanningInternals = new[]
        {
            typeof(QaNxt.Application.Security.ISecurityScanService),
            typeof(QaNxt.Application.Security.SecurityScopeGuard)
        };

        ConstructorParameters.Should().NotIntersectWith(scanningInternals);
        ConstructorParameters.Should().Contain(typeof(QaNxt.Application.Security.ISecurityScanLauncher));
    }

    [Fact]
    public void The_loop_records_what_it_decides()
    {
        ConstructorParameters.Should().Contain(typeof(IAgentJournal),
            "a pass nobody watched is worth nothing unless every decision can be read back");
    }

    [Fact]
    public void The_loop_reads_what_a_person_said_about_the_application()
    {
        ConstructorParameters.Should().Contain(typeof(IApplicationContextService),
            "exclusions are honoured absolutely, and a loop that cannot read them cannot honour them");
    }

    [Fact]
    public void Every_phase_the_brief_asks_for_exists_on_the_loop()
    {
        // Named individually rather than counted, so deleting one fails with the name of the
        // capability that went missing rather than with an arithmetic surprise.
        PhaseMethods.Should().Contain("PlanAsync");
        PhaseMethods.Should().Contain("ApiTestingAsync");
        PhaseMethods.Should().Contain("SecurityTestingAsync");
        PhaseMethods.Should().Contain("SelectRegressionAsync");
    }

    [Fact]
    public void Every_action_goes_through_the_policy_gate()
    {
        PhaseMethods.Should().Contain("CheckAsync",
            "one answer to 'what may this pass do', in one place a reader can check without "
            + "following the loop's control flow");
    }

    [Fact]
    public void The_phases_the_new_work_runs_in_are_real_phases()
    {
        // A phase enum value that nothing sets is a timeline entry that never appears.
        Enum.IsDefined(typeof(AgentPhase), AgentPhase.Planning).Should().BeTrue();
        Enum.IsDefined(typeof(AgentPhase), AgentPhase.SecurityTesting).Should().BeTrue();
        Enum.IsDefined(typeof(AgentPhase), AgentPhase.AwaitingApproval).Should().BeTrue();
        Enum.IsDefined(typeof(AgentRunStatus), AgentRunStatus.AwaitingApproval).Should().BeTrue();
    }

    [Fact]
    public void A_run_waiting_for_a_person_is_its_own_status_rather_than_a_flag_on_running()
    {
        // A dashboard that cannot tell "waiting on somebody" from "working" will show one as
        // the other, and the one it shows wrongly is the one that needs a person.
        AgentRunStatus.AwaitingApproval.Should().NotBe(AgentRunStatus.Running);
        AgentRunStatus.AwaitingApproval.Should().NotBe(AgentRunStatus.Stopped);
    }
}
