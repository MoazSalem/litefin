// =============================================================================
// Litefin - Desktop Binary Executable Entrypoint
// =============================================================================
// Boots the desktop client executable. Hides the standard terminal console
// on Windows release builds to ensure a clean windowed user experience.
// =============================================================================

// Prevents additional console window on Windows in release mode
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Delegate execution to the shared cross-platform runtime library
    litefin_lib::run();
}
