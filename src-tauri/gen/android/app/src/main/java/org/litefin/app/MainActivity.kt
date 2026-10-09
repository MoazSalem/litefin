package org.litefin.app

import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.media3.ui.AspectRatioFrameLayout

/**
 * =============================================================================
 * Litefin - Android Main Activity
 * =============================================================================
 * Hosts Litefin's dual-plane rendering architecture:
 *
 * 1. Native Hardware Texture Plane (Z-Index 0):
 *    - An Android [TextureView] dedicated to video decode and rendering via
 *      Media3 ExoPlayer and hardware MediaCodec instances.
 *    - Composes directly into Android's window view hierarchy without requiring
 *      SurfaceFlinger punch-through holes, eliminating black screens on TVs.
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
  // Reference to the native TextureView used for video playback
  private var textureView: TextureView? = null

  // Reference to the AspectRatioFrameLayout enforcing movie proportions
  private var aspectRatioLayout: AspectRatioFrameLayout? = null

  // Reference to the shared FrameLayout root container hosting TextureView and WebView
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
    // Translucent window format allows video composited behind the webview
    // to show through transparent pixels in the WebView canvas.
    // -------------------------------------------------------------------------
    window.setFormat(PixelFormat.TRANSLUCENT)

    // -------------------------------------------------------------------------
    // Intercept System Back Navigation & Gestures
    // -------------------------------------------------------------------------
    // Prevents Tauri's default OnBackPressedCallback from executing
    // webView.goBack(), which bypasses modals and in-page back handlers.
    // -------------------------------------------------------------------------
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        handleHardwareBack()
      }
    })

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
    // 2. Enable Transparent Canvas Mode
    // -------------------------------------------------------------------------
    // Setting background to Color.TRANSPARENT ensures that any transparent
    // CSS elements (.player-page, body.player-active) allow the video
    // beneath the WebView to show through directly to the display controller.
    // We leave layerType default (NONE) rather than forcing LAYER_TYPE_HARDWARE,
    // which in Android 9 / Chromium can create an opaque offscreen bitmap buffer.
    // -------------------------------------------------------------------------
    webView.setBackgroundColor(Color.TRANSPARENT)
    webView.setLayerType(View.LAYER_TYPE_NONE, null)

    // -------------------------------------------------------------------------
    // 3. Register Native Android Bridge Interface
    // -------------------------------------------------------------------------
    // Injects `window.LitefinAndroid` for clean OS exit and device queries.
    // -------------------------------------------------------------------------
    webView.addJavascriptInterface(AndroidBridge(), "LitefinAndroid")

    // -------------------------------------------------------------------------
    // 4. Lock Native Remote Focus to the WebView
    // -------------------------------------------------------------------------
    // On Android TV platforms operating in non-touch D-pad mode, ensure the
    // WebView immediately requests and claims focus so initial key events
    // are directly dispatched to the web runtime rather than lost in native view search.
    // -------------------------------------------------------------------------
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    webView.requestFocus()
  }

  // Reference to whether playback fullscreen mode is currently engaged
  private var isPlayerFullscreen: Boolean = false

  /**
   * Toggles native immersive sticky fullscreen mode.
   * Hides status and navigation bars during video playback on mobile devices.
   */
  fun setFullscreen(fullscreen: Boolean) {
    isPlayerFullscreen = fullscreen
    runOnUiThread {
      try {
        val windowInsetsController = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
        if (fullscreen) {
          windowInsetsController.systemBarsBehavior =
            androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          windowInsetsController.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        } else {
          windowInsetsController.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        }
      } catch (e: Exception) {
        // Fallback legacy flags for older Android versions
        if (fullscreen) {
          @Suppress("DEPRECATION")
          window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
              or View.SYSTEM_UI_FLAG_FULLSCREEN
              or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
              or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
          )
        } else {
          @Suppress("DEPRECATION")
          window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    // Re-assert focus onto the active WebView when resuming from background
    activeWebView?.requestFocus()
    if (isPlayerFullscreen) {
      setFullscreen(true)
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Guarantee that whenever the window regains focus, the WebView has active focus
    if (hasFocus) {
      activeWebView?.requestFocus()
      if (isPlayerFullscreen) {
        setFullscreen(true)
      }
    }
  }

  /**
   * ===========================================================================
   * Intercept setContentView from Tao/Wry
   * ===========================================================================
   * Tao's JNI layer calls `activity.setContentView(webView)`.
   * By intercepting here, we wrap the incoming [WebView] inside our dual-plane
   * [FrameLayout] (with [TextureView] at index 0 and [WebView] at index 1)
   * BEFORE it is attached to the window DecorView, preventing the crash:
   * "The specified child already has a parent. You must call removeView() first."
   * ===========================================================================
   */
  override fun setContentView(view: View?) {
    if (view is WebView) {
      activeWebView = view
      super.setContentView(wrapInSurfaceContainer(view))
    } else {
      super.setContentView(view)
    }
  }

  override fun setContentView(view: View?, params: ViewGroup.LayoutParams?) {
    if (view is WebView) {
      activeWebView = view
      super.setContentView(wrapInSurfaceContainer(view), params)
    } else {
      super.setContentView(view, params)
    }
  }

  /**
   * Constructs the dual-plane layout wrapping [TextureView] behind [WebView].
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

      // Prevent the outer host layout from capturing D-pad focus on TV remotes
      isFocusable = false
      descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
    }

    // -------------------------------------------------------------------------
    // Hardware Video Plane (TextureView inside AspectRatioFrameLayout)
    // -------------------------------------------------------------------------
    // Placed at index 0 (behind WebView at index 1).
    // Uses TextureView for seamless alpha blending with transparent WebView.
    // Wrapped in Media3's AspectRatioFrameLayout to prevent video stretching.
    // -------------------------------------------------------------------------
    val texture = TextureView(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
      // TextureView MUST remain View.VISIBLE at all times so Android creates
      // and maintains its SurfaceTexture for ExoPlayer MediaCodec decoders.
      // Alpha is set to 0f so the canvas is transparent until playback is ready.
      visibility = View.VISIBLE
      alpha = 0f
      // Video decoding canvas must never participate in D-pad focus traversal
      isFocusable = false
    }

    this.textureView = texture

    // Container enforcing native video aspect ratio with centered letterboxing/pillarboxing
    val aspectContainer = AspectRatioFrameLayout(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
        Gravity.CENTER
      )
      // Default to FIT (preserves native movie aspect ratio without stretching)
      resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
      // Block video decoding container from intercepting D-pad directional navigation
      isFocusable = false
      descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
    }
    this.aspectRatioLayout = aspectContainer

    aspectContainer.addView(texture)
    container.addView(aspectContainer)
    container.addView(webView)

    // Ensure the WebView actively claims focus immediately upon view hierarchy attachment
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    webView.requestFocus()

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
      // Reveal Hardware Decoding Plane
      // -----------------------------------------------------------------------
      textureView?.visibility = View.VISIBLE
      textureView?.alpha = 1f
      // Clear container and window backgrounds to allow video decode
      // on the hardware TextureView to show through cleanly to the compositor
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
      // Seamlessly Conceal Video Texture via Alpha
      // -----------------------------------------------------------------------
      // Setting alpha = 0f guarantees the last decoded video frame from the
      // previous movie is completely invisible to the user, while preserving
      // the active SurfaceTexture so ExoPlayer can decode the next stream's
      // first frame immediately without stalling in the NO_SURFACE state.
      // -----------------------------------------------------------------------
      textureView?.alpha = 0f
      // Restore solid pitch black backgrounds for standard navigation UI
      rootContainer?.setBackgroundColor(Color.BLACK)
      window.setBackgroundDrawableResource(android.R.color.black)
    }
  }

  /**
   * Updates target video aspect ratio to preserve geometric proportions.
   */
  fun setVideoAspectRatio(aspectRatio: Float) {
    runOnUiThread {
      aspectRatioLayout?.setAspectRatio(aspectRatio)
    }
  }

  /**
   * Configures video scaling mode: auto (fit), zoom (crop), or stretch (fill).
   */
  fun setResizeMode(mode: String) {
    runOnUiThread {
      val targetMode = when (mode.lowercase()) {
        "zoom" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
        "stretch" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
        else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
      }
      aspectRatioLayout?.resizeMode = targetMode
    }
  }

  /**
   * Cleans up and recreates the hardware TextureView, guaranteeing that
   * the next playback session gets an active, valid SurfaceTexture.
   * Media3 ExoPlayer destroys the underlying SurfaceTexture upon player release;
   * replacing the TextureView in the aspectContainer forces Android to allocate
   * a fresh hardware SurfaceTexture immediately.
   */
  fun resetTextureView() {
    runOnUiThread {
      val current = textureView
      val container = aspectRatioLayout ?: return@runOnUiThread
      if (current != null) {
        container.removeView(current)
      }
      val freshTexture = TextureView(this).apply {
        layoutParams = FrameLayout.LayoutParams(
          FrameLayout.LayoutParams.MATCH_PARENT,
          FrameLayout.LayoutParams.MATCH_PARENT
        )
        visibility = View.VISIBLE
        alpha = 0f
        isFocusable = false
      }
      container.addView(freshTexture, 0)
      this.textureView = freshTexture
    }
  }

  /**
   * Retrieves or recreates a fresh, available [TextureView] instance for ExoPlayer attachment.
   * If the previous TextureView's SurfaceTexture was destroyed upon player release,
   * detaching and re-attaching a fresh TextureView ensures Android allocates a new
   * hardware SurfaceTexture immediately.
   */
  fun getTextureView(): TextureView? {
    val current = textureView
    if (current != null && current.isAvailable && current.surfaceTexture != null) {
      return current
    }

    // Recreate if TextureView has lost its SurfaceTexture
    aspectRatioLayout?.let { container ->
      current?.let { container.removeView(it) }
      val freshTexture = TextureView(this).apply {
        layoutParams = FrameLayout.LayoutParams(
          FrameLayout.LayoutParams.MATCH_PARENT,
          FrameLayout.LayoutParams.MATCH_PARENT
        )
        visibility = View.VISIBLE
        alpha = 0f
        isFocusable = false
      }
      container.addView(freshTexture, 0)
      this.textureView = freshTexture
      return freshTexture
    }

    return current
  }

  /**
   * Backward-compatibility accessor.
   */
  fun getSurfaceView(): android.view.SurfaceView? {
    return null
  }

  /**
   * Retrieve the active [WebView] instance for JS evaluation or bridge registration.
   */
  fun getWebView(): WebView? {
    return activeWebView
  }

  /**
   * ===========================================================================
   * Hardware Remote Key Event Interceptor
   * ===========================================================================
   * Intercepts physical remote control keys from Android TV remotes before
   * they reach the focused WebView.
   *
   * By consuming KeyEvent.KEYCODE_BACK, we prevent Chromium's WebView from
   * natively triggering browser history pop (webView.goBack()), routing it
   * instead through Litefin's centralized eventBus ('key:back').
   * ===========================================================================
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
      if (event.action == KeyEvent.ACTION_UP) {
        handleHardwareBack()
      }
      // Return true for both ACTION_DOWN and ACTION_UP to fully consume
      // the hardware back event and prevent any default browser history navigation.
      return true
    }

    // -------------------------------------------------------------------------
    // Android TV Directional D-Pad Direct Dispatch Guard
    // -------------------------------------------------------------------------
    // If the system window focus ever drifted to the FrameLayout root or DecorView,
    // immediately re-anchor focus to activeWebView so directional keys (Left, Right,
    // Up, Down, Center) are processed directly by Chromium instead of getting consumed
    // by Android ViewGroup native focus search.
    // -------------------------------------------------------------------------
    val webView = activeWebView
    if (webView != null && currentFocus != webView) {
      webView.requestFocus()
    }

    return super.dispatchKeyEvent(event)
  }

  /**
   * Dispatches the hardware back event to the Litefin web application.
   */
  fun handleHardwareBack() {
    runOnUiThread {
      activeWebView?.evaluateJavascript(
        """
        (function() {
          if (window.androidAdapter && typeof window.androidAdapter.handleHardwareBack === 'function') {
            window.androidAdapter.handleHardwareBack();
          } else if (window.eventBus && typeof window.eventBus.emit === 'function') {
            window.eventBus.emit('key:back');
          } else {
            var evt = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true });
            document.dispatchEvent(evt);
          }
        })();
        """.trimIndent(),
        null
      )
    }
  }

  /**
   * ===========================================================================
   * Native Android Application Bridge
   * ===========================================================================
   * Exposes core OS lifecycle and system queries directly to JavaScript via
   * `window.LitefinAndroid`.
   * ===========================================================================
   */
  inner class AndroidBridge {
    /**
     * Terminates the Android application task cleanly.
     */
    @JavascriptInterface
    fun exit() {
      runOnUiThread {
        finishAffinity()
      }
    }

    /**
     * Retrieves the formatted device model string.
     */
    @JavascriptInterface
    fun getDeviceName(): String {
      val manufacturer = android.os.Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
      val model = android.os.Build.MODEL
      return if (model.startsWith(manufacturer, ignoreCase = true)) {
        model
      } else {
        "$manufacturer $model"
      }
    }

    /**
     * Determines whether the host device is an Android TV / Google TV device.
     * Evaluates official Android UiModeManager television state and leanback feature flags.
     */
    @JavascriptInterface
    fun isTv(): Boolean {
      return try {
        val uiModeManager = getSystemService(android.content.Context.UI_MODE_SERVICE) as? android.app.UiModeManager
        val isTelevision = uiModeManager?.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
        val hasLeanback = packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)
        val hasTvFeature = packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_TELEVISION)
        isTelevision || hasLeanback || hasTvFeature
      } catch (e: Exception) {
        false
      }
    }

    /**
     * Toggles native Android immersive fullscreen mode from JavaScript.
     */
    @JavascriptInterface
    fun setFullscreen(fullscreen: Boolean) {
      this@MainActivity.setFullscreen(fullscreen)
    }

    /**
     * Queries hardware decoder support via Android MediaCodecList.
     * Accurately determines if device hardware supports AVC, HEVC, VP9, and AV1.
     */
    @JavascriptInterface
    fun getSupportedVideoCodecs(): String {
      return try {
        // Query list of regular decoders registered with the Android media framework
        val codecList = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS)
        val supportedMimes = mutableSetOf<String>()
        // Iterate available codecs and extract supported video mime types
        for (info in codecList.codecInfos) {
          if (!info.isEncoder) {
            for (type in info.supportedTypes) {
              if (type.startsWith("video/", ignoreCase = true)) {
                supportedMimes.add(type.lowercase())
              }
            }
          }
        }
        // Package findings into JSON payload for profile evaluation
        val result = org.json.JSONObject()
        result.put("h264", supportedMimes.contains("video/avc"))
        result.put("hevc", supportedMimes.contains("video/hevc"))
        result.put("vp9", supportedMimes.contains("video/x-vnd.on2.vp9"))
        result.put("vp8", supportedMimes.contains("video/x-vnd.on2.vp8"))
        result.put("av1", supportedMimes.contains("video/av01"))
        result.put("mpeg2video", supportedMimes.contains("video/mpeg2"))
        result.toString()
      } catch (e: Exception) {
        // Safe fallback for older Android TV devices
        """{"h264":true,"hevc":true,"vp9":true,"vp8":true,"av1":false,"mpeg2video":true}"""
      }
    }

    /**
     * Updates native video aspect ratio mode (auto, zoom, stretch).
     */
    @JavascriptInterface
    fun setAspectRatio(mode: String) {
      setResizeMode(mode)
    }
  }
}
