// =============================================================================
// Litefin - Tauri v2 Build Script
// =============================================================================
// Invokes the Tauri build script generator to assemble application contexts,
// IPC bridges, and platform-specific resources during compilation.
// =============================================================================

fn main() {
    // Generate context and assets for Tauri v2 runtime
    tauri_build::build()
}
