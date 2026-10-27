namespace Litefin.Web.Models;

using System.Text.Json.Serialization;

/// <summary>
/// ============================================================================
/// Patch Request Payload
/// ============================================================================
/// Data contract model delivered by the Jellyfin File Transformation plugin
/// when invoking static file modification callbacks.
/// Holds the raw textual contents of the target asset (such as index.html).
/// ============================================================================
/// </summary>
public class PatchRequestPayload
{
    /// <summary>
    /// Gets or sets the file contents to be inspected and transformed.
    /// Can be null or empty if the target file could not be read by the server.
    /// </summary>
    [JsonPropertyName("contents")]
    public string? Contents { get; set; }
}
