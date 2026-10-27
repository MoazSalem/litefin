namespace Litefin.Web;

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using Litefin.Web.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

/// <summary>
/// ============================================================================
/// Litefin Client - Jellyfin Server Plugin
/// ============================================================================
/// Embedded Jellyfin server plugin responsible for serving the modern Litefin
/// web client directly from the host at http://{server_url}/litefin.
/// Manages configuration storage, plugin page discovery, and web hosting.
/// ============================================================================
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// Injected with server application paths and XML serializer by Jellyfin.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        // Cache singleton instance for controller and configuration access
        Instance = this;
    }

    /// <summary>
    /// Gets the active singleton instance of the Litefin Client plugin.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Gets the display name of the plugin displayed in the Jellyfin Dashboard.
    /// Dynamically honors tier specifications (e.g. Modern, Normal, Legacy, Ultra-Legacy).
    /// </summary>
    public override string Name => ResolvePluginName();

    /// <summary>
    /// Gets the description of the plugin displayed in the catalog.
    /// </summary>
    public override string Description => ResolvePluginDescription();

    /// <summary>
    /// Gets the unique GUID identifier for the Litefin Client plugin.
    /// Used for manifest cataloging and configuration storage.
    /// Stamped per tier via build-time assembly metadata.
    /// </summary>
    public override Guid Id => ResolvePluginGuid();

    /// <summary>
    /// Resolves the plugin unique identifier from compile-time assembly metadata if provided,
    /// falling back to the standard modern client GUID.
    /// </summary>
    private static Guid ResolvePluginGuid()
    {
        var meta = typeof(Plugin).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "PluginGuid");
        if (meta != null && Guid.TryParse(meta.Value, out var guid))
        {
            return guid;
        }
        return Guid.Parse("b4a2c918-7e3f-4d92-a1b8-6e54f0a9d123");
    }

    /// <summary>
    /// Resolves the plugin display name from compile-time assembly metadata if provided,
    /// falling back to the default "Litefin Client" title.
    /// </summary>
    private static string ResolvePluginName()
    {
        var meta = typeof(Plugin).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "PluginName");
        if (meta != null && !string.IsNullOrWhiteSpace(meta.Value))
        {
            return meta.Value;
        }
        return "Litefin Client";
    }

    /// <summary>
    /// Resolves the plugin description from compile-time assembly metadata if provided.
    /// </summary>
    private static string ResolvePluginDescription()
    {
        var meta = typeof(Plugin).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "PluginDescription");
        if (meta != null && !string.IsNullOrWhiteSpace(meta.Value))
        {
            return meta.Value;
        }
        return "Embedded modern Litefin client with Movi WebAssembly video player.";
    }

    /// <summary>
    /// Registers the plugin's configuration page with the Jellyfin Dashboard.
    /// Enables administrator configuration directly from Server Settings -> Plugins.
    /// </summary>
    /// <returns>Collection of plugin web pages.</returns>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        // Define dashboard settings page mapped to embedded configPage.html resource
        return
        [
            new PluginPageInfo
            {
                Name = this.Name,
                DisplayName = "Litefin Client",
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Configuration.configPage.html",
                    this.GetType().Namespace),
                EnableInMainMenu = true,
                MenuSection = "plugins",
                MenuIcon = "tv"
            }
        ];
    }
}
