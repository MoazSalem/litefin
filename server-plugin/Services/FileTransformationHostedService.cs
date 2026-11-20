namespace Litefin.Web.Services;

using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Litefin.Web.Helpers;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

/// <summary>
/// ============================================================================
/// File Transformation Hosted Service
/// ============================================================================
/// Hosted service that automatically registers Litefin's file transformations
/// with the Jellyfin File Transformation plugin when the server boots or plugin loads.
/// Enables seamless zero-config injection of the top bar quick launcher.
/// ============================================================================
/// </summary>
public class FileTransformationHostedService : IHostedService
{
    private readonly ILogger<FileTransformationHostedService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="FileTransformationHostedService"/> class.
    /// </summary>
    /// <param name="logger">Logger service instance.</param>
    public FileTransformationHostedService(ILogger<FileTransformationHostedService> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Starts the hosted service and attempts registration of index.html transformation.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Completed task.</returns>
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Litefin: Auto-registering web file transformations.");

        try
        {
            RegisterTransformation();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Litefin: Failed to auto-register file transformations.");
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Stops the hosted service.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Completed task.</returns>
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    /// <summary>
    /// Dynamically locates the File Transformation plugin and invokes its registration method.
    /// </summary>
    private void RegisterTransformation()
    {
        // Prepare registration payload pointing to Litefin's IndexHtml transformation callback
        var payload = new JObject
        {
            { "id", "b4a2c918-0002-4d92-a1b8-6e54f0a9d123" },
            { "fileNamePattern", "index.html" },
            { "callbackAssembly", GetType().Assembly.FullName },
            { "callbackClass", typeof(TransformationPatches).FullName },
            { "callbackMethod", nameof(TransformationPatches.IndexHtml) }
        };

        // Locate File Transformation assembly across active load contexts
        Assembly? ftAssembly = AssemblyLoadContext.All
            .SelectMany(x => x.Assemblies)
            .FirstOrDefault(x => x.FullName?.Contains(".FileTransformation") ?? false);

        if (ftAssembly == null)
        {
            _logger.LogInformation(
                "Litefin: File Transformation plugin not detected. Automatic top bar button injection is dormant. " +
                "To enable automatic injection into Jellyfin Web, install File Transformation from https://github.com/IAmParadox27/jellyfin-plugin-file-transformation");
            return;
        }

        // Obtain FileTransformation's PluginInterface type
        Type? pluginInterfaceType = ftAssembly
            .GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");

        if (pluginInterfaceType == null)
        {
            _logger.LogWarning(
                "Litefin: File Transformation PluginInterface type not found. " +
                "Ensure File Transformation plugin is v2.2.1.0 or newer.");
            return;
        }

        // Invoke static RegisterTransformation method
        pluginInterfaceType.GetMethod("RegisterTransformation")
            ?.Invoke(null, new object?[] { payload });

        _logger.LogInformation("Litefin: Successfully registered index.html top bar transformation.");
    }
}
