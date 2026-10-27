package org.litefin.app

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.view.Gravity
import android.view.KeyEvent
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.media3.ui.AspectRatioFrameLayout
import kotlin.math.abs
import kotlin.math.roundToInt

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

  // Reference to the active WebView instance (internal so AndroidLauncherHelper can evaluate JavaScript)
  internal var activeWebView: WebView? = null

  // Reference to the native launcher helper managing Android TV channels and shortcuts
  private val launcherHelper by lazy { AndroidLauncherHelper(this) }

  // Tracks cold-launch deep link payload until claimed by web application
  private var initialDeepLink: String? = null

  // ---------------------------------------------------------------------------
  // Display Mode & Refresh Rate State
  // ---------------------------------------------------------------------------
  // Stores original system display mode prior to auto-matching
  private var originalDisplayModeId: Int = 0

  // Denotes whether a custom display mode was activated during playback
  private var isDisplayModeSwitched: Boolean = false

  /**
   * Encapsulates physical display resolution and refresh rate attributes
   * from Android's DisplayManager subsystem.
   */
  data class DisplayModeInfo(
    val modeId: Int,
    val physicalWidth: Int,
    val physicalHeight: Int,
    val refreshRate: Float
  ) {
    // Refresh rate in thousandths (e.g. 23976 for 23.976 fps, 60000 for 60 fps)
    val refreshRateRounded: Int = (refreshRate * 1000).roundToInt()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    instance = this
    enableEdgeToEdge()

    // -------------------------------------------------------------------------
    // Capture Cold-Boot Deep Link Intent
    // -------------------------------------------------------------------------
    // If Litefin was cold-started from an Android TV Play Next card, preview channel,
    // or mobile dynamic launcher shortcut, extract the target item payload.
    // -------------------------------------------------------------------------
    initialDeepLink = launcherHelper.extractDeepLinkPayload(intent)

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
    // -------------------------------------------------------------------------
    // Set Initial Fullscreen Mode Based on Device Type
    // -------------------------------------------------------------------------
    // Android TV platforms lack status and navigation bars and run locked to
    // immersive fullscreen. Mobile phones and tablets default to non-fullscreen
    // (displaying status bar and navigation bar in safe area) until toggled.
    // -------------------------------------------------------------------------
    val defaultFullscreen = isTvDevice()
    setFullscreen(defaultFullscreen)
  }

  /**
   * ===========================================================================
   * Intercept Warm-Start Deep Link Intents
   * ===========================================================================
   * Triggered when a user taps an Android TV home screen tile or dynamic shortcut
   * while Litefin is already running in the background (singleTask launchMode).
   * ===========================================================================
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // Dispatch new deep-link target directly to running web application
    launcherHelper.handleIncomingIntent(intent)
  }

  override fun onDestroy() {
    // Revert custom display refresh rate and release screen wake lock
    resetDisplayMode()
    setKeepScreenOn(false)
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
    // 4. Lock Native Remote Focus to the WebView & Suppress Default Highlight
    // -------------------------------------------------------------------------
    // On Android TV platforms operating in non-touch D-pad mode, ensure the
    // WebView immediately requests and claims focus so initial key events
    // are directly dispatched to the web runtime rather than lost in native view search.
    // Also disable native OS default focus highlight rectangle on Android 8.0+.
    // -------------------------------------------------------------------------
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      webView.defaultFocusHighlightEnabled = false
    }
    webView.requestFocus()
  }

  // ---------------------------------------------------------------------------
  // Fullscreen State Tracking
  // ---------------------------------------------------------------------------
  // Tracks active OS immersive mode state across activity lifecycle events
  // (pausing, resuming, and window focus changes).
  // ---------------------------------------------------------------------------
  private var isFullscreen: Boolean = false

  /**
   * ===========================================================================
   * Device Form Factor Detection (Television vs Mobile/Tablet)
   * ===========================================================================
   * Evaluates system UI mode manager and package manager Leanback/TV feature
   * flags to reliably identify Android TV / Google TV hardware.
   * ===========================================================================
   */
  fun isTvDevice(): Boolean {
    return try {
      // Query system UI mode manager for dedicated television mode configuration
      val uiModeManager = getSystemService(android.content.Context.UI_MODE_SERVICE) as? android.app.UiModeManager
      val isTelevision = uiModeManager?.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
      
      // Check package manager hardware feature tokens
      val hasLeanback = packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)
      val hasTvFeature = packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_TELEVISION)
      
      isTelevision || hasLeanback || hasTvFeature
    } catch (e: Exception) {
      false
    }
  }

  /**
   * ===========================================================================
   * Native Android Fullscreen & System Inset Manager
   * ===========================================================================
   * Controls system status and navigation bar visibility:
   * - When fullscreen is true:
   *   Hides system bars using transient swipe gestures and extends layout
   *   edge-to-edge across the physical display.
   * - When fullscreen is false:
   *   Reveals status bar and navigation bar while enforcing window insets
   *   via setDecorFitsSystemWindows(true) to keep content within the safe zone.
   * ===========================================================================
   * @param fullscreen True for edge-to-edge fullscreen; false for safe zone layout.
   */
  fun setFullscreen(fullscreen: Boolean = true) {
    isFullscreen = fullscreen
    runOnUiThread {
      try {
        // Modern WindowInsetsControllerCompat implementation (Android 11+ / API 30+)
        val windowInsetsController = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
        
        if (fullscreen) {
          // Configure transient gesture bars that auto-hide after swipe interactions
          windowInsetsController.systemBarsBehavior =
            androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          
          // Hide both top status bar and bottom navigation bar
          windowInsetsController.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
          
          // Expand window decor to full physical screen boundaries
          androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        } else {
          // Restore standard system bars (status bar + gesture/button navigation bar)
          windowInsetsController.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
          
          // Confine content layout to system safe zone between status bar and nav bar
          androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, true)
        }
      } catch (e: Exception) {
        // Fallback flags for older Android API levels
        @Suppress("DEPRECATION")
        if (fullscreen) {
          window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
              or View.SYSTEM_UI_FLAG_FULLSCREEN
              or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
              or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
          )
        } else {
          window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    // Re-assert focus onto active WebView when resuming from background
    activeWebView?.requestFocus()
    // Synchronize fullscreen state to current configuration
    setFullscreen(isFullscreen)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Maintain active WebView focus and ensure system bars match user preference
    if (hasFocus) {
      activeWebView?.requestFocus()
      setFullscreen(isFullscreen)
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
      // Prevent Android system screensaver / display sleep during active playback
      setKeepScreenOn(true)
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
      // Clear keep-screen-on flag once video plane is hidden
      setKeepScreenOn(false)
    }
  }

  /**
   * ===========================================================================
   * Screen Wake Lock / Keep-Awake Flag Management
   * ===========================================================================
   * Toggles Android OS WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON and the
   * container's keepScreenOn property on the UI thread.
   *
   * By keeping the screen on at the window and view level during media playback,
   * this prevents Android TV ambient mode, Daydream, and device sleep timeouts
   * (typically 15 minutes of inactivity) from interrupting movie watching.
   *
   * @param keepOn When true, locks display awake. When false, restores system timers.
   * ===========================================================================
   */
  fun setKeepScreenOn(keepOn: Boolean) {
    runOnUiThread {
      try {
        // Guard against window manipulation if activity is already finishing
        if (isFinishing || isDestroyed) {
          return@runOnUiThread
        }
        if (keepOn) {
          // Engage OS window flag keeping display illuminated without sleep/screensaver
          window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          // Dual guarantee: set view keepScreenOn flag on root container
          rootContainer?.keepScreenOn = true
        } else {
          // Clear window flag allowing system screensaver and sleep timer to resume
          window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          // Clear view keepScreenOn flag on root layout
          rootContainer?.keepScreenOn = false
        }
      } catch (e: Exception) {
        android.util.Log.w("MainActivity", "Failed updating keepScreenOn flag: ${e.message}")
      }
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

  // ===========================================================================
  // Hardware Display Refresh Rate & Mode Matching
  // ===========================================================================

  /**
   * Switches the window preferred display mode ID directly on the main UI thread.
   * Prompts the Android TV display subsystem and HDMI eARC/CEC controller
   * to adapt physical frame rates without 3:2 pulldown judder.
   *
   * @param modeId Target display mode identifier from Display.getMode().
   */
  fun changeDisplayMode(modeId: Int) {
    runOnUiThread {
      try {
        if (isFinishing || isDestroyed) {
          return@runOnUiThread
        }
        val attrs = window.attributes
        if (attrs.preferredDisplayModeId != modeId) {
          // Cache default mode before first switch
          if (!isDisplayModeSwitched) {
            originalDisplayModeId = attrs.preferredDisplayModeId
          }
          android.util.Log.i("MainActivity", "changeDisplayMode: modeId=$modeId (previous=${attrs.preferredDisplayModeId})")
          attrs.preferredDisplayModeId = modeId
          window.attributes = attrs
          isDisplayModeSwitched = (modeId != 0 && modeId != originalDisplayModeId)
        }
      } catch (e: Exception) {
        android.util.Log.w("MainActivity", "Failed changing display mode to $modeId: ${e.message}")
      }
    }
  }

  /**
   * Restores original display mode when media playback stops or the player is released.
   */
  fun resetDisplayMode() {
    runOnUiThread {
      try {
        if (isFinishing || isDestroyed) {
          return@runOnUiThread
        }
        if (isDisplayModeSwitched) {
          val attrs = window.attributes
          android.util.Log.i("MainActivity", "resetDisplayMode: restoring default mode ($originalDisplayModeId)")
          attrs.preferredDisplayModeId = originalDisplayModeId
          window.attributes = attrs
          isDisplayModeSwitched = false
        }
      } catch (e: Exception) {
        android.util.Log.w("MainActivity", "Failed resetting display mode: ${e.message}")
      }
    }
  }

  /**
   * Selects and applies the best physical display mode matching the stream frame rate and resolution.
   *
   * @param streamWidth Physical pixel width of video stream.
   * @param streamHeight Physical pixel height of video stream.
   * @param targetFrameRate Media frame rate (e.g., 23.976, 24, 25, 29.97, 50, 59.94, 60).
   * @return True if a matching display mode was identified and applied.
   */
  fun matchDisplayMode(streamWidth: Int, streamHeight: Int, targetFrameRate: Float): Boolean {
    if (targetFrameRate <= 0f) {
      return false
    }

    try {
      val displayManager = getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager ?: return false
      val display = displayManager.getDisplay(Display.DEFAULT_DISPLAY) ?: return false
      val supportedModes = display.supportedModes ?: return false

      // Wrap raw display modes in helper objects
      val modes = supportedModes.map { mode ->
        DisplayModeInfo(
          modeId = mode.modeId,
          physicalWidth = mode.physicalWidth,
          physicalHeight = mode.physicalHeight,
          refreshRate = mode.refreshRate
        )
      }

      val streamRate = (targetFrameRate * 1000).roundToInt()
      val currentMode = display.mode

      // 1. Filter modes that satisfy the video stream resolution without downscaling
      val sizeFiltered = modes.filter { mode ->
        streamWidth <= 0 || streamHeight <= 0 || (mode.physicalWidth >= streamWidth && mode.physicalHeight >= streamHeight)
      }.ifEmpty { modes }

      // 2. Filter modes matching the target frame rate cadence
      val candidates = sizeFiltered.filter { mode ->
        frameRateMatches(mode.refreshRateRounded, streamRate)
      }.ifEmpty { sizeFiltered }

      // 3. Find target mode: exact frame rate match preferred, otherwise highest resolution
      val targetMode = candidates.firstOrNull { mode ->
        mode.refreshRateRounded == streamRate &&
        (streamWidth <= 0 || (mode.physicalWidth == streamWidth && mode.physicalHeight == streamHeight))
      } ?: candidates.filter { mode ->
        mode.refreshRateRounded == streamRate
      }.maxByOrNull { mode ->
        mode.physicalWidth * mode.physicalHeight
      } ?: candidates.maxByOrNull { mode ->
        mode.physicalWidth * mode.physicalHeight
      }

      if (targetMode != null && targetMode.modeId != currentMode.modeId) {
        changeDisplayMode(targetMode.modeId)
        return true
      }
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "Failed matching display mode: ${e.message}")
    }

    return false
  }

  /**
   * Determines if display refresh rate cadence is compatible with the video stream frame rate.
   */
  private fun frameRateMatches(modeRate: Int, streamRate: Int): Boolean {
    if (streamRate <= 0) return false
    // Exact multiple (e.g., 24fps -> 24Hz, 48Hz, 120Hz; 25fps -> 50Hz, 100Hz; 30fps -> 60Hz, 120Hz)
    if (modeRate % streamRate == 0) return true
    // 2.5x cadence (e.g., 24fps -> 60Hz)
    if (modeRate == (streamRate * 2.5).roundToInt()) return true
    // Fractional tolerance (e.g. 23.976 vs 24.000 or 59.94 vs 60.000)
    if (abs(modeRate - streamRate) <= 50) return true
    // Multiple of rounded integer frame rate
    val intStreamRate = ((streamRate + 500) / 1000) * 1000
    if (intStreamRate > 0 && modeRate % intStreamRate == 0) return true
    return false
  }

  /**
   * Queries connected display panel and serializes available modes to JSON.
   */
  fun getSupportedDisplayModesJson(): String {
    return try {
      val displayManager = getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
      val display = displayManager?.getDisplay(Display.DEFAULT_DISPLAY)
      val supportedModes = display?.supportedModes ?: emptyArray()
      val array = org.json.JSONArray()
      for (mode in supportedModes) {
        val obj = org.json.JSONObject().apply {
          put("modeId", mode.modeId)
          put("width", mode.physicalWidth)
          put("height", mode.physicalHeight)
          put("refreshRate", mode.refreshRate)
        }
        array.put(obj)
      }
      array.toString()
    } catch (e: Exception) {
      "[]"
    }
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
    // -------------------------------------------------------------------------
    // 1. Hardware Back Interception
    // -------------------------------------------------------------------------
    // Consumes Android back button to drive unified web-level routing and modal dismissal,
    // preventing Chromium from performing an unintended window history navigation.
    // -------------------------------------------------------------------------
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
      if (event.action == KeyEvent.ACTION_UP) {
        handleHardwareBack()
      }
      return true
    }

    // -------------------------------------------------------------------------
    // 2. Hardware TV Remote Contextual Color Buttons (Red, Green, Yellow, Blue)
    // -------------------------------------------------------------------------
    // Physical TV remotes (TCL, Philips, Sony, Panasonic) feature 4 programmable
    // contextual color keys. Chromium's WebView often swallows or misidentifies
    // these keycodes. By intercepting them natively in dispatchKeyEvent, we ensure
    // they are dispatched cleanly to Litefin's RemoteButtonManager and OSD without drops.
    // -------------------------------------------------------------------------
    when (event.keyCode) {
      KeyEvent.KEYCODE_PROG_RED -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleColorButton("red")
        }
        return true
      }
      KeyEvent.KEYCODE_PROG_GREEN -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleColorButton("green")
        }
        return true
      }
      KeyEvent.KEYCODE_PROG_YELLOW -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleColorButton("yellow")
        }
        return true
      }
      KeyEvent.KEYCODE_PROG_BLUE -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleColorButton("blue")
        }
        return true
      }
    }

    // -------------------------------------------------------------------------
    // 3. Television Function & Utility Shortcuts
    // -------------------------------------------------------------------------
    // Captures remote keys for subtitles (captions), display info, electronic program
    // guide (EPG), bookmarks, and channel stepping.
    // -------------------------------------------------------------------------
    when (event.keyCode) {
      KeyEvent.KEYCODE_CAPTIONS -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleTvShortcut("captions")
        }
        return true
      }
      KeyEvent.KEYCODE_INFO -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleTvShortcut("info")
        }
        return true
      }
      KeyEvent.KEYCODE_GUIDE -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleTvShortcut("guide")
        }
        return true
      }
      KeyEvent.KEYCODE_BOOKMARK -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleTvShortcut("bookmark")
        }
        return true
      }
      KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleTvShortcut("channelUp")
        }
        return true
      }
      KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> {
        if (event.action == KeyEvent.ACTION_UP) {
          handleTvShortcut("channelDown")
        }
        return true
      }
    }

    // -------------------------------------------------------------------------
    // 4. Physical Remote Media Playback Controls
    // -------------------------------------------------------------------------
    // When native ExoPlayer is active, Media3 MediaSession automatically handles
    // OS media events. If ExoPlayer is not active (e.g. user is browsing cards
    // on the home screen or web audio is playing), forward the media transport
    // command directly to the web layer so quick play or cards act accordingly.
    // -------------------------------------------------------------------------
    val isExoActive = ExoPlayerPlugin.instance?.hasActivePlayer() == true
    if (!isExoActive) {
      val mediaCmd = when (event.keyCode) {
        KeyEvent.KEYCODE_MEDIA_PLAY -> "play"
        KeyEvent.KEYCODE_MEDIA_PAUSE -> "pause"
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> "playPause"
        KeyEvent.KEYCODE_MEDIA_STOP -> "stop"
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_STEP_FORWARD, KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD -> "fastForward"
        KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_STEP_BACKWARD, KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD -> "rewind"
        KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "previous"
        else -> null
      }
      if (mediaCmd != null) {
        if (event.action == KeyEvent.ACTION_UP) {
          handleMediaCommand(mediaCmd)
        }
        return true
      }
    }

    // -------------------------------------------------------------------------
    // 5. Android TV Directional D-Pad Direct Dispatch Guard
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
   * Dispatches a contextual remote color button event to the Litefin frontend.
   *
   * @param color Normalized color name ("red", "green", "yellow", "blue").
   */
  fun handleColorButton(color: String) {
    runOnUiThread {
      activeWebView?.evaluateJavascript(
        """
        (function() {
          if (window.androidAdapter && typeof window.androidAdapter.handleColorButton === 'function') {
            window.androidAdapter.handleColorButton('$color');
          } else if (typeof window.__litefinAndroidColorButton === 'function') {
            window.__litefinAndroidColorButton('$color');
          } else if (window.eventBus && typeof window.eventBus.emit === 'function') {
            window.eventBus.emit('key:$color', { source: 'native-remote' });
          }
        })();
        """.trimIndent(),
        null
      )
    }
  }

  /**
   * Dispatches a media transport command to the Litefin frontend.
   *
   * @param command Normalized transport command ("play", "pause", "playPause", "rewind", "fastForward", "stop", "next", "previous").
   */
  fun handleMediaCommand(command: String) {
    runOnUiThread {
      activeWebView?.evaluateJavascript(
        """
        (function() {
          if (window.androidAdapter && typeof window.androidAdapter.handleMediaCommand === 'function') {
            window.androidAdapter.handleMediaCommand('$command');
          } else if (typeof window.__litefinAndroidMediaCommand === 'function') {
            window.__litefinAndroidMediaCommand('$command');
          } else if (window.eventBus && typeof window.eventBus.emit === 'function') {
            window.eventBus.emit('key:$command', { source: 'native-media-bridge' });
          }
        })();
        """.trimIndent(),
        null
      )
    }
  }

  /**
   * Dispatches a TV shortcut key event to the Litefin frontend.
   *
   * @param shortcut Action identifier ("captions", "info", "guide", "bookmark", "channelUp", "channelDown").
   */
  fun handleTvShortcut(shortcut: String) {
    runOnUiThread {
      activeWebView?.evaluateJavascript(
        """
        (function() {
          if (window.eventBus && typeof window.eventBus.emit === 'function') {
            window.eventBus.emit('key:$shortcut', { source: 'native-remote' });
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
      // Delegate to centralized activity device check
      return this@MainActivity.isTvDevice()
    }

    /**
     * =========================================================================
     * Fullscreen Bridge Dispatcher
     * =========================================================================
     * Controls native OS immersive mode and system bar visibility dynamically
     * based on user preference or player lifecycle state.
     * =========================================================================
     */
    @JavascriptInterface
    fun setFullscreen(fullscreen: Boolean) {
      // Pass requested boolean state to main activity window insets manager
      this@MainActivity.setFullscreen(fullscreen)
    }

    /**
     * =========================================================================
     * Keep Screen Awake Bridge Interface
     * =========================================================================
     * Controls native screen wake lock to keep the display awake during video playback.
     * Prevents the Android system screensaver (Ambient Mode, Daydream) from activating.
     *
     * @param keepOn True to prevent display sleep/screensaver, false to restore defaults.
     * =========================================================================
     */
    @JavascriptInterface
    fun setKeepScreenOn(keepOn: Boolean) {
      this@MainActivity.setKeepScreenOn(keepOn)
    }

    /**
     * =========================================================================
     * Hardware Video Decoder Capability Probe
     * =========================================================================
     * Queries registered decoders via Android MediaCodecList to determine genuine
     * hardware decoding support for AVC, HEVC, VP9, VP8, AV1, MPEG-2, and VC-1.
     *
     * Prevents playback black-screens on mobile chipsets that lack MPEG-2 or VC-1
     * decoders (e.g. where c2.android.mpeg2.decoder is restricted to the TV domain).
     * =========================================================================
     */
    @JavascriptInterface
    fun getSupportedVideoCodecs(): String {
      return try {
        // Query list of regular decoders registered with the Android media framework
        val codecList = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS)
        val supportedMimes = mutableSetOf<String>()

        // Iterate available codecs and extract supported video mime types
        for (info in codecList.codecInfos) {
          // Exclude encoders to ensure only decoder profiles are evaluated
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
        result.put("mpeg2video", supportedMimes.contains("video/mpeg2") || supportedMimes.contains("video/mp2v"))

        // Probe standard Android VC-1 mime type (video/wvc1) as well as vendor aliases
        val hasVc1 = supportedMimes.contains("video/wvc1") ||
                     supportedMimes.contains("video/x-ms-wmv") ||
                     supportedMimes.contains("video/vc1")
        result.put("vc1", hasVc1)

        result.toString()
      } catch (e: Exception) {
        // Evaluate television hardware classification to configure safe fallback defaults
        // Android TV boxes standardly support MPEG-2 decode, whereas phones frequently lack it
        val isTv = try { this@MainActivity.isTvDevice() } catch (_: Exception) { false }
        val mpeg2Default = isTv

        """{"h264":true,"hevc":true,"vp9":true,"vp8":true,"av1":false,"mpeg2video":$mpeg2Default,"vc1":false}"""
      }
    }

    /**
     * Updates native video aspect ratio mode (auto, zoom, stretch).
     */
    @JavascriptInterface
    fun setAspectRatio(mode: String) {
      setResizeMode(mode)
    }

    /**
     * Controls native screen orientation dynamically.
     * Used by mobile layouts to lock landscape mode during video playback
     * and seamlessly restore natural sensor auto-rotation upon exit.
     *
     * @param orientation String indicating target mode ("landscape", "portrait", "auto")
     */
    @JavascriptInterface
    fun setOrientation(orientation: String) {
      // Execute orientation adjustment directly on the main UI thread
      runOnUiThread {
        try {
          // TV and Leanback platforms have fixed physical landscape displays
          if (isTv()) {
            return@runOnUiThread
          }

          // Evaluate requested target orientation
          when (orientation.lowercase()) {
            "landscape", "sensorlandscape" -> {
              // Lock activity to sensor-aware landscape orientation
              this@MainActivity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            }
            "portrait", "sensorportrait" -> {
              // Lock activity to sensor-aware portrait orientation
              this@MainActivity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            }
            "auto", "unspecified", "user" -> {
              // Restore default sensor-driven auto-rotation
              this@MainActivity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            else -> {
              // Safe fallback to unspecified system auto-rotation
              this@MainActivity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
          }
        } catch (e: Exception) {
          // Suppress potential security or window manager exceptions gracefully
        }
      }
    }

    /**
     * =========================================================================
     * Android TV Home Screen & Mobile Shortcuts Integration
     * =========================================================================
     * Syncs Continue Watching and Next Up rows to Android TV Watch Next (Play Next),
     * Preview Channels, and dynamic mobile shortcuts.
     * =========================================================================
     */
    @JavascriptInterface
    fun updateLauncherPrograms(programsJson: String) {
      launcherHelper.updatePrograms(programsJson)
    }

    /**
     * Clears all published launcher programs on logout.
     */
    @JavascriptInterface
    fun clearLauncherPrograms() {
      launcherHelper.clearPrograms()
    }

    /**
     * Retrieves any cold-boot deep-link target waiting from activity launch.
     */
    @JavascriptInterface
    fun getInitialDeepLink(): String? {
      val payload = initialDeepLink
      initialDeepLink = null
      return payload
    }

    /**
     * Matches connected display panel refresh rate and resolution to video stream parameters.
     */
    @JavascriptInterface
    fun setRefreshRate(frameRate: Float, width: Int, height: Int): Boolean {
      return this@MainActivity.matchDisplayMode(width, height, frameRate)
    }

    /**
     * Restores default system display refresh rate and resolution.
     */
    @JavascriptInterface
    fun resetRefreshRate(): Boolean {
      this@MainActivity.resetDisplayMode()
      return true
    }

    /**
     * Queries connected display panel supported resolution and refresh rate modes.
     */
    @JavascriptInterface
    fun getSupportedDisplayModes(): String {
      return this@MainActivity.getSupportedDisplayModesJson()
    }
  }
}

