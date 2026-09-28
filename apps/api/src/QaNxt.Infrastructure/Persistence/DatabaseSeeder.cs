using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Infrastructure.Persistence;

/// <summary>Brings the permission catalogue and built-in roles in line with the code on
/// every start. This is reconciliation, not one-shot seeding: adding a permission to the
/// catalogue grants it to the right roles on the next deployment without a manual step.</summary>
public sealed class DatabaseSeeder
{
    private readonly QaNxtDbContext _db;
    private readonly IClock _clock;
    private readonly ILogger<DatabaseSeeder> _logger;

    public DatabaseSeeder(QaNxtDbContext db, IClock clock, ILogger<DatabaseSeeder> logger)
    {
        _db = db;
        _clock = clock;
        _logger = logger;
    }

    public async Task SeedAsync(CancellationToken ct = default)
    {
        var now = _clock.UtcNow;
        var permissionsByName = await SyncPermissionsAsync(now, ct).ConfigureAwait(false);
        await SyncBuiltInRolesAsync(permissionsByName, now, ct).ConfigureAwait(false);
    }

    private async Task<Dictionary<string, Permission>> SyncPermissionsAsync(DateTimeOffset now, CancellationToken ct)
    {
        var existing = await _db.Permissions.ToDictionaryAsync(p => p.Name, ct).ConfigureAwait(false);
        var added = 0;

        foreach (var (name, category, description) in Permissions.All)
        {
            if (existing.TryGetValue(name, out var permission))
            {
                if (permission.Description != description || permission.Category != category)
                {
                    permission.Description = description;
                    permission.Category = category;
                }
                continue;
            }

            permission = new Permission { Name = name, Category = category, Description = description, CreatedAt = now };
            _db.Permissions.Add(permission);
            existing[name] = permission;
            added++;
        }

        if (added > 0) _logger.LogInformation("Seeded {Count} new permissions", added);
        await _db.SaveChangesAsync(ct).ConfigureAwait(false);
        return existing;
    }

    private async Task SyncBuiltInRolesAsync(Dictionary<string, Permission> permissions, DateTimeOffset now, CancellationToken ct)
    {
        var roles = await _db.Roles
            .Include(r => r.RolePermissions)
            .Where(r => r.IsBuiltIn)
            .ToListAsync(ct).ConfigureAwait(false);

        foreach (var systemRole in Enum.GetValues<SystemRole>())
        {
            var role = roles.FirstOrDefault(r => r.SystemRole == systemRole);
            if (role is null)
            {
                role = new Role
                {
                    Name = systemRole.ToString(),
                    Description = RolePermissionMatrix.DescriptionOf(systemRole),
                    SystemRole = systemRole,
                    IsBuiltIn = true,
                    CreatedAt = now
                };
                _db.Roles.Add(role);
                await _db.SaveChangesAsync(ct).ConfigureAwait(false);
                _logger.LogInformation("Created built-in role {Role}", role.Name);
            }
            else
            {
                role.Description = RolePermissionMatrix.DescriptionOf(systemRole);
            }

            var desired = RolePermissionMatrix.For(systemRole).ToHashSet();
            var current = role.RolePermissions
                .Select(rp => permissions.Values.FirstOrDefault(p => p.Id == rp.PermissionId)?.Name)
                .Where(n => n is not null)
                .Select(n => n!)
                .ToHashSet();

            foreach (var name in desired.Except(current))
            {
                if (!permissions.TryGetValue(name, out var permission)) continue;
                _db.RolePermissions.Add(new RolePermission { RoleId = role.Id, PermissionId = permission.Id });
            }

            foreach (var name in current.Except(desired))
            {
                if (!permissions.TryGetValue(name, out var permission)) continue;
                var link = role.RolePermissions.FirstOrDefault(rp => rp.PermissionId == permission.Id);
                if (link is not null) _db.RolePermissions.Remove(link);
            }
        }

        await _db.SaveChangesAsync(ct).ConfigureAwait(false);
    }
}
