// =============================================================================
// Litefin - Tauri v2 Application Library Entry Point
// =============================================================================
// Shared runtime entrypoint invoked across both Desktop targets (via main.rs)
// and Mobile targets (via Android JNI bindings).
// =============================================================================

#[allow(unused_imports)]
use tauri::Manager;

// -----------------------------------------------------------------------------
// Module Imports
// -----------------------------------------------------------------------------
// Native UDP server discovery and Wake-on-LAN command handlers.
// -----------------------------------------------------------------------------
mod discovery;

// -----------------------------------------------------------------------------
// Window Management Commands
// -----------------------------------------------------------------------------
// High-performance native window manipulation commands exposed directly to the
// frontend IPC bridge. Handles toggling desktop window fullscreen mode cleanly.
// -----------------------------------------------------------------------------
#[tauri::command]
async fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    // Query current window presentation state from OS window handle
    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;

    // Invert fullscreen state for seamless toggle transition
    let target_state = !is_fullscreen;

    // Apply updated presentation state directly to OS window handle
    window.set_fullscreen(target_state).map_err(|e| e.to_string())?;

    // Return the new active fullscreen state to the frontend caller
    Ok(target_state)
}

/// Mobile entrypoint macro required by Tauri v2 for Android JNI initialization.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // -------------------------------------------------------------------------
    // Initialize the Tauri application builder pipeline
    // -------------------------------------------------------------------------
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // -------------------------------------------------------------------------
    // Android ExoPlayer Native Plugin Registration
    // -------------------------------------------------------------------------
    // Binds the native ExoPlayerPlugin.kt Android class into the Tauri runtime,
    // exposing low-latency hardware media decode commands directly to JavaScript.
    // Explicitly types Builder with default () config to satisfy DeserializeOwned.
    // -------------------------------------------------------------------------
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("exoplayer")
                .setup(|_app, api| {
                    let _ = api.register_android_plugin("org.litefin.app", "ExoPlayerPlugin");
                    Ok(())
                })
                .build(),
        );
    }

    builder
        // Setup hook for platform-specific configurations
        .setup(|_app| {
            // Configure default desktop zoom level (80% / 0.8 scale factor for optimal DPI rendering)
            #[cfg(desktop)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.set_zoom(0.8);
                }
            }
            Ok(())
        })
        // ---------------------------------------------------------------------
        // Native IPC Bridge Handler Registration
        // ---------------------------------------------------------------------
        // Exposes zero-dependency UDP server autodiscovery and Wake-on-LAN
        // commands directly to the Litefin frontend across Desktop and Android TV.
        // ---------------------------------------------------------------------
        .invoke_handler(tauri::generate_handler![
            discovery::discover_servers,
            discovery::cancel_server_discovery,
            discovery::send_wake_on_lan,
            toggle_fullscreen,
        ])
        // Run the application with generated context
        .run(tauri::generate_context!())
        .expect("Failed to initialize and run the Litefin application runtime");
}
