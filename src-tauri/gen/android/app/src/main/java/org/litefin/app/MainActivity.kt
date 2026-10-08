package org.litefin.app

import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Bundle
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge

/**
 * =============================================================================
 * Litefin - Android Main Activity
 * =============================================================================
 * Hosts Litefin's dual-plane rendering architecture:
 *
 * 1. Native Hardware Surface Plane (Z-Index 0):
 *    - An Android [SurfaceView] dedicated to zero-copy video decode and rendering
 *      via Media3 ExoPlayer and hardware MediaCodec instances.
 *    - Bypasses Chromium's internal compositor pipeline completely to ensure
 *      steady 60 FPS playback without UI thread frame drops.
 *
 * 2. Transparent Chromium WebView Plane (Z-Index 1):
 *    - A hardware-accelerated [RustWebView] hosting Litefin's HTML/CSS/JS interface.
 *    - Configured with a transparent window background ([Color.TRANSPARENT]) so that
 *      the video plane beneath is fully visible.
 *    - Renders the OSD, seekbars, chapter markers, and subtitles cleanly on top.
 * =============================================================================
 */
class MainActivity : TauriActivity() {

  companion object {
    /**
     * Singleton reference to active MainActivity instance for plugin access.
     */
    @Volatile
    var instance: MainActivity? = null
      private set
  }

  // ---------------------------------------------------------------------------
  // View Hierarchy References
  // ---------------------------------------------------------------------------
  // Reference to the native SurfaceView used for hardware video playback
  private var surfaceView: SurfaceView? = null

  // Reference to the shared FrameLayout root container hosting SurfaceView and WebView
  private var rootContainer: FrameLayout? = null

  // Reference to the active WebView instance
  private var activeWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    instance = this
    enableEdgeToEdge()

    // -------------------------------------------------------------------------
    // Set Pitch Black Window Background on Launch
    // -------------------------------------------------------------------------
    // Guarantees that before web layout and bundle evaluation begin,
    // the host window immediately displays a solid black canvas (#000000),
    // preventing any white background flash during application cold boot.
    // -------------------------------------------------------------------------
    window.setBackgroundDrawableResource(android.R.color.black)

    // -------------------------------------------------------------------------
    // Configure Window Pixel Format for Hardware Transparency
    // -------------------------------------------------------------------------
    // Translucent window format allows SurfaceView composited behind the window
    // to punch through transparent pixels in the WebView.
    // -------------------------------------------------------------------------
    window.setFormat(PixelFormat.TRANSLUCENT)

    super.onCreate(savedInstanceState)
  }

  override fun onDestroy() {
    if (instance == this) {
      instance = null
    }
    super.onDestroy()
  }

  /**
   * ===========================================================================
   * WebView Initialization & Configuration
   * ===========================================================================
   * Invoked when Wry/Tauri instantiates the [RustWebView].
   * Configures display scaling and transparent canvas mode.
   * ===========================================================================
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    activeWebView = webView

    // -------------------------------------------------------------------------
    // 1. Optimize WebView Display & Autoplay Settings
    // -------------------------------------------------------------------------
    webView.settings.apply {
      // Ensure proper scaling and viewport calculations for 1080p and 4K TV displays
      useWideViewPort = true
      loadWithOverviewMode = true

      // Allow media playback to start immediately without synthetic touch gestures
      mediaPlaybackRequiresUserGesture = false

      // Enable local and DOM storage for Jellyfin token caching and preferences
      domStorageEnabled = true
      databaseEnabled = true
    }

    // -------------------------------------------------------------------------
    // 2. Enable Hardware Acceleration & Transparent Canvas
    // -------------------------------------------------------------------------
    // Setting background to Color.TRANSPARENT ensures that any transparent
    // CSS elements (.player-page, body.player-active) allow the SurfaceView
    // beneath the WebView to show through directly to the display controller.
    // -------------------------------------------------------------------------
    webView.setBackgroundColor(Color.TRANSPARENT)
    webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
  }

  /**
   * ===========================================================================
   * Intercept setContentView from Tao/Wry
   * ===========================================================================
   * Tao's JNI layer calls `activity.setContentView(webView)`.
   * By intercepting here, we wrap the incoming [WebView] inside our dual-plane
   * [FrameLayout] (with [SurfaceView] at index 0 and [WebView] at index 1)
   * BEFORE it is attached to the window DecorView, preventing the crash:
   * "The specified child already has a parent. You must call removeView() first."
   * ===========================================================================
   */
  override fun setContentView(view: View?) {
    if (view is WebView) {
      super.setContentView(wrapInSurfaceContainer(view))
    } else {
      super.setContentView(view)
    }
  }

  override fun setContentView(view: View?, params: ViewGroup.LayoutParams?) {
    if (view is WebView) {
      super.setContentView(wrapInSurfaceContainer(view), params)
    } else {
      super.setContentView(view, params)
    }
  }

  /**
   * Constructs the dual-plane layout wrapping [SurfaceView] behind [WebView].
   */
  private fun wrapInSurfaceContainer(webView: View): FrameLayout {
    rootContainer?.let { return it }

    val container = FrameLayout(this).apply {
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
      // -----------------------------------------------------------------------
      // Solid Black Container Background on App Launch
      // -----------------------------------------------------------------------
      // Ensures the FrameLayout host canvas remains pitch black during initial
      // view tree construction and UI loading. Toggled to transparent during
      // native ExoPlayer video rendering.
      // -----------------------------------------------------------------------
      setBackgroundColor(Color.BLACK)
    }

    // -------------------------------------------------------------------------
    // Hardware Video Plane (SurfaceView)
    // -------------------------------------------------------------------------
    // Placed at index 0 (behind WebView at index 1).
    // Default visibility is GONE to conserve GPU bandwidth when idle.
    // -------------------------------------------------------------------------
    val surface = SurfaceView(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
      visibility = View.GONE
    }
    surface.setZOrderMediaOverlay(false)
    surface.setZOrderOnTop(false)

    this.surfaceView = surface

    container.addView(surface)
    container.addView(webView)
    this.rootContainer = container
    return container
  }

  /**
   * ===========================================================================
   * Video Surface Visibility Controls
   * ===========================================================================
   * Called by the ExoPlayer bridge when media playback begins or terminates.
   * ===========================================================================
   */

  /**
   * Makes the video surface visible and enables window transparency.
   */
  fun showVideoSurface() {
    runOnUiThread {
      // -----------------------------------------------------------------------
      // Reveal Hardware Decoding Surface Plane
      // -----------------------------------------------------------------------
      surfaceView?.visibility = View.VISIBLE
      // Clear container and window backgrounds to allow zero-copy video decode
      // on the hardware SurfaceView to punch through cleanly to the compositor
      rootContainer?.setBackgroundColor(Color.TRANSPARENT)
      window.setBackgroundDrawableResource(android.R.color.transparent)
    }
  }

  /**
   * Hides the video surface and restores standard opaque window background.
   */
  fun hideVideoSurface() {
    runOnUiThread {
      // -----------------------------------------------------------------------
      // Hide Hardware Decoding Surface Plane
      // -----------------------------------------------------------------------
      surfaceView?.visibility = View.GONE
      // Restore solid pitch black backgrounds for standard navigation UI
      rootContainer?.setBackgroundColor(Color.BLACK)
      window.setBackgroundDrawableResource(android.R.color.black)
    }
  }

  /**
   * Retrieve the active [SurfaceView] instance for ExoPlayer attachment.
   */
  fun getSurfaceView(): SurfaceView? {
    return surfaceView
  }

  /**
   * Retrieve the active [WebView] instance for JS evaluation or bridge registration.
   */
  fun getWebView(): WebView? {
    return activeWebView
  }
}
