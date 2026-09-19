using Aira.Application.Identity;
using Aira.Application.Projects;
using Aira.Application.Security;
using Microsoft.Extensions.DependencyInjection;

namespace Aira.Application;

public static class DependencyInjection
{
    /// <summary>Registers the use-case services. They are scoped because they depend on the
    /// request-scoped DbContext, tenant context and principal.</summary>
    public static IServiceCollection AddAiraApplicationServices(this IServiceCollection services)
    {
        services.AddScoped<IAuthService, AuthService>();
        services.AddScoped<IProjectService, ProjectService>();
        services.AddSingleton<SecretMasker>();
        return services;
    }
}
