namespace Litefin.Web.Configuration;

using System;
using MediaBrowser.Model.Plugins;

/// <summary>
/// ============================================================================
/// Litefin Client - Plugin Configuration Model
/// ============================================================================
/// Stores server-wide settings for the Litefin Client hosting plugin.
/// Jellyfin automatically serializes and persists instances of this configuration
/// to the server's plugins configuration directory.
/// ============================================================================
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class.
    /// Sets sensible defaults for client isolation, navigation, and web hosting.
    /// </summary>
    public PluginConfiguration()
    {
        // Enable cross-origin isolation by default so the Movi WebAssembly player
        // and WebCodecs can use SharedArrayBuffer for high-performance demuxing.
        EnableCrossOriginIsolation = true;

        // Custom branding label shown in the Jellyfin navigation menu sidebar
        PluginMenuTitle = "Litefin Client";

        // Quick-access Litefin launcher button shown in the Jellyfin Web top bar.
        // Choices: "Colored" (default), "White" (monochrome SVG), or "Hidden".
        HeaderButtonMode = "Colored";
    }

    /// <summary>
    /// Gets or sets a value indicating whether Cross-Origin-Opener-Policy (COOP) and
    /// Cross-Origin-Embedder-Policy (COEP) response headers should be attached when serving index.html.
    /// Required for WebAssembly multi-threading in modern browsers.
    /// </summary>
    public bool EnableCrossOriginIsolation { get; set; }

    /// <summary>
    /// Gets or sets the custom menu title displayed in the Jellyfin web navigation sidebar.
    /// </summary>
    public string PluginMenuTitle { get; set; } = "Litefin Client";

    /// <summary>
    /// Gets or sets the presentation mode for the Litefin launcher button in the Jellyfin Web header.
    /// Supports "Colored" (default PNG icon), "White" (monochrome SVG), or "Hidden".
    /// </summary>
    public string HeaderButtonMode { get; set; } = "Colored";

    /// <summary>
    /// Gets or sets a value indicating whether the Litefin launcher button is enabled.
    /// Retained for backwards compatibility with earlier plugin releases.
    /// </summary>
    public bool EnableHeaderButton
    {
        get => !string.Equals(HeaderButtonMode, "Hidden", StringComparison.OrdinalIgnoreCase);
        set
        {
            if (!value)
            {
                HeaderButtonMode = "Hidden";
            }
            else if (string.Equals(HeaderButtonMode, "Hidden", StringComparison.OrdinalIgnoreCase))
            {
                HeaderButtonMode = "Colored";
            }
        }
    }
}
