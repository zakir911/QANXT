using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>The role matrix is a security policy; these assertions state that policy so a
/// careless widening shows up as a failing test rather than a quiet privilege escalation.</summary>
public class RolePermissionMatrixTests
{
    [Fact]
    public void Every_permission_in_the_matrix_exists_in_the_catalogue()
    {
        var catalogue = Permissions.All.Select(p => p.Name).ToHashSet();
        foreach (var role in Enum.GetValues<SystemRole>())
            RolePermissionMatrix.For(role).Should().OnlyContain(p => catalogue.Contains(p),
                $"role {role} must not reference an unknown permission");
    }

    [Fact]
    public void Super_admin_holds_every_permission()
        => RolePermissionMatrix.For(SystemRole.SuperAdmin)
            .Should().BeEquivalentTo(Permissions.All.Select(p => p.Name));

    [Fact]
    public void Viewer_is_strictly_read_only()
    {
        var viewer = RolePermissionMatrix.For(SystemRole.Viewer);
        viewer.Should().NotContain(p => p.EndsWith(":write") || p.EndsWith(":delete")
            || p.EndsWith(":run") || p.EndsWith(":approve"));
    }

    [Fact]
    public void Roles_are_nested_from_viewer_upwards()
    {
        var viewer = RolePermissionMatrix.For(SystemRole.Viewer).ToHashSet();
        var developer = RolePermissionMatrix.For(SystemRole.Developer).ToHashSet();
        var engineer = RolePermissionMatrix.For(SystemRole.QaEngineer).ToHashSet();
        var lead = RolePermissionMatrix.For(SystemRole.QaLead).ToHashSet();
        var projectAdmin = RolePermissionMatrix.For(SystemRole.ProjectAdmin).ToHashSet();
        var orgAdmin = RolePermissionMatrix.For(SystemRole.OrganizationAdmin).ToHashSet();

        developer.Should().Contain(viewer);
        engineer.Should().Contain(developer);
        lead.Should().Contain(engineer);
        projectAdmin.Should().Contain(lead);
        orgAdmin.Should().Contain(projectAdmin);
    }

    [Fact]
    public void Only_leads_and_above_may_approve_healing()
    {
        RolePermissionMatrix.For(SystemRole.QaEngineer).Should().NotContain(Permissions.HealingApprove);
        RolePermissionMatrix.For(SystemRole.Developer).Should().NotContain(Permissions.HealingApprove);
        RolePermissionMatrix.For(SystemRole.QaLead).Should().Contain(Permissions.HealingApprove);
    }

    [Fact]
    public void Script_execution_is_restricted_to_project_administrators_and_above()
    {
        foreach (var role in new[] { SystemRole.Viewer, SystemRole.Developer, SystemRole.QaEngineer, SystemRole.QaLead })
            RolePermissionMatrix.For(role).Should().NotContain(Permissions.ExecutionScript);

        RolePermissionMatrix.For(SystemRole.ProjectAdmin).Should().Contain(Permissions.ExecutionScript);
    }

    [Fact]
    public void Developers_cannot_edit_tests()
    {
        var developer = RolePermissionMatrix.For(SystemRole.Developer);
        developer.Should().NotContain(Permissions.TestWrite);
        developer.Should().NotContain(Permissions.TestDelete);
        developer.Should().Contain(Permissions.ExecutionRun);
    }

    [Fact]
    public void Permission_catalogue_has_no_duplicates()
    {
        var names = Permissions.All.Select(p => p.Name).ToList();
        names.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Nobody_below_a_qa_lead_can_read_a_security_finding_or_start_a_scan()
    {
        // A security finding is a working description of how to break the application.
        // Read-only access to test results is not a reason to hold one, so security:read
        // starts at QA lead rather than at Viewer.
        foreach (var role in new[] { SystemRole.Viewer, SystemRole.Developer, SystemRole.QaEngineer })
        {
            var permissions = RolePermissionMatrix.For(role);
            permissions.Should().NotContain(Permissions.SecurityRead, $"{role} must not read findings");
            permissions.Should().NotContain(Permissions.SecurityScan, $"{role} must not start a scan");
            permissions.Should().NotContain(Permissions.SecurityTriage, $"{role} must not triage a finding");
        }

        RolePermissionMatrix.For(SystemRole.QaLead).Should()
            .Contain(new[] { Permissions.SecurityRead, Permissions.SecurityScan, Permissions.SecurityTriage });
    }

    [Fact]
    public void Destructive_scanning_and_authorization_need_a_project_administrator()
    {
        // Holding security:scan does not imply holding security:scan:destructive. The scope
        // has to permit destructive testing AND the caller has to hold the permission, and
        // neither one grants the other.
        foreach (var role in new[] { SystemRole.Viewer, SystemRole.Developer, SystemRole.QaEngineer, SystemRole.QaLead })
        {
            var permissions = RolePermissionMatrix.For(role);
            permissions.Should().NotContain(Permissions.SecurityScanDestructive);
            permissions.Should().NotContain(Permissions.SecurityAuthorize);
        }

        RolePermissionMatrix.For(SystemRole.ProjectAdmin).Should()
            .Contain(new[] { Permissions.SecurityScanDestructive, Permissions.SecurityAuthorize });
    }

    [Fact]
    public void Authorizing_a_production_scan_is_organization_level_only()
    {
        // Production security testing is disabled by default, and turning it on for a
        // specific run is not a decision a project owner makes alone.
        foreach (var role in new[]
                 {
                     SystemRole.Viewer, SystemRole.Developer, SystemRole.QaEngineer,
                     SystemRole.QaLead, SystemRole.ProjectAdmin
                 })
            RolePermissionMatrix.For(role).Should().NotContain(Permissions.SecurityProduction);

        RolePermissionMatrix.For(SystemRole.OrganizationAdmin).Should().Contain(Permissions.SecurityProduction);
    }

    [Fact]
    public void Every_role_has_a_description()
    {
        foreach (var role in Enum.GetValues<SystemRole>())
            RolePermissionMatrix.DescriptionOf(role).Should().NotBeNullOrWhiteSpace();
    }
}
