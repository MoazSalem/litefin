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
  private val progressHeartbeatRunnable = object : Runnable {
    override fun run() {
      emitProgressUpdate()
      // Continue scheduling as long as the player is active and playing
      if (player?.isPlaying == true) {
        mainHandler.postDelayed(this, 250L)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Plugin Lifecycle Initialization
  // ---------------------------------------------------------------------------
  override fun load(webView: android.webkit.WebView) {
    super.load(webView)

    // Register synchronous / direct JavaScript bridge onto the WebView
    activity.runOnUiThread {
      webView.addJavascriptInterface(DirectPlayerBridge(), "LitefinExoPlayer")
    }
  }

  /**
   * Initializes or returns the existing Media3 ExoPlayer instance on the main thread.
   */
  private fun ensurePlayer(): ExoPlayer {
    player?.let { return it }

    val selector = DefaultTrackSelector(activity)
    this.trackSelector = selector

    val newPlayer = ExoPlayer.Builder(activity)
      .setTrackSelector(selector)
      .build()

    // -------------------------------------------------------------------------
    // Bind Hardware SurfaceView
    // -------------------------------------------------------------------------
    // Connect player output to the SurfaceView hosted behind the transparent WebView
    MainActivity.instance?.getSurfaceView()?.let { surfaceView ->
      newPlayer.setVideoSurfaceView(surfaceView)
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
        } else if (playbackState == Player.STATE_ENDED) {
          stopProgressHeartbeat()
        }
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
        val payload = JSObject().apply {
          put("width", videoSize.width)
          put("height", videoSize.height)
          put("unappliedRotationDegrees", videoSize.unappliedRotationDegrees)
          put("pixelWidthHeightRatio", videoSize.pixelWidthHeightRatio)
        }
        dispatchNativeEvent("exoplayer://video-size", payload)
      }

      override fun onTracksChanged(tracks: androidx.media3.common.Tracks) {
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

        val payload = JSObject().apply {
          put("audioTracks", audioTracksArray)
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
        MainActivity.instance?.showVideoSurface()
        exo.playWhenReady = true
        exo.play()
        startProgressHeartbeat()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Failed to start playback: ${e.message}")
      }
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
   * Switches the active audio stream to the requested index.
   */
  @Command
  fun selectAudioTrack(invoke: Invoke) {
    val args = invoke.parseArgs(TrackArgs::class.java)

    activity.runOnUiThread {
      try {
        val targetIndex = args.trackIndex ?: 0
        val exo = player ?: run {
          invoke.resolve()
          return@runOnUiThread
        }

        val selector = trackSelector ?: run {
          invoke.resolve()
          return@runOnUiThread
        }

        // Iterate through audio track groups to find matching index
        var currentIdx = 0
        for (group in exo.currentTracks.groups) {
          if (group.type == C.TRACK_TYPE_AUDIO) {
            val trackGroup = group.mediaTrackGroup
            for (i in 0 until trackGroup.length) {
              if (currentIdx == targetIndex) {
                // Apply track selection override
                val override = TrackSelectionOverride(trackGroup, i)
                val params = selector.buildUponParameters()
                  .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                  .addOverride(override)
                  .build()
                selector.parameters = params
                invoke.resolve()
                return@runOnUiThread
              }
              currentIdx++
            }
          }
        }
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
        MainActivity.instance?.hideVideoSurface()
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
        val webView = MainActivity.instance?.getWebView() ?: return@runOnUiThread
        val jsonString = payload.toString()
        val script = "window.dispatchEvent(new CustomEvent('$eventName', { detail: $jsonString }));"
        webView.evaluateJavascript(script, null)
      } catch (_: Exception) { }
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
        val exo = player ?: return@runOnUiThread
        val selector = trackSelector ?: return@runOnUiThread
        var currentIdx = 0
        for (group in exo.currentTracks.groups) {
          if (group.type == C.TRACK_TYPE_AUDIO) {
            val trackGroup = group.mediaTrackGroup
            for (i in 0 until trackGroup.length) {
              if (currentIdx == trackIndex) {
                val override = TrackSelectionOverride(trackGroup, i)
                val params = selector.buildUponParameters()
                  .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                  .addOverride(override)
                  .build()
                selector.parameters = params
                return@runOnUiThread
              }
              currentIdx++
            }
          }
        }
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
        MainActivity.instance?.hideVideoSurface()
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
}
