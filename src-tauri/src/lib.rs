// =============================================================================
// Litefin - Tauri v2 Application Library Entry Point
// =============================================================================
// Shared runtime entrypoint invoked across both Desktop targets (via main.rs)
// and Mobile targets (via Android JNI bindings).
// =============================================================================

use tauri::Manager;

/// Mobile entrypoint macro required by Tauri v2 for Android JNI initialization.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // -------------------------------------------------------------------------
    // Initialize the Tauri application builder pipeline
    // -------------------------------------------------------------------------
    tauri::Builder::default()
        // Setup hook for platform-specific configurations
        .setup(|app| {
            // Configure default desktop zoom level (80% / 0.8 scale factor matching pake.json)
            #[cfg(desktop)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_zoom(0.8);
                }
            }
            Ok(())
        })
        // Run the application with generated context
        .run(tauri::generate_context!())
        .expect("Failed to initialize and run the Litefin application runtime");
}
