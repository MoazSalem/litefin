package org.litefin.app

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.TsExtractor
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import androidx.media3.session.MediaSession
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * =============================================================================
 * Litefin - Media3 ExoPlayer Native Tauri Plugin
 * =============================================================================
 * Bridges Google Media3 ExoPlayer hardware-accelerated playback with Litefin's
 * frontend via Tauri v2 plugin IPC and direct WebView event channels.
 *
 * Architecture & Features:
 * - Direct Play of MKV, MP4, WebM, and TS containers using native MediaCodec decoders.
 * - Hardware video decoding rendering to a zero-copy [android.view.SurfaceView].
 * - Full support for multi-channel audio tracks (AC-3, E-AC-3, TrueHD, DTS, Opus, FLAC).
 * - Real-time playback event bus delivering time updates (250ms cadence), track
 *   metadata, video dimensions, and player state transitions.
 * - Dual communication architecture: standard Tauri @Command invoke channels alongside
 *   a high-throughput @JavascriptInterface bridge for zero-overhead polling.
 * =============================================================================
 */
@TauriPlugin
@OptIn(UnstableApi::class)
class ExoPlayerPlugin(private val activity: Activity) : Plugin(activity) {

  companion object {
    /**
     * Centralized singleton reference allowing MainActivity and other native components
     * to check player state or dispatch media transport events.
     */
    @Volatile
    var instance: ExoPlayerPlugin? = null
      private set
  }

  init {
    // Retain active plugin singleton instance upon initialization
    instance = this
  }

  // ---------------------------------------------------------------------------
  // Core Media3 Components
  // ---------------------------------------------------------------------------
  // The primary Media3 ExoPlayer playback engine
  private var player: ExoPlayer? = null

  // Native Android MediaSession bridging ExoPlayer to OS transport controls & tvQuickActions
  private var mediaSession: MediaSession? = null

  // Custom track selector enabling fine-grained audio stream switching
  private var trackSelector: DefaultTrackSelector? = null

  // Queued audio track index to be applied once media tracks are demuxed
  private var pendingAudioTrackIndex: Int? = null

  // Reusable OkHttpClient configured with optimized connection timeouts and socket retry
  private val okHttpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()
  }

  // ---------------------------------------------------------------------------
  // Time Update & Periodic Polling Loop
  // ---------------------------------------------------------------------------
  // Main-thread handler driving the 250ms playback progress heartbeat
  private val mainHandler = Handler(Looper.getMainLooper())

  // Runnable broadcasting current position, duration, and buffered ranges
  // Progress updates are gated so that during initial startup or resume seeks
  // (STATE_BUFFERING), premature progress events are never dispatched to the WebView.
  private val progressHeartbeatRunnable = object : Runnable {
    override fun run() {
      val exo = player ?: return
      // Gate progress emission strictly to active ready playback
      // Avoids misleading time-updates while the hardware pipeline buffers media
      if (exo.playbackState == Player.STATE_READY && exo.playWhenReady) {
        emitProgressUpdate()
      }
      // Re-schedule the heartbeat loop at 250ms cadence while player is active
      if (exo.playbackState != Player.STATE_ENDED && exo.playbackState != Player.STATE_IDLE) {
        mainHandler.postDelayed(this, 250L)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Direct WebView Reference for Reliable Event Dispatching
  // ---------------------------------------------------------------------------
  private var pluginWebView: android.webkit.WebView? = null

  // ---------------------------------------------------------------------------
  // Plugin Lifecycle Initialization
  // ---------------------------------------------------------------------------
  override fun load(webView: android.webkit.WebView) {
    super.load(webView)
    this.pluginWebView = webView

    // Register synchronous / direct JavaScript bridge onto the WebView
    activity.runOnUiThread {
      webView.addJavascriptInterface(DirectPlayerBridge(), "LitefinExoPlayer")
    }
  }

  @Volatile
  private var isTunnelingEnabled: Boolean = false

  @Volatile
  private var isAudioOffloadEnabled: Boolean = true

  /**
   * Applies hardware tunneling and audio offload parameters to the track selector.
   *
   * Tunneled video playback offloads audio-to-video clock synchronization directly
   * to the hardware video decoder/SoC display pipeline, dramatically reducing CPU
   * scheduling latency, jitter, and dropped frames on 4K/HDR Android TV devices.
   *
   * Audio offload directs compressed or PCM audio streams directly to a dedicated
   * hardware DSP/audio processor to reduce CPU power consumption and eliminate
   * audio buffer under-runs during heavy decoding workloads.
   */
  private fun applyTrackSelectorParameters(
    selector: DefaultTrackSelector,
    tunneling: Boolean,
    audioOffload: Boolean
  ) {
    val builder = selector.buildUponParameters()
      .setTunnelingEnabled(tunneling)

    if (audioOffload) {
      builder.setAudioOffloadPreferences(
        TrackSelectionParameters.AudioOffloadPreferences.DEFAULT.buildUpon()
          .setAudioOffloadMode(TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED)
          .build()
      )
    } else {
      builder.setAudioOffloadPreferences(
        TrackSelectionParameters.AudioOffloadPreferences.DEFAULT.buildUpon()
          .setAudioOffloadMode(TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_DISABLED)
          .build()
      )
    }
    selector.setParameters(builder)
  }

  /**
   * Builds an extractors factory tailored to the device memory capabilities.
   * Enables Constant Bitrate (CBR) seeking for accurate seeking in streams without
   * index tables, and expands MPEG-TS timestamp search buffer to 3x default
   * (TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES * 3) on standard memory hardware.
   */
  private fun createExtractorsFactory(): DefaultExtractorsFactory {
    val activityManager = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    val isLowRamDevice = activityManager?.isLowRamDevice == true
    return DefaultExtractorsFactory().apply {
      setConstantBitrateSeekingEnabled(true)
      setConstantBitrateSeekingAlwaysEnabled(true)
      setTsExtractorTimestampSearchBytes(
        if (isLowRamDevice) TsExtractor.TS_PACKET_SIZE * 1800
        else TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES * 3
      )
    }
  }

  /**
   * ===========================================================================
   * High-Performance Renderers Factory for Android TV and Touch Panels
   * ===========================================================================
   * Customizes Media3 renderer creation to resolve hardware decoder latency and
   * stream startup issues on television chipsets and Android 14+ devices:
   *
   * 1. Late Frame Drop Threshold (C.TIME_UNSET):
   *    Prevents MediaCodecVideoRenderer from discarding video frames when stream
   *    startup or network buffering causes a momentary pipeline lag. By default,
   *    ExoPlayer drops late decoder input buffers, which manifests as stutter or
   *    dropped frames at the beginning of 4K UHD and HDR10 content. Setting this
   *    threshold to C.TIME_UNSET forces decoders to process every frame cleanly.
   *
   * 2. Android 14 (API 34+) MediaCodec Decode-Only Flag Workaround:
   *    Android 14 introduced an OS-level flag (BUFFER_FLAG_DECODE_ONLY) in MediaCodec.
   *    Certain vendor hardware decoder implementations (e.g., Amlogic, Realtek, MediaTek)
   *    mishandle this flag during seeks, causing output surface freezes or permanent
   *    black screens. Explicitly disabling this flag stabilizes playback on Android 14.
   *
   * 3. AV1 Sample Dependency Bypass:
   *    Skips sample dependency parsing for AV1 streams, reducing demuxing thread
   *    overhead and speeding up keyframe acquisition.
   *
   * 4. Software Decoder Fallback (Libdav1dVideoRenderer):
   *    Reflectively checks for and registers libdav1d software decoding if the native
   *    platform lacks hardware AV1 decoders.
   * ===========================================================================
   */
  @OptIn(UnstableApi::class)
  private class LitefinRenderersFactory(
    context: Context
  ) : DefaultRenderersFactory(context) {

    @OptIn(UnstableApi::class)
    override fun buildVideoRenderers(
      context: Context,
      extensionRendererMode: Int,
      mediaCodecSelector: MediaCodecSelector,
      enableDecoderFallback: Boolean,
      eventHandler: Handler,
      eventListener: VideoRendererEventListener,
      allowedVideoJoiningTimeMs: Long,
      out: ArrayList<Renderer>
    ) {
      // -----------------------------------------------------------------------
      // Primary Hardware Video Decoder Construction
      // -----------------------------------------------------------------------
      // Configures MediaCodecVideoRenderer with low-latency and jitter-tolerant
      // settings for smooth 4K/60fps and HDR video streams.
      var videoRendererBuilder = MediaCodecVideoRenderer.Builder(context)
        .setMediaCodecSelector(mediaCodecSelector)
        .setAllowedJoiningTimeMs(allowedVideoJoiningTimeMs)
        .setEnableDecoderFallback(enableDecoderFallback)
        .setEventHandler(eventHandler)
        .setEventListener(eventListener)
        .setMaxDroppedFramesToNotify(50)
        // Skip redundant AV1 sample dependency parsing overhead
        .experimentalSetParseAv1SampleDependencies(false)
        // Never drop decoder input buffers due to late arrival during spin-up
        .experimentalSetLateThresholdToDropDecoderInputUs(C.TIME_UNSET)

      // -----------------------------------------------------------------------
      // Android 14 (API 34+) Decode-Only Buffer Bug Workaround
      // -----------------------------------------------------------------------
      // Avoids black screen and frame freeze regressions on Android 14 TV boxes
      if (Build.VERSION.SDK_INT >= 34) {
        videoRendererBuilder = videoRendererBuilder
          .experimentalSetEnableMediaCodecBufferDecodeOnlyFlag(false)
      }

      // Append primary hardware-accelerated renderer to the renderer chain
      out.add(videoRendererBuilder.build())

      // If software extensions are turned off, exit early without checking fallback decoders
      if (extensionRendererMode == EXTENSION_RENDERER_MODE_OFF) {
        return
      }

      var extensionRendererIndex = out.size
      if (extensionRendererMode == EXTENSION_RENDERER_MODE_PREFER) {
        extensionRendererIndex--
      }

      try {
        val clazz = Class.forName("androidx.media3.decoder.av1.Libdav1dVideoRenderer")
        val constructor = clazz.getConstructor(
          Long::class.javaPrimitiveType,
          Handler::class.java,
          VideoRendererEventListener::class.java,
          Int::class.javaPrimitiveType
        )
        val renderer = constructor.newInstance(
          allowedVideoJoiningTimeMs,
          eventHandler,
          eventListener,
          50
        ) as Renderer
        out.add(extensionRendererIndex++, renderer)
      } catch (_: Exception) { }
    }
  }

  /**
   * Initializes or returns the existing Media3 ExoPlayer instance on the main thread.
   */
  private fun ensurePlayer(): ExoPlayer {
    player?.let { existing ->
      MainActivity.instance?.getTextureView()?.let { textureView ->
        existing.setVideoTextureView(textureView)
      }
      // Guarantee MediaSession remains active for existing player instance
      ensureMediaSession(existing)
      return existing
    }

    val selector = DefaultTrackSelector(activity)
    this.trackSelector = selector
    applyTrackSelectorParameters(selector, isTunnelingEnabled, isAudioOffloadEnabled)

    // -------------------------------------------------------------------------
    // Configure Media3 LitefinRenderersFactory with Extension Fallback
    // -------------------------------------------------------------------------
    // Configures the playback pipeline to prioritize native MediaCodec hardware
    // decoders for maximum energy efficiency, lower latency, and HDMI passthrough.
    //
    // If the underlying Android device lacks native decoding support or passthrough
    // for proprietary surround sound bitstreams (e.g. AC-3, E-AC-3, DTS, DTS-HD,
    // and TrueHD), DefaultRenderersFactory automatically falls back to software
    // decoding via the FfmpegAudioRenderer extension.
    //
    // Setting enableDecoderFallback to true guarantees that if a hardware decoder
    // initializes but faults during playback, ExoPlayer immediately falls back to
    // software rendering instead of dropping audio or failing playback.
    // -------------------------------------------------------------------------
    val renderersFactory = LitefinRenderersFactory(activity)
      .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
      .setEnableDecoderFallback(true)

    // -------------------------------------------------------------------------
    // Instantiate ExoPlayer with Movie Audio Attributes and Network Wake Lock
    // -------------------------------------------------------------------------
    // USAGE_MEDIA + CONTENT_TYPE_MOVIE directs Android audio policy to treat
    // the stream as cinema content, properly routing surround sound (5.1/7.1)
    // to external soundbars/AVRs via HDMI eARC and preserving full dynamic range.
    //
    // Enabling audio focus management (true) guarantees smooth ducking and
    // pausing when system notifications or voice assistants interrupt.
    //
    // WAKE_MODE_NETWORK prevents the OS power manager from sleeping the CPU
    // or throttling the Wi-Fi radio during long, high-bitrate 4K streaming sessions.
    // -------------------------------------------------------------------------
    val audioAttributes = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
      .build()

    val newPlayer = ExoPlayer.Builder(activity, renderersFactory)
      .setTrackSelector(selector)
      .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()

    // -------------------------------------------------------------------------
    // Connect Native Media3 MediaSession
    // -------------------------------------------------------------------------
    // Registers ExoPlayer with Android OS MediaSessionManager.
    // Enables physical TV remote transport keys (Play/Pause/Rewind/FF) and
    // external accessibility mappers like tvQuickActions to control playback.
    // -------------------------------------------------------------------------
    ensureMediaSession(newPlayer)

    // -------------------------------------------------------------------------
    // Bind Hardware TextureView
    // -------------------------------------------------------------------------
    // Connect player output to the TextureView hosted behind the transparent WebView.
    // Unlike SurfaceView, TextureView composites seamlessly with the Android View tree.
    MainActivity.instance?.getTextureView()?.let { textureView ->
      newPlayer.setVideoTextureView(textureView)
    }

    // -------------------------------------------------------------------------
    // Register Media3 Player Event Listeners
    // -------------------------------------------------------------------------
    newPlayer.addListener(object : Player.Listener {

      override fun onPlaybackStateChanged(playbackState: Int) {
        val stateName = when (playbackState) {
          Player.STATE_IDLE -> "idle"
          Player.STATE_BUFFERING -> "buffering"
          Player.STATE_READY -> "ready"
          Player.STATE_ENDED -> "ended"
          else -> "unknown"
        }

        val payload = JSObject().apply {
          put("state", stateName)
          put("playWhenReady", newPlayer.playWhenReady)
        }

        dispatchNativeEvent("exoplayer://playback-state", payload)

        if (playbackState == Player.STATE_READY && newPlayer.playWhenReady) {
          MainActivity.instance?.showVideoSurface()
          MainActivity.instance?.setKeepScreenOn(true)
          startProgressHeartbeat()
        } else if (playbackState == Player.STATE_ENDED || playbackState == Player.STATE_IDLE) {
          stopProgressHeartbeat()
          MainActivity.instance?.setKeepScreenOn(false)
          MainActivity.instance?.hideVideoSurface()
          MainActivity.instance?.resetDisplayMode()
        }
      }

      override fun onRenderedFirstFrame() {
        // Guarantee video surface is revealed the instant the first decoded frame is ready
        MainActivity.instance?.showVideoSurface()
        MainActivity.instance?.setKeepScreenOn(true)
        dispatchNativeEvent("exoplayer://first-frame", JSObject())
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        val payload = JSObject().apply {
          put("isPlaying", isPlaying)
          put("positionMs", newPlayer.currentPosition)
        }
        dispatchNativeEvent("exoplayer://playback-state", payload)

        if (isPlaying) {
          MainActivity.instance?.showVideoSurface()
          MainActivity.instance?.setKeepScreenOn(true)
          startProgressHeartbeat()
        } else {
          stopProgressHeartbeat()
          // When playback pauses or halts, release screen wake lock so screensaver
          // or sleep can eventually engage to protect TV panels during long pauses
          MainActivity.instance?.setKeepScreenOn(false)
        }
      }

      override fun onVideoSizeChanged(videoSize: VideoSize) {
        val pixelRatio = if (videoSize.pixelWidthHeightRatio > 0f) videoSize.pixelWidthHeightRatio else 1f
        val aspect = if (videoSize.height > 0) (videoSize.width * pixelRatio) / videoSize.height else 0f
        if (aspect > 0f) {
          MainActivity.instance?.setVideoAspectRatio(aspect)
        }

        val payload = JSObject().apply {
          put("width", videoSize.width)
          put("height", videoSize.height)
          put("aspectRatio", aspect)
          put("unappliedRotationDegrees", videoSize.unappliedRotationDegrees)
          put("pixelWidthHeightRatio", videoSize.pixelWidthHeightRatio)
        }
        dispatchNativeEvent("exoplayer://video-size", payload)
      }

      override fun onTracksChanged(tracks: androidx.media3.common.Tracks) {
        // ---------------------------------------------------------------------
        // Deferred Startup Audio Track Resolution
        // ---------------------------------------------------------------------
        // If an initial audio track selection was requested before demuxing finished,
        // apply the override now that media track groups are fully populated.
        val pendingIndex = pendingAudioTrackIndex
        if (pendingIndex != null) {
          pendingAudioTrackIndex = null
          applyAudioTrackSelection(pendingIndex)
        }

        val audioTracksArray = JSArray()

        var audioIndex = 0
        for (group in tracks.groups) {
          if (group.type == C.TRACK_TYPE_AUDIO) {
            val trackGroup = group.mediaTrackGroup
            for (i in 0 until trackGroup.length) {
              val format = trackGroup.getFormat(i)
              val trackObj = JSObject().apply {
                put("index", audioIndex)
                put("internalGroupIndex", i)
                put("id", format.id ?: "")
                put("label", format.label ?: "")
                put("language", format.language ?: "")
                put("mimeType", format.sampleMimeType ?: "")
                put("codecs", format.codecs ?: "")
                put("channelCount", format.channelCount)
                put("sampleRate", format.sampleRate)
                put("bitrate", format.bitrate)
                put("isSelected", group.isTrackSelected(i))
              }
              audioTracksArray.put(trackObj)
              audioIndex++
            }
          }
        }

        // ---------------------------------------------------------------------
        // Inspect Video Tracks for Hardware Support
        // ---------------------------------------------------------------------
        val videoTracksArray = JSArray()
        var videoIndex = 0
        for (group in tracks.groups) {
          if (group.type == C.TRACK_TYPE_VIDEO) {
            val trackGroup = group.mediaTrackGroup
            for (i in 0 until trackGroup.length) {
              val format = trackGroup.getFormat(i)
              val isSupported = group.isTrackSupported(i)
              val isSelected = group.isTrackSelected(i)
              if (!isSupported) {
                android.util.Log.w("ExoPlayerPlugin", "Video track (${format.sampleMimeType}) is NOT supported by device hardware decoders!")
              }
              val trackObj = JSObject().apply {
                put("index", videoIndex)
                put("mimeType", format.sampleMimeType ?: "")
                put("codecs", format.codecs ?: "")
                put("width", format.width)
                put("height", format.height)
                put("isSupported", isSupported)
                put("isSelected", isSelected)
              }
              videoTracksArray.put(trackObj)
              videoIndex++
            }
          }
        }

        val payload = JSObject().apply {
          put("audioTracks", audioTracksArray)
          put("videoTracks", videoTracksArray)
        }
        dispatchNativeEvent("exoplayer://tracks-changed", payload)
      }

      override fun onPlayerError(error: PlaybackException) {
        stopProgressHeartbeat()
        // Release keep-screen-on flag upon playback errors
        MainActivity.instance?.setKeepScreenOn(false)
        // Log detailed stack trace to Android Logcat for native troubleshooting
        android.util.Log.e("ExoPlayerPlugin", "ExoPlayer playback error: ${error.errorCodeName} (${error.errorCode}): ${error.message}", error)

        // Recursively extract all root cause messages and types for actionable diagnostics
        val causes = mutableListOf<String>()
        var curr: Throwable? = error.cause
        while (curr != null) {
          val msg = curr.message?.takeIf { it.isNotBlank() } ?: curr.javaClass.simpleName
          causes.add("${curr.javaClass.simpleName}: $msg")
          android.util.Log.e("ExoPlayerPlugin", "  Caused by: ${curr.javaClass.name}: ${curr.message}", curr)
          curr = curr.cause
        }

        val formattedMessage = if (causes.isNotEmpty()) {
          "${error.message ?: "Playback error"} (${causes.joinToString(" -> ")})"
        } else {
          error.message ?: "Unknown playback error"
        }

        val payload = JSObject().apply {
          put("errorCode", error.errorCode)
          put("errorCodeName", error.errorCodeName)
          put("message", formattedMessage)
          put("cause", causes.firstOrNull() ?: "")
        }
        dispatchNativeEvent("exoplayer://error", payload)
      }
    })

    this.player = newPlayer
    return newPlayer
  }

  /**
   * ===========================================================================
   * Native MediaSession Lifecycle Management
   * ===========================================================================
   * Ensures an active Media3 MediaSession is bound to the ExoPlayer instance.
   * Android OS routes remote control media buttons, Bluetooth headsets, and
   * tvQuickActions shortcut commands directly to this session.
   * ===========================================================================
   */
  private fun ensureMediaSession(exo: ExoPlayer): MediaSession {
    mediaSession?.let { return it }

    // Build native MediaSession bound directly to the hardware ExoPlayer looper
    val session = MediaSession.Builder(activity, exo)
      .setId("LitefinExoMediaSession")
      .build()

    this.mediaSession = session
    return session
  }

  /**
   * Releases and clears the active MediaSession when playback terminates.
   */
  private fun releaseMediaSession() {
    try {
      mediaSession?.release()
    } catch (_: Exception) {}
    mediaSession = null
  }

  /**
   * Checks whether the native ExoPlayer is currently allocated and ready.
   */
  fun hasActivePlayer(): Boolean {
    return player != null
  }

  /**
   * Checks whether the native player is actively playing video frames.
   */
  fun isPlaying(): Boolean {
    return player?.isPlaying ?: false
  }

  // ===========================================================================
  // Tauri @Command Endpoints (Asynchronous Invocation)
  // ===========================================================================

  /**
   * Prepares media for playback from the specified URL and optional HTTP headers.
   */
  @Command
  fun prepare(invoke: Invoke) {
    val args = invoke.parseArgs(PrepareArgs::class.java)

    activity.runOnUiThread {
      try {
        val exo = ensurePlayer()

        val tunneling = args.tunneling ?: isTunnelingEnabled
        val audioOffload = args.audioOffload ?: isAudioOffloadEnabled
        this.isTunnelingEnabled = tunneling
        this.isAudioOffloadEnabled = audioOffload
        trackSelector?.let { sel ->
          applyTrackSelectorParameters(sel, tunneling, audioOffload)
        }

        // ---------------------------------------------------------------------
        // Build OkHttp Data Source with Custom Headers
        // ---------------------------------------------------------------------
        val httpDataSourceFactory = OkHttpDataSource.Factory(okHttpClient)
        val requestHeaders = args.headers
        if (!requestHeaders.isNullOrEmpty()) {
          httpDataSourceFactory.setDefaultRequestProperties(requestHeaders)
        }
        httpDataSourceFactory.setUserAgent("Litefin (Linux; Android; ExoPlayer)")

        val dataSourceFactory = DefaultDataSource.Factory(activity, httpDataSourceFactory)
        val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory, createExtractorsFactory())

        // Create MediaItem and configure start position if resuming
        val mediaItem = MediaItem.fromUri(Uri.parse(args.url))
        val mediaSource = mediaSourceFactory.createMediaSource(mediaItem)

        // Immediately hide video plane so previous movie's last frame is never shown
        MainActivity.instance?.hideVideoSurface()

        // Clear any previous track selection request
        pendingAudioTrackIndex = null
        exo.setMediaSource(mediaSource)

        val startPosition = args.startPositionMs ?: 0L
        if (startPosition > 0) {
          exo.seekTo(startPosition)
        }

        exo.prepare()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to prepare ExoPlayer: ${e.message}")
      }
    }
  }

  /**
   * Begins or resumes playback.
   */
  @Command
  fun play(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        val exo = ensurePlayer()
        // Instruct ExoPlayer to begin playback once media buffering completes
        // We avoid calling startProgressHeartbeat() or showVideoSurface() here
        // so that the loading screen and hidden surface are preserved until
        // onRenderedFirstFrame() or onPlaybackStateChanged(STATE_READY) fire.
        exo.playWhenReady = true
        exo.play()
        MainActivity.instance?.setKeepScreenOn(true)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to start playback: ${e.message}")
      }
    }
  }

  /**
   * Sets presentation aspect ratio mode (auto, zoom, stretch).
   */
  @Command
  fun setAspectRatio(invoke: Invoke) {
    val args = invoke.parseArgs(AspectRatioArgs::class.java)
    val mode = args.mode ?: "auto"
    activity.runOnUiThread {
      MainActivity.instance?.setResizeMode(mode)
      invoke.resolve()
    }
  }

  /**
   * Pauses active playback.
   */
  @Command
  fun pause(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        player?.pause()
        stopProgressHeartbeat()
        MainActivity.instance?.setKeepScreenOn(false)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to pause playback: ${e.message}")
      }
    }
  }

  /**
   * Seeks to a specific timestamp in milliseconds.
   */
  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)

    activity.runOnUiThread {
      try {
        val targetMs = args.positionMs ?: 0L
        player?.seekTo(targetMs)
        emitProgressUpdate()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to seek: ${e.message}")
      }
    }
  }

  /**
   * Updates playback rate (e.g. 0.5x, 1.0x, 1.5x, 2.0x).
   */
  @Command
  fun setPlaybackSpeed(invoke: Invoke) {
    val args = invoke.parseArgs(SpeedArgs::class.java)

    activity.runOnUiThread {
      try {
        val speed = args.speed ?: 1.0f
        player?.setPlaybackSpeed(speed)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to set playback speed: ${e.message}")
      }
    }
  }

  /**
   * Adjusts master audio volume (0.0 to 1.0 scale).
   */
  @Command
  fun setVolume(invoke: Invoke) {
    val args = invoke.parseArgs(VolumeArgs::class.java)

    activity.runOnUiThread {
      try {
        val vol = args.volume?.coerceIn(0.0f, 1.0f) ?: 1.0f
        player?.volume = vol
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to set volume: ${e.message}")
      }
    }
  }

  /**
   * Applies the requested 0-based audio track selection to the running ExoPlayer.
   * Updates [Player.setTrackSelectionParameters] so the playback looper immediately
   * reconfigures the audio pipeline without requiring a playback restart.
   *
   * @param targetIndex The 0-based audio track index within available audio groups.
   * @return True if the track was immediately matched and applied, false if deferred.
   */
  private fun applyAudioTrackSelection(targetIndex: Int): Boolean {
    val exo = player ?: return false
    val selector = trackSelector ?: return false

    // Handle disabling audio track if negative index is requested
    if (targetIndex < 0) {
      val disabledPlayerParams = exo.trackSelectionParameters.buildUpon()
        .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
        .build()
      exo.trackSelectionParameters = disabledPlayerParams

      // Keep DefaultTrackSelector in sync with player parameters
      val disabledSelectorParams = selector.buildUponParameters()
        .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
        .build()
      selector.parameters = disabledSelectorParams

      pendingAudioTrackIndex = null
      return true
    }

    // Traverse audio track groups to locate matching index
    var foundTrack = false
    var currentIdx = 0
    val currentTracks = exo.currentTracks

    for (group in currentTracks.groups) {
      if (group.type == C.TRACK_TYPE_AUDIO) {
        val trackGroup = group.mediaTrackGroup
        for (i in 0 until trackGroup.length) {
          if (currentIdx == targetIndex) {
            // Build track selection override for this specific track group and index
            val override = TrackSelectionOverride(trackGroup, i)

            // Update ExoPlayer's TrackSelectionParameters (canonical Media3 source of truth)
            // This immediately signals the internal playback looper to switch decoders and audio sinks.
            val newPlayerParams = exo.trackSelectionParameters.buildUpon()
              .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
              .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
              .addOverride(override)
              .build()
            exo.trackSelectionParameters = newPlayerParams

            // Keep DefaultTrackSelector parameters synchronized
            val newSelectorParams = selector.buildUponParameters()
              .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
              .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
              .addOverride(override)
              .build()
            selector.parameters = newSelectorParams

            android.util.Log.i("ExoPlayerPlugin", "Successfully selected audio track index $targetIndex (mime: ${trackGroup.getFormat(i).sampleMimeType})")
            foundTrack = true
            break
          }
          currentIdx++
        }
        if (foundTrack) break
      }
    }

    if (!foundTrack) {
      // If tracks aren't prepared yet, queue it for when onTracksChanged fires
      android.util.Log.i("ExoPlayerPlugin", "Audio track index $targetIndex not found in current tracks (count: $currentIdx). Queueing as pending.")
      pendingAudioTrackIndex = targetIndex
      return false
    } else {
      pendingAudioTrackIndex = null
      return true
    }
  }

  /**
   * Switches the active audio stream to the requested index.
   */
  @Command
  fun selectAudioTrack(invoke: Invoke) {
    val args = invoke.parseArgs(TrackArgs::class.java)

    activity.runOnUiThread {
      try {
        val targetIndex = args.trackIndex ?: 0
        applyAudioTrackSelection(targetIndex)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to select audio track: ${e.message}")
      }
    }
  }

  /**
   * Halts playback and resets player state.
   */
  @Command
  fun stop(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        stopProgressHeartbeat()
        // Release MediaSession so system knows playback has halted
        releaseMediaSession()
        player?.stop()
        MainActivity.instance?.setKeepScreenOn(false)
        MainActivity.instance?.hideVideoSurface()
        MainActivity.instance?.resetDisplayMode()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to stop player: ${e.message}")
      }
    }
  }

  /**
   * Completely destroys and releases the ExoPlayer hardware instance.
   */
  @Command
  fun destroy(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        stopProgressHeartbeat()
        // Tear down native MediaSession connection to OS media services
        releaseMediaSession()
        player?.release()
        player = null
        trackSelector = null
        pendingAudioTrackIndex = null
        MainActivity.instance?.setKeepScreenOn(false)
        MainActivity.instance?.hideVideoSurface()
        MainActivity.instance?.resetTextureView()
        MainActivity.instance?.resetDisplayMode()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to destroy player: ${e.message}")
      }
    }
  }

  /**
   * Adapts display refresh rate and resolution to video stream characteristics.
   */
  @Command
  fun setRefreshRate(invoke: Invoke) {
    val args = invoke.parseArgs(RefreshRateArgs::class.java)
    activity.runOnUiThread {
      try {
        val frameRate = args.frameRate ?: 0f
        val width = args.width ?: 0
        val height = args.height ?: 0
        val matched = MainActivity.instance?.matchDisplayMode(width, height, frameRate) ?: false
        val ret = JSObject().apply { put("matched", matched) }
        invoke.resolve(ret)
      } catch (e: Exception) {
        invoke.reject("Failed matching refresh rate: ${e.message}")
      }
    }
  }

  /**
   * Resets display refresh rate and resolution back to system default.
   */
  @Command
  fun resetRefreshRate(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        MainActivity.instance?.resetDisplayMode()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed resetting refresh rate: ${e.message}")
      }
    }
  }

  /**
   * Queries connected display panel supported modes.
   */
  @Command
  fun getSupportedDisplayModes(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        val modesJson = MainActivity.instance?.getSupportedDisplayModesJson() ?: "[]"
        val ret = JSObject().apply { put("modes", modesJson) }
        invoke.resolve(ret)
      } catch (e: Exception) {
        invoke.reject("Failed querying display modes: ${e.message}")
      }
    }
  }

  /**
   * Updates hardware video tunneling preference.
   */
  @Command
  fun setTunnelingEnabled(invoke: Invoke) {
    val enabled = invoke.parseArgs(BooleanArgs::class.java).enabled ?: true
    activity.runOnUiThread {
      isTunnelingEnabled = enabled
      trackSelector?.let { applyTrackSelectorParameters(it, isTunnelingEnabled, isAudioOffloadEnabled) }
      invoke.resolve()
    }
  }

  /**
   * Updates audio offload preference.
   */
  @Command
  fun setAudioOffloadEnabled(invoke: Invoke) {
    val enabled = invoke.parseArgs(BooleanArgs::class.java).enabled ?: true
    activity.runOnUiThread {
      isAudioOffloadEnabled = enabled
      trackSelector?.let { applyTrackSelectorParameters(it, isTunnelingEnabled, isAudioOffloadEnabled) }
      invoke.resolve()
    }
  }

  /**
   * Checks whether the native FFmpeg audio decoding extension (libffmpeg.so)
   * is successfully loaded and operational within the runtime environment.
   */
  @Command
  fun isFfmpegAvailable(invoke: Invoke) {
    try {
      // Dynamic reflective probe to verify FfmpegLibrary is linked and initialized
      val clazz = Class.forName("androidx.media3.decoder.ffmpeg.FfmpegLibrary")
      val isAvailableMethod = clazz.getMethod("isAvailable")
      val available = (isAvailableMethod.invoke(null) as? Boolean) ?: false
      val ret = JSObject().apply {
        put("available", available)
      }
      invoke.resolve(ret)
    } catch (_: Exception) {
      val ret = JSObject().apply {
        put("available", false)
      }
      invoke.resolve(ret)
    }
  }

  // ===========================================================================
  // Event Dispatching Utilities
  // ===========================================================================

  /**
   * Dispatches an event payload simultaneously across:
   * 1. Standard Tauri plugin event bus (trigger)
   * 2. WebView DOM CustomEvent via evaluateJavascript
   */
  private fun dispatchNativeEvent(eventName: String, payload: JSObject) {
    // 1. Dispatch via Tauri Plugin event channel
    try {
      trigger(eventName.removePrefix("exoplayer://"), payload)
    } catch (_: Exception) { }

    // 2. Dispatch directly into WebView DOM CustomEvent bus for low-latency delivery
    activity.runOnUiThread {
      try {
        val webView = this.pluginWebView ?: MainActivity.instance?.getWebView()
        if (webView == null) {
          android.util.Log.e("LitefinExoPlayer", "Cannot dispatch $eventName: webView reference is null")
          return@runOnUiThread
        }
        val jsonString = payload.toString()
        val script = "window.dispatchEvent(new CustomEvent('$eventName', { detail: $jsonString }));"
        webView.evaluateJavascript(script, null)
      } catch (err: Exception) {
        android.util.Log.e("LitefinExoPlayer", "Failed to dispatch $eventName via evaluateJavascript: ${err.message}")
      }
    }
  }

  /**
   * Emits the 250ms progress update payload with current playback positions.
   */
  private fun emitProgressUpdate() {
    val exo = player ?: return
    val currentPos = exo.currentPosition
    val duration = if (exo.duration != C.TIME_UNSET) exo.duration else 0L
    val bufferedPos = exo.bufferedPosition

    val payload = JSObject().apply {
      put("positionMs", currentPos)
      put("durationMs", duration)
      put("bufferedMs", bufferedPos)
    }

    dispatchNativeEvent("exoplayer://time-update", payload)
  }

  private fun startProgressHeartbeat() {
    mainHandler.removeCallbacks(progressHeartbeatRunnable)
    mainHandler.post(progressHeartbeatRunnable)
  }

  private fun stopProgressHeartbeat() {
    mainHandler.removeCallbacks(progressHeartbeatRunnable)
  }

  // ===========================================================================
  // Direct @JavascriptInterface Bridge
  // ===========================================================================
  /**
   * Provides synchronous property queries and zero-overhead calls from JavaScript.
   */
  inner class DirectPlayerBridge {

    @JavascriptInterface
    fun prepare(url: String, headersJson: String?, startPositionMs: Long) {
      prepare(url, headersJson, startPositionMs, isTunnelingEnabled, isAudioOffloadEnabled)
    }

    @JavascriptInterface
    fun prepare(
      url: String,
      headersJson: String?,
      startPositionMs: Long,
      tunneling: Boolean,
      audioOffload: Boolean
    ) {
      activity.runOnUiThread {
        try {
          isTunnelingEnabled = tunneling
          isAudioOffloadEnabled = audioOffload

          val exo = ensurePlayer()
          trackSelector?.let { sel ->
            applyTrackSelectorParameters(sel, tunneling, audioOffload)
          }

          val httpDataSourceFactory = OkHttpDataSource.Factory(okHttpClient)

          if (!headersJson.isNullOrBlank()) {
            val json = JSONObject(headersJson)
            val headerMap = mutableMapOf<String, String>()
            json.keys().forEach { key ->
              headerMap[key] = json.getString(key)
            }
            httpDataSourceFactory.setDefaultRequestProperties(headerMap)
          }

          val dataSourceFactory = DefaultDataSource.Factory(activity, httpDataSourceFactory)
          val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory, createExtractorsFactory())
          val mediaItem = MediaItem.fromUri(Uri.parse(url))
          val mediaSource = mediaSourceFactory.createMediaSource(mediaItem)

          // Immediately conceal video surface so previous media frame is never flashed
          MainActivity.instance?.hideVideoSurface()

          // Reset pending track index on fresh preparation
          pendingAudioTrackIndex = null
          exo.setMediaSource(mediaSource)
          if (startPositionMs > 0) {
            exo.seekTo(startPositionMs)
          }
          exo.prepare()
        } catch (_: Exception) { }
      }
    }

    @JavascriptInterface
    fun play() {
      activity.runOnUiThread {
        val exo = ensurePlayer()
        MainActivity.instance?.showVideoSurface()
        MainActivity.instance?.setKeepScreenOn(true)
        exo.playWhenReady = true
        exo.play()
        startProgressHeartbeat()
      }
    }

    @JavascriptInterface
    fun setAspectRatio(mode: String) {
      activity.runOnUiThread {
        MainActivity.instance?.setResizeMode(mode)
      }
    }

    @JavascriptInterface
    fun pause() {
      activity.runOnUiThread {
        player?.pause()
        stopProgressHeartbeat()
        MainActivity.instance?.setKeepScreenOn(false)
      }
    }

    @JavascriptInterface
    fun seek(positionMs: Long) {
      activity.runOnUiThread {
        player?.seekTo(positionMs)
        emitProgressUpdate()
      }
    }

    @JavascriptInterface
    fun setPlaybackSpeed(speed: Float) {
      activity.runOnUiThread {
        player?.setPlaybackSpeed(speed)
      }
    }

    @JavascriptInterface
    fun setVolume(volume: Float) {
      activity.runOnUiThread {
        player?.volume = volume.coerceIn(0.0f, 1.0f)
      }
    }

    @JavascriptInterface
    fun selectAudioTrack(trackIndex: Int) {
      activity.runOnUiThread {
        applyAudioTrackSelection(trackIndex)
      }
    }

    @JavascriptInterface
    fun stop() {
      activity.runOnUiThread {
        stopProgressHeartbeat()
        player?.stop()
        MainActivity.instance?.setKeepScreenOn(false)
        MainActivity.instance?.hideVideoSurface()
      }
    }

    @JavascriptInterface
    fun destroy() {
      activity.runOnUiThread {
        stopProgressHeartbeat()
        releaseMediaSession()
        player?.release()
        player = null
        trackSelector = null
        pendingAudioTrackIndex = null
        MainActivity.instance?.setKeepScreenOn(false)
        MainActivity.instance?.hideVideoSurface()
        MainActivity.instance?.resetTextureView()
      }
    }

    @JavascriptInterface
    fun getCurrentPositionMs(): Long {
      return player?.currentPosition ?: 0L
    }

    @JavascriptInterface
    fun getDurationMs(): Long {
      val dur = player?.duration ?: C.TIME_UNSET
      return if (dur != C.TIME_UNSET) dur else 0L
    }

    @JavascriptInterface
    fun isPlaying(): Boolean {
      return player?.isPlaying ?: false
    }

    @JavascriptInterface
    fun isPaused(): Boolean {
      return !(player?.isPlaying ?: false)
    }

    /**
     * Synchronous probe callable directly from JavaScript WebView runtime.
     * Returns true if the native FFmpeg decoder extension is active.
     */
    @JavascriptInterface
    fun isFfmpegAvailable(): Boolean {
      return try {
        val clazz = Class.forName("androidx.media3.decoder.ffmpeg.FfmpegLibrary")
        val isAvailableMethod = clazz.getMethod("isAvailable")
        (isAvailableMethod.invoke(null) as? Boolean) ?: false
      } catch (_: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun setTunnelingEnabled(enabled: Boolean) {
      activity.runOnUiThread {
        isTunnelingEnabled = enabled
        trackSelector?.let { applyTrackSelectorParameters(it, isTunnelingEnabled, isAudioOffloadEnabled) }
      }
    }

    @JavascriptInterface
    fun setAudioOffloadEnabled(enabled: Boolean) {
      activity.runOnUiThread {
        isAudioOffloadEnabled = enabled
        trackSelector?.let { applyTrackSelectorParameters(it, isTunnelingEnabled, isAudioOffloadEnabled) }
      }
    }

    @JavascriptInterface
    fun isTunnelingEnabled(): Boolean {
      return isTunnelingEnabled
    }

    @JavascriptInterface
    fun isAudioOffloadEnabled(): Boolean {
      return isAudioOffloadEnabled
    }

    @JavascriptInterface
    fun setRefreshRate(frameRate: Float, width: Int, height: Int): Boolean {
      return MainActivity.instance?.matchDisplayMode(width, height, frameRate) ?: false
    }

    @JavascriptInterface
    fun resetRefreshRate(): Boolean {
      MainActivity.instance?.resetDisplayMode()
      return true
    }

    @JavascriptInterface
    fun getSupportedDisplayModes(): String {
      return MainActivity.instance?.getSupportedDisplayModesJson() ?: "[]"
    }
  }

  // ===========================================================================
  // Command Argument Data Transfer Classes
  // ===========================================================================
  class PrepareArgs {
    var url: String = ""
    var headers: Map<String, String>? = null
    var startPositionMs: Long? = null
    var tunneling: Boolean? = null
    var audioOffload: Boolean? = null
  }

  class BooleanArgs {
    var enabled: Boolean? = null
  }

  class SeekArgs {
    var positionMs: Long? = null
  }

  class SpeedArgs {
    var speed: Float? = null
  }

  class VolumeArgs {
    var volume: Float? = null
  }

  class TrackArgs {
    var trackIndex: Int? = null
  }

  class AspectRatioArgs {
    var mode: String? = "auto"
  }

  class RefreshRateArgs {
    var frameRate: Float? = null
    var width: Int? = null
    var height: Int? = null
  }
}
