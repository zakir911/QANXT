using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Identity;

/// <summary>A named bundle of permissions. Seeded with the seven built-in roles;
/// organizations may add custom roles later without a schema change.</summary>
public class Role : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public SystemRole? SystemRole { get; set; }
    /// <summary>Built-in roles cannot be edited or deleted through the API.</summary>
    public bool IsBuiltIn { get; set; }
    /// <summary>Null for built-in roles; set for organization-defined roles.</summary>
    public Guid? OrganizationId { get; set; }

    public ICollection<RolePermission> RolePermissions { get; set; } = new List<RolePermission>();
    public ICollection<UserRole> UserRoles { get; set; } = new List<UserRole>();
}

/// <summary>A single capability, named "resource:action" (e.g. "testcase:write").</summary>
public class Permission : BaseEntity
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Category { get; set; } = string.Empty;

    public ICollection<RolePermission> RolePermissions { get; set; } = new List<RolePermission>();
}

public class RolePermission
{
    public Guid RoleId { get; set; }
    public Role? Role { get; set; }
    public Guid PermissionId { get; set; }
    public Permission? Permission { get; set; }
}

/// <summary>Organization-wide role assignment. Project-scoped roles live on <see cref="ProjectMember"/>.</summary>
public class UserRole
{
    public Guid UserId { get; set; }
    public User? User { get; set; }
    public Guid RoleId { get; set; }
    public Role? Role { get; set; }
    public DateTimeOffset AssignedAt { get; set; }
    public Guid? AssignedByUserId { get; set; }
}

/// <summary>Scopes a user's role to one project, so a QA engineer on project A is a
/// viewer (or nothing) on project B.</summary>
public class ProjectMember : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Projects.Project? Project { get; set; }
    public Guid UserId { get; set; }
    public User? User { get; set; }
    public Guid RoleId { get; set; }
    public Role? Role { get; set; }
}
