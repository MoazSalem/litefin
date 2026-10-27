namespace Litefin.Web.Helpers;

using System;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using Litefin.Web.Models;

/// <summary>
/// ============================================================================
/// Transformation Patches
/// ============================================================================
/// Static callbacks invoked by the Jellyfin File Transformation plugin to inject
/// Litefin's frontend assets and top bar launcher into Jellyfin Web's index.html.
/// ============================================================================
/// </summary>
public static class TransformationPatches
{
    /// <summary>
    /// Injects the Litefin loader script and styles into index.html before the closing &lt;/head&gt; tag.
    /// Honors the plugin setting to display or hide the header launcher button.
    /// </summary>
    /// <param name="payload">Patch request payload containing original index.html content.</param>
    /// <returns>Modified HTML with Litefin launcher injected, or original if disabled.</returns>
    public static string IndexHtml(PatchRequestPayload payload)
    {
        // If content is empty or null, return immediately
        if (string.IsNullOrEmpty(payload.Contents))
        {
            return payload.Contents ?? string.Empty;
        }

        // Verify if administrator enabled the top bar button in plugin settings
        var config = Plugin.Instance?.Configuration;
        if (config?.EnableHeaderButton == false ||
            string.Equals(config?.HeaderButtonMode, "Hidden", StringComparison.OrdinalIgnoreCase))
        {
            // Disabled / Hidden in settings: do not inject any loader or styling into index.html
            return payload.Contents;
        }

        // Retrieve the embedded injection HTML bundle (contains styles and script tag)
        var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("Litefin.Web.Web.inject.html");

        // Fallback to relative script tag if embedded resource stream is unavailable
        if (stream == null)
        {
            var fallbackScript = "<script src=\"../litefin/loader.js\" defer></script>";
            return Regex.Replace(payload.Contents, "(</head>)", $"{fallbackScript}$1");
        }

        // Read injection markup from stream
        using var reader = new StreamReader(stream);
        var injectHtml = reader.ReadToEnd();

        // Inject right before the closing </head> tag of Jellyfin Web's index.html
        return Regex.Replace(payload.Contents, "(</head>)", $"{injectHtml}$1");
    }
}
