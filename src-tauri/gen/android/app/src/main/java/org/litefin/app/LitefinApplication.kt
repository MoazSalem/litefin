package org.litefin.app

import android.app.Application
import android.util.Log
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import java.util.concurrent.Executors

/**
 * =============================================================================
 * Litefin - Application Entry Point
 * =============================================================================
 * Host the earliest possible hook in the Android process lifecycle to kick off
 * WebView engine initialization on a background thread via
 * [WebViewCompat.startUpWebView].
 *
 * By default, WebView startup happens implicitly on the UI thread the first
 * time tao/wry touches any `android.webkit` API (WebView creation, settings
 * reads, user-agent queries). This blocks the main thread during cold boot and
 * delays the first frame. Starting it here — before Tauri's activity even
 * inflates its layout — moves the bulk of that work off the critical path.
 *
 * The WebView IS the Litefin UI (critical path), so per the Android guidance
 * we fire-and-forget: we do NOT wait for the callback before returning.
 * `MainActivity.onWebViewCreate` proceeds whenever tao is ready; by then the
 * engine containers have usually finished initializing on the worker thread.
 * =============================================================================
 */
class LitefinApplication : Application() {

  /**
   * Dedicated single-thread executor for WebView background startup tasks.
   * Kept as a singleton field so the executor outlives the startup request
   * (the framework dispatches async work onto it).
   */
  private val webViewStartUpExecutor = Executors.newSingleThreadExecutor()

  override fun onCreate() {
    super.onCreate()

    // -------------------------------------------------------------------------
    // Asynchronous WebView Engine Warm-Up
    // -------------------------------------------------------------------------
    // Must run before ANY implicit WebView trigger occurs on the UI thread
    // (tao's WebView inflate, wry's WebSettings access, Tauri IPC setup).
    // We intentionally do not gate subsequent startup on this callback since
    // the WebView is required immediately on the critical path.
    // -------------------------------------------------------------------------
    val startUpConfig = WebViewStartUpConfig.Builder(webViewStartUpExecutor).build()

    WebViewCompat.startUpWebView(
      this,
      startUpConfig,
      object : androidx.webkit.WebViewOutcomeReceiver<androidx.webkit.WebViewStartUpResult, WebViewStartupException> {
        override fun onResult(result: androidx.webkit.WebViewStartUpResult) {
          // -------------------------------------------------------------------
          // Startup Audit (debug diagnostics)
          // -------------------------------------------------------------------
          // Surface any call sites that forced WebView startup onto the UI
          // thread anyway — e.g. tao touching WebSettings before background
          // init finished. Empty result means the async warm-up fully won.
          // -------------------------------------------------------------------
          try {
            val uiBlocking = result.getUiThreadBlockingStartUpLocations()
            if (!uiBlocking.isNullOrEmpty()) {
              for (loc in uiBlocking) {
                Log.w("LitefinStartup", "WebView startup still blocked the UI thread at:", loc.stackInformation)
              }
            } else {
              Log.i("LitefinStartup", "WebView background startup completed with zero UI-thread blocking.")
            }
          } catch (e: Exception) {
            Log.w("LitefinStartup", "Startup audit unavailable on this WebView version: ${e.message}")
          }
        }

        override fun onError(error: WebViewStartupException) {
          Log.e("LitefinStartup", "WebView async startup failed; falling back to implicit startup.", error)
        }
      }
    )
  }
}
