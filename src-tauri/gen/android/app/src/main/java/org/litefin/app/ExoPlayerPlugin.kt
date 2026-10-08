package org.litefin.app

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
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

  // ---------------------------------------------------------------------------
  // Core Media3 Components
  // ---------------------------------------------------------------------------
  // The primary Media3 ExoPlayer playback engine
  private var player: ExoPlayer? = null

  // Custom track selector enabling fine-grained audio stream switching
  private var trackSelector: DefaultTrackSelector? = null

  // Queued audio track index to be applied once media tracks are demuxed
  private var pendingAudioTrackIndex: Int? = null

  // Reusable OkHttpClient configured with optimized connection timeouts
  private val okHttpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
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

  /**
   * Initializes or returns the existing Media3 ExoPlayer instance on the main thread.
   */
  private fun ensurePlayer(): ExoPlayer {
    player?.let { existing ->
      MainActivity.instance?.getTextureView()?.let { textureView ->
        existing.setVideoTextureView(textureView)
      }
      return existing
    }

    val selector = DefaultTrackSelector(activity)
    this.trackSelector = selector

    val newPlayer = ExoPlayer.Builder(activity)
      .setTrackSelector(selector)
      .build()

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
          startProgressHeartbeat()
        } else if (playbackState == Player.STATE_ENDED || playbackState == Player.STATE_IDLE) {
          stopProgressHeartbeat()
          MainActivity.instance?.hideVideoSurface()
        }
      }

      override fun onRenderedFirstFrame() {
        // Guarantee video surface is revealed the instant the first decoded frame is ready
        MainActivity.instance?.showVideoSurface()
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
          startProgressHeartbeat()
        } else {
          stopProgressHeartbeat()
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
        val payload = JSObject().apply {
          put("errorCode", error.errorCode)
          put("errorCodeName", error.errorCodeName)
          put("message", error.message ?: "Unknown playback error")
        }
        dispatchNativeEvent("exoplayer://error", payload)
      }
    })

    this.player = newPlayer
    return newPlayer
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

        // ---------------------------------------------------------------------
        // Build OkHttp Data Source with Custom Headers
        // ---------------------------------------------------------------------
        // Injects authorization bearer tokens and custom Jellyfin headers
        val httpDataSourceFactory = OkHttpDataSource.Factory(okHttpClient)
        args.headers?.forEach { (key, value) ->
          httpDataSourceFactory.setDefaultRequestProperties(mapOf(key to value))
        }

        val dataSourceFactory = DefaultDataSource.Factory(activity, httpDataSourceFactory)
        val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)

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
        player?.stop()
        MainActivity.instance?.hideVideoSurface()
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
        player?.release()
        player = null
        trackSelector = null
        pendingAudioTrackIndex = null
        MainActivity.instance?.hideVideoSurface()
        MainActivity.instance?.resetTextureView()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to destroy player: ${e.message}")
      }
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
      activity.runOnUiThread {
        try {
          val exo = ensurePlayer()
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
          val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
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
        MainActivity.instance?.hideVideoSurface()
      }
    }

    @JavascriptInterface
    fun destroy() {
      activity.runOnUiThread {
        stopProgressHeartbeat()
        player?.release()
        player = null
        trackSelector = null
        pendingAudioTrackIndex = null
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
  }

  // ===========================================================================
  // Command Argument Data Transfer Classes
  // ===========================================================================
  class PrepareArgs {
    var url: String = ""
    var headers: Map<String, String>? = null
    var startPositionMs: Long? = null
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
}
