// =============================================================================
// Litefin - Tauri v2 Application Library Entry Point
// =============================================================================
// Shared runtime entrypoint invoked across both Desktop targets (via main.rs)
// and Mobile targets (via Android JNI bindings).
// =============================================================================

#[allow(unused_imports)]
use tauri::Manager;

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
            // Configure default desktop zoom level (80% / 0.8 scale factor matching pake.json)
            #[cfg(desktop)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.set_zoom(0.8);
                }
            }
            Ok(())
        })
        // Run the application with generated context
        .run(tauri::generate_context!())
        .expect("Failed to initialize and run the Litefin application runtime");
}
