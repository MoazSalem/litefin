namespace Litefin.Web;

using Litefin.Web.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// ============================================================================
/// Litefin Web - Dependency Injection Service Registrator
/// ============================================================================
/// Registers plugin background and hosted services with the Jellyfin DI container.
/// Automatically detected and invoked by the Jellyfin plugin loader at boot.
/// ============================================================================
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <summary>
    /// Registers Litefin hosted services into the application service collection.
    /// </summary>
    /// <param name="serviceCollection">The Jellyfin service container.</param>
    /// <param name="applicationHost">The server application host.</param>
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Auto-register file transformations on plugin load (for top-bar header injection)
        serviceCollection.AddHostedService<FileTransformationHostedService>();
    }
}
