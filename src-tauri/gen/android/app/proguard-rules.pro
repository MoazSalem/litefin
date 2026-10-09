# =============================================================================
# Litefin Android - ProGuard & R8 Optimization Rules
# =============================================================================
# Configured for aggressive release minification while protecting JNI bindings,
# Tauri v2 IPC bridge plugins, and hardware-accelerated Media3 ExoPlayer.
# =============================================================================

# -----------------------------------------------------------------------------
# JNI & Native Method Preservations
# -----------------------------------------------------------------------------
# Prevent R8 from stripping native C/Rust functions bound via JNI.
-keepclasseswithmembernames class * {
    native <methods>;
}

# -----------------------------------------------------------------------------
# Tauri v2 Core & Plugin Reflection
# -----------------------------------------------------------------------------
# Preserve Tauri runtime entrypoints and custom Android plugin handlers.
-keep class app.tauri.** { *; }
-keep interface app.tauri.** { *; }
-keep class org.litefin.app.** { *; }
-keep interface org.litefin.app.** { *; }

# Preserve JavaScript interface methods registered for WebView
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# -----------------------------------------------------------------------------
# Google Media3 ExoPlayer Direct-Play Suite
# -----------------------------------------------------------------------------
# Preserve audio decoders, video renderers, and OkHttp data sources
-keep class androidx.media3.exoplayer.** { *; }
-keep interface androidx.media3.exoplayer.** { *; }
-keep class androidx.media3.datasource.** { *; }
-keep class androidx.media3.ui.** { *; }
-dontwarn androidx.media3.**

# -----------------------------------------------------------------------------
# OkHttp & Kotlin Coroutines
# -----------------------------------------------------------------------------
-dontwarn okhttp3.**
-dontwarn okio.**