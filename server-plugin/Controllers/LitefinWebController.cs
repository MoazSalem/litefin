namespace Litefin.Web.Controllers;

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

/// <summary>
/// ============================================================================
/// Litefin Web - Static Asset Controller &amp; SPA Host
/// ============================================================================
/// Hosts the modern Litefin web application bundled inside the plugin folder.
/// Serves all client assets (HTML, CSS, JS, fonts, images, and WebAssembly)
/// directly under the /litefin route with SPA fallback, cross-origin isolation,
/// and embedded resources for stock Jellyfin Web top bar integration.
/// ============================================================================
/// </summary>
[ApiController]
[Route("litefin")]
public class LitefinWebController : ControllerBase
{
    private readonly Assembly _assembly;
    private readonly ILogger<LitefinWebController> _logger;

    // Single-instance guard to prevent flooding server logs if web assets are missing
    private static int _missingWebRootLogged;

    // Fast lookup dictionary for supported web asset MIME content types
    private static readonly IReadOnlyDictionary<string, string> ContentTypes =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8",
            [".htm"] = "text/html; charset=utf-8",
            [".js"] = "application/javascript",
            [".mjs"] = "text/javascript",
            [".css"] = "text/css",
            [".json"] = "application/json",
            [".map"] = "application/json",
            [".wasm"] = "application/wasm",
            [".svg"] = "image/svg+xml",
            [".png"] = "image/png",
            [".jpg"] = "image/jpeg",
            [".jpeg"] = "image/jpeg",
            [".gif"] = "image/gif",
            [".webp"] = "image/webp",
            [".ico"] = "image/x-icon",
            [".txt"] = "text/plain; charset=utf-8",
            [".xml"] = "application/xml",
            [".woff"] = "font/woff",
            [".woff2"] = "font/woff2",
            [".ttf"] = "font/ttf",
            [".otf"] = "font/otf"
        };

    /// <summary>
    /// Initializes a new instance of the <see cref="LitefinWebController"/> class.
    /// </summary>
    /// <param name="logger">Logger service provided via dependency injection.</param>
    public LitefinWebController(ILogger<LitefinWebController> logger)
    {
        _logger = logger;
        _assembly = typeof(LitefinWebController).Assembly;
    }

    // Regex used to replace or inject dynamic <base href> for deep SPA routes and reverse proxies
    private static readonly Regex BaseHrefRegex = new Regex(
        "<base\\s+href=\"[^\"]*\"\\s*/?>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Serves the Litefin loader script bridge for stock Jellyfin Web top bar integration.
    /// Injects the fast-access toolbar button into Jellyfin's header navigation.
    /// </summary>
    /// <returns>The loader.js javascript response.</returns>
    [HttpGet("loader.js")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetLoaderJs()
    {
        // Try embedded resource first to ensure zero-disk-dependency operation
        var resourceName = "Litefin.Web.Web.loader.js";
        var stream = _assembly.GetManifestResourceStream(resourceName);
        if (stream != null)
        {
            Response.Headers["Cache-Control"] = "no-cache, must-revalidate";
            return File(stream, "application/javascript");
        }

        // Fallback to disk file if running unpackaged in local development
        var webRoot = ResolveWebRoot();
        if (!string.IsNullOrWhiteSpace(webRoot))
        {
            var diskPath = Path.Combine(webRoot, "loader.js");
            if (System.IO.File.Exists(diskPath))
            {
                Response.Headers["Cache-Control"] = "no-cache, must-revalidate";
                return PhysicalFile(diskPath, "application/javascript");
            }
        }

        return NotFound(new { Error = "loader.js not found" });
    }

    /// <summary>
    /// Serves runtime configuration consumed by the Litefin Web header launcher script.
    /// Allows immediate client-side reaction when the administrator enables or disables the launcher.
    /// </summary>
    /// <returns>JSON configuration payload.</returns>
    [HttpGet("config.json")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetRuntimeConfig()
    {
        var config = Plugin.Instance?.Configuration;
        var mode = config?.HeaderButtonMode ?? (config?.EnableHeaderButton == false ? "Hidden" : "Colored");
        var payload = new
        {
            headerButtonMode = mode,
            enableHeaderButton = !string.Equals(mode, "Hidden", StringComparison.OrdinalIgnoreCase),
            pluginMenuTitle = config?.PluginMenuTitle ?? "Litefin Client"
        };

        // Disable caching for instant admin configuration toggling
        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        Response.Headers["Pragma"] = "no-cache";
        Response.Headers["Expires"] = "0";

        return new JsonResult(payload);
    }

    /// <summary>
    /// Serves the 130x130 Litefin launcher icon used by the top bar button.
    /// Falls back to embedded assembly resource if not present in the physical web folder.
    /// </summary>
    /// <returns>The icon-130.png image stream or file.</returns>
    [HttpGet("assets/icon-130.png")]
    [HttpGet("icon-130.png")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetIcon130()
    {
        // 1. Check physical file in webRoot assets directory
        var webRoot = ResolveWebRoot();
        if (!string.IsNullOrWhiteSpace(webRoot))
        {
            var diskAsset = Path.Combine(webRoot, "assets", "icon-130.png");
            if (System.IO.File.Exists(diskAsset))
            {
                Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
                return PhysicalFile(diskAsset, "image/png");
            }

            var diskRoot = Path.Combine(webRoot, "icon-130.png");
            if (System.IO.File.Exists(diskRoot))
            {
                Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
                return PhysicalFile(diskRoot, "image/png");
            }
        }

        // 2. Check embedded assembly resource
        var stream = _assembly.GetManifestResourceStream("Litefin.Web.assets.icon-130.png");
        if (stream != null)
        {
            Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
            return File(stream, "image/png");
        }

        return NotFound();
    }

    /// <summary>
    /// Serves Litefin static assets and acts as the SPA router fallback.
    /// Handles /litefin, /litefin/, and all nested file and route requests.
    /// </summary>
    /// <param name="path">Requested subpath inside the web bundle.</param>
    /// <returns>Physical file response, redirect, or 404.</returns>
    [HttpGet("{**path}")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status302Found)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult GetWebAsset([FromRoute] string? path)
    {
        // ====================================================================
        // Trailing Slash Normalization for Root Endpoint (/litefin vs /litefin/)
        // ====================================================================
        // When a user hits the base route without a trailing slash (e.g. /litefin),
        // we redirect once to /litefin/ so that relative asset references
        // in index.html (like js/main.js) resolve against /litefin/ instead of the root /.
        // We explicitly inspect the incoming Request.Path to ensure that once the URL
        // has a trailing slash, we immediately serve index.html rather than looping.
        var requestPath = Request.Path.Value ?? string.Empty;
        if (string.IsNullOrWhiteSpace(path))
        {
            if (!requestPath.EndsWith('/'))
            {
                var pathBase = Request.PathBase.Value?.TrimEnd('/') ?? string.Empty;
                var destination = $"{pathBase}/litefin/{Request.QueryString}";
                return Redirect(destination);
            }
        }

        // ====================================================================
        // Web Root Resolution
        // ====================================================================
        var webRoot = ResolveWebRoot();
        if (string.IsNullOrWhiteSpace(webRoot) || !Directory.Exists(webRoot))
        {
            WarnAboutMissingWebRoot(webRoot);
            return NotFound(new
            {
                Error = "Litefin web client assets not found on server disk.",
                ExpectedPath = webRoot
            });
        }

        // Default empty subpath directly to index.html
        var requestedPath = string.IsNullOrWhiteSpace(path) ? "index.html" : path;

        // Verify path safety and prevent directory traversal exploits
        if (!TryResolvePath(webRoot, requestedPath, out var fullPath))
        {
            return NotFound();
        }

        // ====================================================================
        // Physical File Serving
        // ====================================================================
        if (System.IO.File.Exists(fullPath))
        {
            if (IsIndexHtml(fullPath))
            {
                return ServeIndexHtml(fullPath);
            }

            return PhysicalFile(fullPath, GetContentType(fullPath));
        }

        // ====================================================================
        // Nested Asset Fallback Resolution
        // ====================================================================
        // When stylesheets or scripts live in nested folders (such as css/ or js/),
        // any relative asset references (like font files or images) that omit the
        // parent directory traversal may arrive at the server with a leading "css/"
        // or "js/" prefix (e.g. "css/assets/fonts/Poppins.woff2").
        // To guarantee fonts and icons always load reliably regardless of client
        // bundle configuration, test if stripping the subfolder prefix yields a valid file.
        if (requestedPath.StartsWith("css/assets/", StringComparison.OrdinalIgnoreCase))
        {
            // Strip leading "css/" segment to reach the root "assets/..." path
            var fallbackRelative = requestedPath.Substring(4);
            if (TryResolvePath(webRoot, fallbackRelative, out var fallbackPath) && System.IO.File.Exists(fallbackPath))
            {
                // Serve the existing root asset with correct MIME type
                return PhysicalFile(fallbackPath, GetContentType(fallbackPath));
            }
        }
        else if (requestedPath.StartsWith("js/assets/", StringComparison.OrdinalIgnoreCase))
        {
            // Strip leading "js/" segment to reach the root "assets/..." path
            var fallbackRelative = requestedPath.Substring(3);
            if (TryResolvePath(webRoot, fallbackRelative, out var fallbackPath) && System.IO.File.Exists(fallbackPath))
            {
                // Serve the existing root asset with correct MIME type
                return PhysicalFile(fallbackPath, GetContentType(fallbackPath));
            }
        }

        // ====================================================================
        // Directory Subpath Normalization
        // ====================================================================
        if (Directory.Exists(fullPath))
        {
            var nestedIndexPath = Path.Combine(fullPath, "index.html");
            if (System.IO.File.Exists(nestedIndexPath))
            {
                if (requestPath.Length > 0 && !requestPath.EndsWith('/'))
                {
                    return Redirect($"{Request.PathBase}{requestPath}/{Request.QueryString}");
                }

                return ServeIndexHtml(nestedIndexPath);
            }
        }

        // ====================================================================
        // SPA Route Fallback
        // ====================================================================
        // If the path does not have a file extension (e.g. /litefin/home or /litefin/settings),
        // serve index.html so the client-side router can handle page navigation.
        var hasFileExtension = Path.HasExtension(requestedPath);
        if (!hasFileExtension)
        {
            var rootIndex = Path.Combine(webRoot, "index.html");
            if (System.IO.File.Exists(rootIndex))
            {
                return ServeIndexHtml(rootIndex);
            }
        }

        // Missing static resource with an extension (.js, .css, .png, etc.) -> return 404
        return NotFound();
    }

    /// <summary>
    /// Injects cross-origin isolation headers for WebAssembly multi-threading support.
    /// </summary>
    private void ApplyIsolationHeaders()
    {
        // Verify administrator preference from plugin configuration
        var isolate = Plugin.Instance?.Configuration?.EnableCrossOriginIsolation ?? true;
        if (!isolate)
        {
            return;
        }

        // Same-origin COOP policy isolates the browsing context
        Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";

        // Credentialless COEP allows external image/media loads without strict CORP headers
        Response.Headers["Cross-Origin-Embedder-Policy"] = "credentialless";
    }

    /// <summary>
    /// Serves the index.html document with proper cache headers, isolation, and base href.
    /// </summary>
    /// <param name="indexPath">Physical path to index.html.</param>
    /// <returns>Content result or physical file response.</returns>
    private IActionResult ServeIndexHtml(string indexPath)
    {
        ApplyIsolationHeaders();

        // Prevent aggressive browser caching of the single-page entry document
        Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
        Response.Headers["Pragma"] = "no-cache";
        Response.Headers["Expires"] = "0";

        var pathBase = Request.PathBase.Value?.TrimEnd('/') ?? string.Empty;
        var baseHref = $"{pathBase}/litefin/";

        try
        {
            var html = System.IO.File.ReadAllText(indexPath);
            if (BaseHrefRegex.IsMatch(html))
            {
                html = BaseHrefRegex.Replace(html, $"<base href=\"{baseHref}\">");
            }
            else
            {
                html = Regex.Replace(html, "<head>", $"<head>\n    <base href=\"{baseHref}\">", RegexOptions.IgnoreCase);
            }

            return Content(html, "text/html; charset=utf-8");
        }
        catch (Exception)
        {
            return PhysicalFile(indexPath, "text/html; charset=utf-8");
        }
    }

    /// <summary>
    /// Resolves the physical path to the bundled web assets folder.
    /// </summary>
    /// <returns>Absolute directory path.</returns>
    private string ResolveWebRoot()
    {
        // 1. Environment variable override for local testing or custom deployment
        var envOverride = Environment.GetEnvironmentVariable("LITEFIN_WEB_ROOT");
        if (!string.IsNullOrWhiteSpace(envOverride) && Directory.Exists(envOverride))
        {
            return Path.GetFullPath(envOverride);
        }

        // 2. Standard location: "web" folder adjacent to the plugin assembly DLL
        var assemblyDir = Path.GetDirectoryName(_assembly.Location);
        if (!string.IsNullOrWhiteSpace(assemblyDir))
        {
            var localWeb = Path.Combine(assemblyDir, "web");
            if (Directory.Exists(localWeb))
            {
                return Path.GetFullPath(localWeb);
            }

            // Fallback for local development environments running from project source
            var devWeb = Path.GetFullPath(Path.Combine(assemblyDir, "..", "..", "..", "..", "dist", "web"));
            if (Directory.Exists(devWeb))
            {
                return devWeb;
            }
        }

        // 3. Fallback to Jellyfin plugin data directory
        var dataFolder = Plugin.Instance?.DataFolderPath;
        if (!string.IsNullOrWhiteSpace(dataFolder))
        {
            var dataWeb = Path.Combine(dataFolder, "web");
            if (Directory.Exists(dataWeb))
            {
                return Path.GetFullPath(dataWeb);
            }
        }

        // Default path used in logging and diagnostics
        return !string.IsNullOrWhiteSpace(assemblyDir)
            ? Path.Combine(assemblyDir, "web")
            : string.Empty;
    }

    /// <summary>
    /// Validates requested path to prevent directory traversal attacks.
    /// </summary>
    /// <param name="rootPath">Allowed base directory.</param>
    /// <param name="requestPath">Requested relative file path.</param>
    /// <param name="fullPath">Resolved absolute file path.</param>
    /// <returns>True if the resolved path is safely located inside rootPath.</returns>
    private static bool TryResolvePath(string rootPath, string requestPath, out string fullPath)
    {
        // Normalize slashes and trim leading separators
        var normalizedRequest = requestPath.Replace('\\', '/').TrimStart('/');
        var candidate = Path.Combine(rootPath, normalizedRequest.Replace('/', Path.DirectorySeparatorChar));
        fullPath = Path.GetFullPath(candidate);

        var normalizedRoot = Path.GetFullPath(rootPath);
        var rootWithSeparator = normalizedRoot.EndsWith(Path.DirectorySeparatorChar)
            ? normalizedRoot
            : normalizedRoot + Path.DirectorySeparatorChar;

        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        // Ensure candidate resides strictly within the root folder boundaries
        return fullPath.StartsWith(rootWithSeparator, comparison) ||
               string.Equals(fullPath, normalizedRoot, comparison);
    }

    /// <summary>
    /// Emits a single warning to server logs if web client assets are missing.
    /// </summary>
    /// <param name="resolvedPath">The path that was searched.</param>
    private void WarnAboutMissingWebRoot(string resolvedPath)
    {
        if (Interlocked.Exchange(ref _missingWebRootLogged, 1) != 0)
        {
            return;
        }

        var assemblyDir = Path.GetDirectoryName(_assembly.Location);
        _logger.LogWarning(
            "Litefin web assets are missing from disk. Looked at {ResolvedPath} (Assembly: {AssemblyDir}). " +
            "Please ensure the 'web' directory is included in your plugin installation folder.",
            resolvedPath,
            assemblyDir);
    }

    /// <summary>
    /// Determines whether the given file path represents index.html.
    /// </summary>
    private static bool IsIndexHtml(string filePath)
    {
        return string.Equals(
            Path.GetFileName(filePath),
            "index.html",
            StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Resolves MIME content type by file extension.
    /// </summary>
    private static string GetContentType(string filePath)
    {
        var extension = Path.GetExtension(filePath);
        if (ContentTypes.TryGetValue(extension, out var contentType))
        {
            return contentType;
        }

        return "application/octet-stream";
    }
}

