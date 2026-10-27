import Component from '../core/Component.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
// Centralized icon utility library hosting standard SVG mappings.
import { osdIcons } from '../utils/Icons.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { webosAdapter } from '../webos/WebOSAdapter.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { api } from '../api/index.js';
/**
 * TrailerPlayer
 * Displays a fullscreen iframe to play remote trailers (mostly YouTube),
 * with a minimal OSD that matches the native Tizen player UI.
 */
export class TrailerPlayer extends Component {
    constructor(trailers, parentPage, isProxy = false) {
        super();
        this._trailers = trailers;
        this._parentPage = parentPage;
        this._isProxy = isProxy;

        this._currentIndex = 0;
        this._ytPlayer = null;
        this._progressTimer = null;
        this._autoHideTimer = null;

        this._isOsdVisible = false;
        this._isPlaying = true;
        // Tracking flag to lock OSD visibility during trailer buffering phases
        this._isLoading = true;

        // Queue modal state tracking
        this._isQueueModalOpen = false;
        this._queueFocusIndex = 0;
        this._queueModalOverlay = null;
        this._queueOpenedAt = 0;

        // Focus state restoration
        this._previousFocusTarget = focusManager.getFocused();

        // Bindings
        this._handleKeyDown = this._handleKeyDown.bind(this);
        this._onYTReady = this._onYTReady.bind(this);
        this._onYTStateChange = this._onYTStateChange.bind(this);
        this._updateProgress = this._updateProgress.bind(this);
        this._onProxyMessage = this._onProxyMessage.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onOverlayClick = this._onOverlayClick.bind(this);
        this._onThrottledMouseMove = this._onThrottledMouseMove.bind(this);
        this._toggleQueueModal = this._toggleQueueModal.bind(this);
        this._openQueueModal = this._openQueueModal.bind(this);
        this._closeQueueModal = this._closeQueueModal.bind(this);
        this._selectQueueItem = this._selectQueueItem.bind(this);

        this._mouseMoveThrottle = null;
        // Timestamp marker to debounce synthetic activation clicks on mount
        this._mountTime = Date.now();
    }

    static showLegacy(trailers, parentPage) {
        if (!trailers || !trailers.length) return;
        const player = new TrailerPlayer(trailers, parentPage, false);
        player.mount(document.body);
        return player;
    }

    static show(trailers, parentPage) {
        if (!trailers || !trailers.length) return;
        const player = new TrailerPlayer(trailers, parentPage, true);
        player.mount(document.body);
        return player;
    }

    static launchExternal(trailers, parentPage) {
        if (!trailers || !trailers.length) return;

        const url = trailers[0].Url || '';
        let ytId = null;

        const yt = url.match(/[?&]v=([^&]+)/);
        if (yt) {
            ytId = yt[1];
        } else {
            const ytShort = url.match(/youtu\.be\/([^?]+)/);
            if (ytShort) ytId = ytShort[1];
        }

        if (ytId) {
            if (tizenAdapter.isTizen()) {
                tizenAdapter.launchYouTube(ytId);
            } else if (webosAdapter.isWebOS) {
                webosAdapter.launchYouTube(ytId);
            } else {
                window.open(`https://www.youtube.com/watch?v=${ytId}`, '_blank');
            }
        } else {
            // Fallback for non-YouTube URLs
            this.show(trailers, parentPage);
        }
    }

    render() {
        this._overlay = document.createElement('div');
        this._overlay.className = 'trailer-player-overlay';
        this._overlay.style.zIndex = '99999'; // Ensure it's above everything

        let backdropUrl = '';
        if (this._parentPage && this._parentPage._item) {
            const item = this._parentPage._item;
            if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                backdropUrl = api.getImageUrl(item.Id, 'Backdrop', { maxWidth: 1920 });
            }
        }

        const backdropStyle = backdropUrl
            ? `background-image: url('${backdropUrl}'); background-size: cover; background-position: center;`
            : 'background-color: #000;';

        this._overlay.innerHTML = `
            <div class="trailer-iframe-container" id="trailerIframeContainer" style="opacity: 0; transition: opacity 0.5s ease; position: absolute; top:0; left:0; width: 100%; height: 100%; z-index: 1;"></div>
            
            <div class="player-osd trailer-osd osd-is-hidden" id="trailerOsd" style="z-index: 10;">
                <div class="osd-main">
                    <!-- Header -->
                    <div class="osd-header">
                        <div class="osd-header-left">
                            <!-- Back button using centralized back arrow unified SVG -->
                            <button class="osd-btn osd-back-btn focusable" data-action="close" aria-label="${i18n.t('Close') || 'Close'}" tabindex="0">
                                ${osdIcons.arrowBack}
                            </button>
                            <span class="osd-title" id="trailerTitle"></span>
                        </div>
                    </div>

                    <!-- Bottom Area -->
                    <div class="osd-bottom">
                        <div class="osd-controls-row" style="position: relative; display: flex; align-items: center; justify-content: space-between;">
                            <div class="osd-controls-left" style="position: absolute; left: 50%; transform: translateX(-50%); display: flex; align-items: center;">
                                <!-- Standard player control buttons utilizing unified SVG definitions.
                                     CSS handles outline/filled states dynamically based on hover/focus/active. -->
                                <button class="osd-btn focusable" data-action="prev" tabindex="0" id="trailerPrevBtn">${osdIcons.skipPrevious}</button>
                                <button class="osd-btn focusable" data-action="rewind" tabindex="0">${osdIcons.fastRewind}</button>
                                <button class="osd-btn osd-btn-play focusable" id="trailerPlayPauseBtn" data-action="togglePlay" tabindex="0">${osdIcons.pause}</button>
                                <button class="osd-btn focusable" data-action="fastForward" tabindex="0">${osdIcons.fastForward}</button>
                                <button class="osd-btn focusable" data-action="next" tabindex="0" id="trailerNextBtn">${osdIcons.skipNext}</button>
                            </div>
                            <div class="osd-spacer"></div>
                            <div class="osd-controls-right" style="display: flex; align-items: center; margin-left: auto;">
                                <!-- Queue modal button matching native player OSD controls -->
                                <button class="osd-btn focusable" data-action="queue" id="trailerQueueBtn" tabindex="0" aria-label="${i18n.t('Queue') || 'Queue'}">${osdIcons.queue}</button>
                            </div>
                        </div>

                        <!-- Seekbar Container -->
                        <div class="osd-slider-row">
                            <span class="osd-time osd-time-current" id="trailerCurrentTime">00:00</span>
                            <div class="osd-slider-container">
                                <div class="osd-slider-track">
                                    <div class="osd-slider-fill" id="trailerPositionFill" style="width: 0%;"></div>
                                </div>
                                <input type="range" class="osd-slider focusable" id="trailerPositionSlider" min="0" max="100" step="0.1" value="0" tabindex="0">
                            </div>
                            <span class="osd-time osd-time-total" id="trailerTotalTime">00:00</span>
                        </div>
                    </div>
                </div>

                <!-- Overlays container for modal side panels (matches native player .osd-overlays structure) -->
                <div class="osd-overlays" id="trailerOsdOverlays"></div>
            </div>

            <!-- Loading Backdrop & Spinner Layer
                 Configured with z-index 100 so it sits cleanly above the OSD (z-index 10),
                 guaranteeing all transport controls and titles remain hidden beneath the loading screen. -->
            <div class="trailer-backdrop" id="trailerBackdrop" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; ${backdropStyle} z-index: 100; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                <div style="position: absolute; top:0; left:0; width:100%; height:100%; background: rgba(0,0,0,0.6); z-index: 1;"></div>
                <div class="loading-spinner" style="z-index: 2;"></div>
            </div>
        `;

        // Cache DOM elements
        this._osdEl = this._overlay.querySelector('#trailerOsd');
        this._titleEl = this._overlay.querySelector('#trailerTitle');
        this._playPauseBtn = this._overlay.querySelector('#trailerPlayPauseBtn');
        this._prevBtn = this._overlay.querySelector('#trailerPrevBtn');
        this._nextBtn = this._overlay.querySelector('#trailerNextBtn');
        this._queueBtn = this._overlay.querySelector('#trailerQueueBtn');
        this._overlaysContainer = this._overlay.querySelector('#trailerOsdOverlays');
        this._currentTimeEl = this._overlay.querySelector('#trailerCurrentTime');
        this._totalTimeEl = this._overlay.querySelector('#trailerTotalTime');
        this._positionFillEl = this._overlay.querySelector('#trailerPositionFill');
        this._positionSliderEl = this._overlay.querySelector('#trailerPositionSlider');

        // Bind clicks
        this._overlay.addEventListener('click', this._onOverlayClick);
        this._overlay.addEventListener('mousemove', this._onThrottledMouseMove);

        // Scrubbing via slider
        this._positionSliderEl.addEventListener('mousedown', () => (this._isDraggingSlider = true));
        this._positionSliderEl.addEventListener('touchstart', () => (this._isDraggingSlider = true), { passive: true });

        // Visually update the custom CSS fill while actively dragging before "drop/change"
        this._positionSliderEl.addEventListener('input', (e) => {
            this._positionFillEl.style.width = `${e.target.value}%`;
            this._resetAutoHide();
        });

        this._positionSliderEl.addEventListener('change', (e) => {
            this._isDraggingSlider = false;

            // Set a soft lock to prevent `_updateProgress` from rubber-banding the slider
            // before the underlying YouTube player or Proxy has a chance to execute the seek
            this._isSeeking = true;
            if (this._seekLockTimer) clearTimeout(this._seekLockTimer);
            this._seekLockTimer = setTimeout(() => (this._isSeeking = false), 1500);

            const percent = parseFloat(e.target.value);

            if (this._isProxy) {
                if (this._proxyDuration) {
                    const targetTime = (percent / 100) * this._proxyDuration;
                    this._proxyCurrentTime = targetTime; // Optimistic jump visually
                    this._sendProxyCommand('seek', targetTime * 1000);
                }
            } else if (this._ytPlayer && this._ytPlayer.getDuration) {
                const duration = this._ytPlayer.getDuration();
                const targetTime = (percent / 100) * duration;
                if (this._ytPlayer.seekTo) this._ytPlayer.seekTo(targetTime, true);
            }
            this._resetAutoHide();
        });

        return this._overlay;
    }

    onMounted() {
        // Steal global keydown
        document.addEventListener('keydown', this._handleKeyDown, true);

        // Register focus trap with grid orientation to allow two-dimensional traversal
        // Filter out elements marked disabled or with negative tab index so the
        // directional focus calculator only evaluates actively selectable targets.
        focusManager.register('trailer-player', this._osdEl, {
            selector: '.focusable:not([tabindex="-1"]):not(.osd-btn-disabled):not([disabled])',
            orientation: 'grid'
        });

        // Refresh mount timestamp right when DOM element is committed
        this._mountTime = Date.now();

        // Start player hidden natively and let user interactions trigger the OSD
        this._hideOsd();
        focusManager.setActiveSection('trailer-player');

        // Defer the initial focus assignment by one rendering frame.
        // This is critical on TV platforms: calling focusElement() synchronously
        // immediately after register() can fail because the browser's internal
        // accessibility / focus tree has not yet settled after the DOM was modified.
        // requestAnimationFrame gives the engine one frame to commit the layout.
        requestAnimationFrame(() => {
            focusManager.focusElement(this._playPauseBtn);
        });

        this._loadCurrentTrailer();
    }

    onBeforeDestroy() {
        document.removeEventListener('keydown', this._handleKeyDown, true);

        if (this._overlay) {
            this._overlay.removeEventListener('click', this._onOverlayClick);
            this._overlay.removeEventListener('mousemove', this._onThrottledMouseMove);
        }

        if (this._isProxy) {
            window.removeEventListener('message', this._onProxyMessage);
        }
        if (this._progressTimer) clearInterval(this._progressTimer);
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);
        if (this._mouseMoveThrottle) clearTimeout(this._mouseMoveThrottle);

        if (this._ytPlayer) {
            try {
                this._ytPlayer.destroy();
            } catch (e) {}
        }

        // Clean up queue modal DOM instance
        if (this._queueModalOverlay) {
            this._queueModalOverlay.remove();
            this._queueModalOverlay = null;
        }
        this._isQueueModalOpen = false;

        focusManager.unregister('trailer-player');

        // Restore focus
        if (this._previousFocusTarget) {
            setTimeout(() => {
                focusManager.focusElement(this._previousFocusTarget);
            }, 50);
        }
    }

    _onOverlayClick(e) {
        // While the loading screen is displayed, ignore general clicks to prevent
        // toggling playback or OSD visibility behind the backdrop, but allow direct exit if clicking back.
        if (this._isLoading) {
            const closeBtn = e.target.closest?.('[data-action="close"], [data-action="exit"]');
            if (closeBtn) {
                e.stopPropagation();
                this._executeAction('close');
            }
            return;
        }

        // --------------------------------------------------------------------
        // Queue Modal Click Routing
        // When the queue modal panel is currently presented, handle clicks
        // on queue rows, the backdrop dismiss zone, or prevent background play toggling.
        // --------------------------------------------------------------------
        if (this._isQueueModalOpen) {
            // Check if user clicked on a specific queue row item
            const row = e.target.closest?.('.queue-row[data-index]');
            if (row) {
                e.stopPropagation();
                const idx = parseInt(row.dataset.index, 10);
                if (!isNaN(idx)) {
                    this._selectQueueItem(idx);
                }
                return;
            }

            // Check if user clicked outside the side panel on the backdrop overlay
            if (e.target.classList.contains('queue-modal-overlay') || !e.target.closest?.('.queue-modal')) {
                e.stopPropagation();
                this._closeQueueModal();
                return;
            }

            // Click occurred inside panel header or non-interactive padding - consume event without toggling playback
            e.stopPropagation();
            return;
        }

        // Direct action button clicks (play/pause, rewind, fast forward, next, prev, close/back, queue)
        const btn = e.target.closest('[data-action]');
        if (btn) {
            e.stopPropagation();
            this._executeAction(btn.dataset.action);
            return;
        }

        // Ignore clicks inside the seekbar slider container so scrubbing is not interrupted
        if (e.target.closest('.osd-slider-container')) {
            return;
        }

        // --------------------------------------------------------------------
        // Background Click: Toggle Play / Pause
        // Standard media player UX: clicking anywhere on the video area toggles
        // playback state directly rather than toggling OSD visibility.
        // --------------------------------------------------------------------
        this._showOsd(false);
        this._executeAction('togglePlay');
    }

    _onThrottledMouseMove(e) {
        if (this._mouseMoveThrottle) return;
        this._mouseMoveThrottle = setTimeout(() => {
            this._mouseMoveThrottle = null;
        }, 200);
        this._onMouseMove(e);
    }

    _showLoading() {
        this._isLoading = true;
        // Suppress OSD so transport controls remain tucked cleanly below the loading view
        this._hideOsd();

        if (!this._overlay) return;
        const iframe = this._overlay.querySelector('#trailerIframeContainer');
        const backdrop = this._overlay.querySelector('#trailerBackdrop');
        const spinner = this._overlay.querySelector('.loading-spinner');

        if (iframe) iframe.style.opacity = '0';
        if (backdrop) {
            // Present loading screen on layer 100, firmly above the hidden OSD layer
            backdrop.style.display = 'flex';
            backdrop.style.opacity = '1';
            backdrop.style.visibility = 'visible';
            backdrop.style.zIndex = '100';
        }
        if (spinner) {
            spinner.style.display = 'block';
            spinner.style.animationPlayState = 'running';
        }
    }

    _hideLoading() {
        this._isLoading = false;

        if (!this._overlay) return;
        const iframe = this._overlay.querySelector('#trailerIframeContainer');
        const backdrop = this._overlay.querySelector('#trailerBackdrop');
        const spinner = this._overlay.querySelector('.loading-spinner');

        if (iframe) iframe.style.opacity = '1';
        if (backdrop) {
            // Aggressive repaints for Tizen GPU compositor bugs
            backdrop.style.display = 'none';
            backdrop.style.opacity = '0';
            backdrop.style.visibility = 'hidden';
            backdrop.style.zIndex = '-1';
        }
        if (spinner) {
            spinner.style.display = 'none';
            spinner.style.animationPlayState = 'paused';
        }
    }

    _loadCurrentTrailer() {
        // Reset loading state for this new trailer
        this._showLoading();

        // Master failsafe: if neither the YT API nor the fallback succeeds in shedding the loader
        // after 5 seconds, forcefully clear it so the UI never permanently hangs.
        if (this._globalLoadFailsafe) clearTimeout(this._globalLoadFailsafe);
        this._globalLoadFailsafe = setTimeout(() => {
            console.warn('[TrailerPlayer] Master load failsafe triggered - forcing loader reveal');
            this._hideLoading();
        }, 5000);

        const trailer = this._trailers[this._currentIndex];
        this._titleEl.textContent = trailer.Name || 'Trailer';

        // --------------------------------------------------------------------
        // Reset playback telemetry & scrubbing state for incoming video stream
        // Prevents ghost timestamps from the previous trailer persisting on UI.
        // --------------------------------------------------------------------
        this._currentTimeEl.textContent = '00:00';
        this._totalTimeEl.textContent = '00:00';
        this._positionFillEl.style.width = '0%';
        this._positionSliderEl.value = 0;
        this._proxyCurrentTime = 0;
        this._proxyDuration = 0;
        this._isSeeking = false;

        // Visual play state initial toggle
        this._isPlaying = true;
        this._playPauseBtn.innerHTML = osdIcons.pause;

        // --------------------------------------------------------------------
        // Configure previous trailer button state based on current playlist index
        // --------------------------------------------------------------------
        if (this._currentIndex === 0) {
            this._prevBtn.classList.add('osd-btn-disabled');
            this._prevBtn.setAttribute('tabindex', '-1');
            // If the element losing availability currently holds active focus,
            // fall back immediately to central play/pause control.
            if (focusManager.getFocused() === this._prevBtn) {
                focusManager.focusElement(this._playPauseBtn);
            }
        } else {
            this._prevBtn.classList.remove('osd-btn-disabled');
            this._prevBtn.setAttribute('tabindex', '0');
        }

        // --------------------------------------------------------------------
        // Configure next trailer button state based on remaining items in playlist
        // --------------------------------------------------------------------
        if (this._currentIndex === this._trailers.length - 1) {
            this._nextBtn.classList.add('osd-btn-disabled');
            this._nextBtn.setAttribute('tabindex', '-1');
            // Graceful handover to avoid lingering focus on disabled targets
            if (focusManager.getFocused() === this._nextBtn) {
                focusManager.focusElement(this._playPauseBtn);
            }
        } else {
            this._nextBtn.classList.remove('osd-btn-disabled');
            this._nextBtn.setAttribute('tabindex', '0');
        }

        // Clear any cursor hover markers that might be stuck on newly disabled buttons
        this._clearMagicHover();

        // Invalidate spatial navigation cache so the FocusManager rebuilds the
        // valid target matrix reflecting the latest button availability.
        focusManager.invalidateCache('trailer-player');

        // If the queue modal overlay is currently rendered, rebuild rows to reflect current trailer
        if (this._queueModalOverlay) {
            this._renderQueueModal();
            if (this._isQueueModalOpen) {
                this._queueModalOverlay.classList.add('visible');
                this._queueFocusIndex = this._currentIndex;
                this._updateQueueFocus();
                this._scrollActiveQueueItemIntoView();
            }
        }

        if (trailer.IsProxyFallback) {
            this._executeFallbackSearch(trailer);
            return;
        }

        const url = trailer.Url || '';
        console.log('[TrailerPlayer] _loadCurrentTrailer url=', url);

        // For phase 1 we only perfectly support YouTube via the API
        const ytId = this._extractYouTubeId(url);
        console.log('[TrailerPlayer] extracted ytId=', ytId);

        if (ytId) {
            if (this._isProxy) {
                this._initProxyPlayer(ytId);
            } else {
                this._initYouTubePlayer(ytId);
            }
        } else {
            // Fallback: generic iframe — no API control
            console.log('[TrailerPlayer] No YouTube ID, falling back to raw iframe');
            const iframeRow = this._overlay.querySelector('#trailerIframeContainer');
            iframeRow.innerHTML = `<iframe src="${url}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay"></iframe>`;
        }
    }

    async _executeFallbackSearch(trailer) {
        this._titleEl.textContent = i18n.t('Searching') || 'Searching for trailer...';
        const iframeRow = this._overlay.querySelector('#trailerIframeContainer');
        iframeRow.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;font-size:1.5rem;"><div class="spinner" style="margin-right:16px;"></div>${i18n.t('Searching') || 'Searching for trailer...'}</div>`;

        try {
            // Use i18n.currentLang — the i18n module stores the active language there
            const lang = i18n.currentLang || 'en';
            const qs = `?tmdbId=${trailer.TmdbId || ''}&title=${encodeURIComponent(trailer.ItemName || '')}&year=${trailer.ItemYear || ''}&lang=${lang}&type=${trailer.ItemType === 'Series' ? 'tv' : 'movie'}`;
            console.log('[TrailerPlayer] Querying fallback crawler:', `http://localhost:8123/trailer${qs}`);
            const res = await fetch(`http://localhost:8123/trailer${qs}`);
            const data = await res.json();

            if (data && data.key) {
                console.log('[TrailerPlayer] Crawler found key:', data.key, 'source:', data.source);
                this._titleEl.textContent = trailer.Name || 'Trailer';
                this._initProxyPlayer(data.key);
            } else {
                console.warn('[TrailerPlayer] Crawler returned no key:', data);
                iframeRow.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;font-size:1.5rem;">${i18n.t('NoTrailerFound') || 'No trailer found.'}</div>`;
            }
        } catch (e) {
            console.error('[TrailerPlayer] Fallback crawler failed:', (e && e.message) || e);
            iframeRow.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;font-size:1.5rem;">${i18n.t('NoTrailerFound') || 'No trailer found.'}</div>`;
        }
    }

    _extractYouTubeId(url) {
        if (!url) return null;
        const yt = url.match(/[?&]v=([^&]+)/);
        if (yt) return yt[1];
        const ytShort = url.match(/youtu\.be\/([^?]+)/);
        if (ytShort) return ytShort[1];
        return null;
    }

    _initYouTubePlayer(videoId) {
        const container = this._overlay.querySelector('#trailerIframeContainer');
        // Ensure fallback override styles are cleared for programmatic API playback
        if (container) {
            container.classList.remove('trailer-fallback-mode');
        }

        // --------------------------------------------------------------------
        // Existing YouTube Player Reuse Optimization
        // If player instance is already active and healthy, execute seamless
        // in-place video loading rather than reconstructing the whole iframe.
        // --------------------------------------------------------------------
        if (this._ytPlayer && typeof this._ytPlayer.loadVideoById === 'function') {
            console.log('[TrailerPlayer] Reusing existing YT player, loading videoId directly:', videoId);
            try {
                this._ytPlayer.loadVideoById(videoId);
                return;
            } catch (loadErr) {
                console.warn('[TrailerPlayer] loadVideoById failed, recreating player:', loadErr);
            }
        }

        // Clean up previous instance and unbound listeners before creating fresh host
        if (this._ytPlayer && typeof this._ytPlayer.destroy === 'function') {
            try {
                this._ytPlayer.destroy();
            } catch (destroyErr) {
                console.warn('[TrailerPlayer] Error destroying old YT player instance:', destroyErr);
            }
            this._ytPlayer = null;
        }

        /* Ensure host container has explicit full viewport geometry before YT instantiation
           so YouTube does not measure 0px height and default to low resolution streams */
        container.innerHTML =
            '<div id="yt-player-host" style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;"></div>';

        const createPlayer = () => this._createYTPlayer(videoId);

        console.log(
            '[TrailerPlayer] _initYouTubePlayer videoId=',
            videoId,
            '| window.YT=',
            !!window.YT,
            '| window.YT.Player=',
            !!(window.YT && window.YT.Player)
        );

        if (window.YT && window.YT.Player) {
            /* ── API already fully loaded, instantiate immediately ── */
            console.log('[TrailerPlayer] YT API already ready, calling createPlayer directly');
            createPlayer();
        } else {
            /* ── API not ready yet — register callback FIRST, then inject script ── */
            const prevCallback = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                console.log('[TrailerPlayer] onYouTubeIframeAPIReady fired! window.YT=', !!window.YT);
                if (typeof prevCallback === 'function') prevCallback();
                createPlayer();
            };

            const existingTag = document.querySelector('script[src*="youtube.com/iframe_api"]');
            if (!existingTag) {
                console.log('[TrailerPlayer] Injecting YouTube iframe_api script tag');
                const tag = document.createElement('script');
                tag.src = 'https://www.youtube.com/iframe_api';
                tag.onload = () => console.log('[TrailerPlayer] iframe_api script onload fired');
                tag.onerror = (e) => {
                    /* The iframe_api script cannot be loaded — this happens on Tizen/WebOS
                       packaged apps where the local WebView origin blocks external JS injection.
                       Fall back to a plain <iframe> embed with all params in the URL. YouTube's
                       own built-in TV player controls will handle playback. */
                    console.warn('[TrailerPlayer] iframe_api failed to load, falling back to embed iframe', e);
                    this._fallbackToEmbedIframe(videoId);
                };
                document.head.appendChild(tag);
            } else {
                console.log('[TrailerPlayer] Script tag already in DOM, waiting for callback. src=', existingTag.src);
            }
        }
    }

    /**
     * Last-resort fallback when the YouTube iframe_api script cannot be loaded.
     *
     * Instead of the programmatic YT.Player, we inject a plain <iframe> pointing
     * at the YouTube embed URL with all playback params baked into the query string.
     * This works in any WebView that can reach youtube.com — no JS API handshake needed.
     *
     * We hide our custom OSD in this mode because there is no programmatic control;
     * YouTube's own cinematic TV interface takes over inside the iframe.
     *
     * @param {string} videoId - YouTube video ID
     */
    _fallbackToEmbedIframe(videoId) {
        console.log('[TrailerPlayer] using embed iframe fallback for videoId=', videoId);

        const container = this._overlay.querySelector('#trailerIframeContainer');

        /* Build the embed URL with all desired params in the query string.
           origin + host are the key fix for error 153 (embed denied) — YouTube
           validates that the embedding page's origin matches before allowing playback. */
        const paramsObj = {
            autoplay: '1',
            controls: '1', // Show native controls since we can't drive it via JS
            rel: '0',
            modestbranding: '1',
            playsinline: '1',
            enablejsapi: '0', // Explicitly off — we're in fallback, not using the API
            fs: '1', // Allow fullscreen from native controls
            iv_load_policy: '3',
            cc_load_policy: '0', // Suppress automatic closed captions
            cc_lang_pref: 'none', // Prevent language auto-matching
            vq: 'hd1080', // High definition quality parameter hint
            origin: 'https://www.youtube.com',
            host: 'https://www.youtube.com'
        };

        const paramsString = Object.keys(paramsObj)
            .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(paramsObj[key]))
            .join('&');

        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${videoId}?${paramsString}`;
        iframe.width = '100%';
        iframe.height = '100%';
        iframe.setAttribute('frameborder', '0');
        // Include full capabilities (encrypted-media is required by Chrome for Widevine HD streams)
        iframe.allow =
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
        iframe.allowFullscreen = true;

        const revealIframe = () => {
            if (this._overlay) {
                this._hideLoading();
            }
        };

        iframe.addEventListener('load', revealIframe);

        // Failsafe: some TV browsers swallow cross-origin load events
        setTimeout(revealIframe, 3000);

        // Tag container so CSS restores native pointer events and unscaled layout
        if (container) {
            container.classList.add('trailer-fallback-mode');
        }

        container.innerHTML = '';
        container.appendChild(iframe);

        /* Hide our custom OSD — we have no JS handle into this iframe */
        this._hideOsd();
    }

    _createYTPlayer(videoId) {
        console.log(
            '[TrailerPlayer] _createYTPlayer called, videoId=',
            videoId,
            '| YT.Player=',
            typeof window.YT?.Player
        );
        /* ── playerVars mirroring the jellyfin-web youtubePlayer plugin ─────
           Key differences from the old config:
             • enablejsapi: 1  — allows postMessage control, mandatory on TV browsers
             • playsinline: 1  — prevents native fullscreen hijack on some platforms
             • origin          — must match the page origin so the iframe API handshake succeeds
             • autoplay removed — unreliable inside sandboxed iframes on TV; we call
                                  playVideo() explicitly in the onReady callback instead
             • disablekb removed — this was blocking API command delivery on Tizen/WebOS */
        /* Explicitly provide physical viewport pixel dimensions to YT Player.
           Passing string percentage dimensions ('100%') causes YouTube's adaptive bitrate
           ladder to initialize against an unmeasured container, defaulting to 144p-360p. */
        const targetWidth = window.innerWidth || 1920;
        const targetHeight = window.innerHeight || 1080;

        this._ytPlayer = new window.YT.Player('yt-player-host', {
            width: targetWidth,
            height: targetHeight,
            videoId: videoId,
            playerVars: {
                autoplay: 1, // Start playback immediately to prevent initial paused state
                controls: 0, // Hide native YT UI; we draw our own OSD
                enablejsapi: 1, // Enable JS API postMessage bridge
                modestbranding: 1, // Minimal YouTube branding
                rel: 0, // No related videos on end
                showinfo: 0, // Deprecated but safe to include
                fs: 0, // No native fullscreen button
                playsinline: 1, // Inline playback, don't hijack full screen
                iv_load_policy: 3, // No video annotations
                cc_load_policy: 0, // Disable automatic closed captions
                cc_lang_pref: 'none', // Prevent auto-enabling localized subtitles
                vq: 'hd1080', // Target 1080p resolution hint
                // origin + host are the primary fix for error 153 (embed denied).
                // Using youtube.com (not nocookie) matches what YouTube validates against.
                origin: 'https://www.youtube.com',
                host: 'https://www.youtube.com'
            },
            events: {
                onReady: (e) => this._onYTReady(e),
                onStateChange: (e) => this._onYTStateChange(e),
                onPlaybackQualityChange: (e) => this._onYTQualityChange(e),
                onError: (e) => this._onYTError(e)
            }
        });
        console.log('[TrailerPlayer] YT.Player instantiated:', this._ytPlayer);
    }

    _onYTError(event) {
        // YT error codes: 2=bad param, 5=HTML5 error, 100=not found, 101/150=embed denied
        const errorMap = {
            2: 'Bad request',
            5: 'HTML5 error',
            100: 'Not found',
            101: 'Embed denied',
            150: 'Embed denied'
        };
        const msg = errorMap[event.data] || `Error ${event.data}`;
        console.warn('[TrailerPlayer] YouTube error:', msg);
        // Auto-advance to next trailer on error
        this._executeAction('next');
    }

    _onYTReady(event) {
        // Force highest resolution tier and strip closed captions immediately
        this._requestHighestQuality(event.target);
        this._disableCaptions(event.target);

        // Ensure the generated iframe element has complete capability permissions
        // (encrypted-media is strictly required by Chromium for HD adaptive streaming)
        try {
            const iframe = event.target.getIframe?.() || this._overlay.querySelector('#trailerIframeContainer iframe');
            if (iframe) {
                iframe.setAttribute(
                    'allow',
                    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
                );
                iframe.setAttribute('allowfullscreen', 'true');
                iframe.style.width = '100%';
                iframe.style.height = '100%';
            }
        } catch (e) {}

        event.target.playVideo();
        this._startProgressUpdate();

        // Failsafe timer: only shed loading overlay after ample handshake time
        // if autoplay policy prevented state change to PLAYING
        setTimeout(() => {
            this._hideLoading();
            this._requestHighestQuality(event.target);
            this._disableCaptions(event.target);
        }, 3500);

        // Try to get real YouTube title immediately once ready
        try {
            const data = event.target.getVideoData();
            if (data && data.title) {
                this._titleEl.textContent = data.title;
            }
        } catch (e) {}
    }

    _onYTStateChange(event) {
        // YT.PlayerState.PLAYING = 1, PAUSED = 2, ENDED = 0, BUFFERING = 3
        if (event.data === 1) {
            // Playing state active - display filled pause design
            this._isPlaying = true;
            this._playPauseBtn.innerHTML = osdIcons.pause;
            this._hideLoading();

            // Re-apply highest quality request and suppress captions as playback begins
            this._disableCaptions(event.target);
            this._requestHighestQuality(event.target);

            // Try again on play in case data was delayed
            try {
                const data = this._ytPlayer.getVideoData();
                if (data && data.title) {
                    this._titleEl.textContent = data.title;
                }
            } catch (e) {}
        } else if (event.data === 3) {
            // Buffering state: prime stream quality before frames are decoded
            this._disableCaptions(event.target);
            this._requestHighestQuality(event.target);
        } else if (event.data === 2) {
            // Paused state active - display filled play design
            this._isPlaying = false;
            this._playPauseBtn.innerHTML = osdIcons.play;
        } else if (event.data === 0) {
            // Ended
            this._executeAction('next'); // Auto-advance to next trailer
        }
    }

    /**
     * Unload and disable YouTube closed captions / subtitles.
     * YouTube embeds frequently auto-enable CC based on user cookies or device locale;
     * unloading the caption module ensures clean trailer playback without subtitle overlay.
     *
     * @param {Object} [player] - YouTube Player instance
     */
    _disableCaptions(player = this._ytPlayer) {
        if (!player) return;
        try {
            if (typeof player.unloadModule === 'function') {
                player.unloadModule('captions');
                player.unloadModule('cc');
            }
        } catch (e) {}
        try {
            if (typeof player.setOption === 'function') {
                player.setOption('captions', 'track', {});
                player.setOption('cc', 'track', {});
            }
        } catch (e) {}
    }

    /**
     * Request highest available playback quality from YouTube immediately.
     * Evaluates available quality tiers from the player (e.g. hd1080, hd720)
     * and sets both the quality range and requested playback tier to prevent
     * YouTube's adaptive bitrate engine from starting at low definition (144p-360p).
     *
     * @param {Object} [player] - YouTube Player instance
     */
    _requestHighestQuality(player = this._ytPlayer) {
        if (!player) return;
        // Guard check: if already running target HD resolution, avoid re-requesting
        try {
            if (typeof player.getPlaybackQuality === 'function') {
                const currentQuality = player.getPlaybackQuality();
                if (
                    currentQuality === 'hd1080' ||
                    currentQuality === 'highres' ||
                    currentQuality === 'hd1440' ||
                    currentQuality === 'hd2160'
                ) {
                    return;
                }
            }
        } catch (e) {}
        try {
            if (typeof player.setPlaybackQuality === 'function') {
                const levels =
                    typeof player.getAvailableQualityLevels === 'function' ? player.getAvailableQualityLevels() : null;

                if (Array.isArray(levels) && levels.length > 0) {
                    const preferred = ['highres', 'hd2160', 'hd1440', 'hd1080', 'hd720'];
                    const target = preferred.find((p) => levels.includes(p)) || levels[0];
                    if (target && target !== 'auto') {
                        player.setPlaybackQuality(target);
                    }
                } else {
                    player.setPlaybackQuality('hd1080');
                }
            }
        } catch (e) {}
    }

    _onYTQualityChange(event) {
        console.log('[TrailerPlayer] YouTube playback quality updated:', event?.data);
    }

    _startProgressUpdate() {
        if (this._progressTimer) clearInterval(this._progressTimer);
        this._progressTimer = setInterval(this._updateProgress, 500);
    }

    _updateProgress() {
        if (!this._ytPlayer || !this._ytPlayer.getCurrentTime || !this._ytPlayer.getDuration) return;

        try {
            const current = this._ytPlayer.getCurrentTime();
            const total = this._ytPlayer.getDuration();

            if (total > 0) {
                // Time strings need ticks (seconds * 10,000,000)
                this._currentTimeEl.textContent = this._formatTicks(current * 10000000);

                const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
                const isRemaining = timeDisplayMode === 'remaining';
                const durationDisplaySecs = isRemaining ? total - current : total;
                const totalStr = (isRemaining ? '-' : '') + this._formatTicks(durationDisplaySecs * 10000000);
                this._totalTimeEl.textContent = totalStr;

                const percent = (current / total) * 100;

                // Only force slider value/visuals if user isn't actively interacting with it
                if (!this._isDraggingSlider && !this._isSeeking) {
                    this._positionFillEl.style.width = `${percent}%`;
                    this._positionSliderEl.value = Math.max(0, Math.min(100, percent));
                }
            }
        } catch (e) {
            // YT player might be destroyed
        }
    }

    _formatTicks(ticks) {
        if (!ticks || isNaN(ticks)) return '00:00';
        const totalSeconds = Math.floor(ticks / 10000000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    _executeAction(action) {
        this._resetAutoHide();

        switch (action) {
            case 'close':
            case 'exit':
                this._close();
                break;
            case 'togglePlay':
                // Debounce guard: reject synthetic keyup activation clicks right on mount
                if (Date.now() - this._mountTime < 600) {
                    return;
                }
                if (this._isProxy) {
                    this._sendProxyCommand(this._isPlaying ? 'pause' : 'play');
                } else if (this._ytPlayer) {
                    if (this._isPlaying) {
                        this._ytPlayer.pauseVideo();
                    } else {
                        this._ytPlayer.playVideo();
                    }
                }
                break;
            case 'rewind': {
                let targetSecs = 0,
                    durationSecs = 0;
                if (this._isProxy && this._proxyCurrentTime !== undefined && this._proxyDuration) {
                    targetSecs = Math.max(0, this._proxyCurrentTime - 5);
                    durationSecs = this._proxyDuration;
                    this._proxyCurrentTime = targetSecs;
                    this._sendProxyCommand('seek', targetSecs * 1000);
                } else if (this._ytPlayer && this._ytPlayer.getCurrentTime && this._ytPlayer.getDuration) {
                    const ct = this._ytPlayer.getCurrentTime();
                    durationSecs = this._ytPlayer.getDuration();
                    targetSecs = Math.max(0, ct - 5);
                    this._ytPlayer.seekTo(targetSecs, true);
                }

                if (durationSecs > 0) {
                    this._isSeeking = true;
                    if (this._seekLockTimer) clearTimeout(this._seekLockTimer);
                    this._seekLockTimer = setTimeout(() => (this._isSeeking = false), 1500);

                    this._currentTimeEl.textContent = this._formatTicks(targetSecs * 10000000);

                    const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
                    const isRemaining = timeDisplayMode === 'remaining';
                    const durationDisplaySecs = isRemaining ? durationSecs - targetSecs : durationSecs;
                    const totalStr = (isRemaining ? '-' : '') + this._formatTicks(durationDisplaySecs * 10000000);
                    this._totalTimeEl.textContent = totalStr;

                    const percent = (targetSecs / durationSecs) * 100;
                    this._positionFillEl.style.width = `${percent}%`;
                    this._positionSliderEl.value = Math.max(0, Math.min(100, percent));
                }
                break;
            }
            case 'fastForward': {
                let targetSecs = 0,
                    durationSecs = 0;
                if (this._isProxy && this._proxyCurrentTime !== undefined && this._proxyDuration) {
                    targetSecs = Math.min(this._proxyDuration, this._proxyCurrentTime + 5);
                    durationSecs = this._proxyDuration;
                    this._proxyCurrentTime = targetSecs;
                    this._sendProxyCommand('seek', targetSecs * 1000);
                } else if (this._ytPlayer && this._ytPlayer.getCurrentTime && this._ytPlayer.getDuration) {
                    const ct = this._ytPlayer.getCurrentTime();
                    durationSecs = this._ytPlayer.getDuration();
                    targetSecs = Math.min(durationSecs, ct + 5);
                    this._ytPlayer.seekTo(targetSecs, true);
                }

                if (durationSecs > 0) {
                    this._isSeeking = true;
                    if (this._seekLockTimer) clearTimeout(this._seekLockTimer);
                    this._seekLockTimer = setTimeout(() => (this._isSeeking = false), 1500);

                    this._currentTimeEl.textContent = this._formatTicks(targetSecs * 10000000);

                    const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
                    const isRemaining = timeDisplayMode === 'remaining';
                    const durationDisplaySecs = isRemaining ? durationSecs - targetSecs : durationSecs;
                    const totalStr = (isRemaining ? '-' : '') + this._formatTicks(durationDisplaySecs * 10000000);
                    this._totalTimeEl.textContent = totalStr;

                    const percent = (targetSecs / durationSecs) * 100;
                    this._positionFillEl.style.width = `${percent}%`;
                    this._positionSliderEl.value = Math.max(0, Math.min(100, percent));
                }
                break;
            }
            case 'prev':
                // Debounce rapid sequential triggers to allow video decoder to stabilize
                if (this._isChangingTrailer) return;
                if (this._currentIndex > 0) {
                    this._isChangingTrailer = true;
                    setTimeout(() => {
                        this._isChangingTrailer = false;
                    }, 800);
                    this._currentIndex--;
                    this._loadCurrentTrailer();
                }
                break;
            case 'next':
                // Debounce rapid sequential triggers to prevent skipping over trailers
                if (this._isChangingTrailer) return;
                if (this._currentIndex < this._trailers.length - 1) {
                    this._isChangingTrailer = true;
                    setTimeout(() => {
                        this._isChangingTrailer = false;
                    }, 800);
                    this._currentIndex++;
                    this._loadCurrentTrailer();
                } else {
                    // Ends playback if no more trailers
                    this._close();
                }
                break;
            case 'queue':
                // Open or close the trailer queue playlist modal
                this._toggleQueueModal();
                break;
        }
    }

    _handleKeyDown(e) {
        // While the trailer is actively loading/buffering, suppress OSD reveal so the
        // loading backdrop remains completely clean, while still honoring Back/Exit keys.
        if (this._isLoading) {
            if (e.keyCode === 461 || e.keyCode === 10009 || e.keyCode === 27 || e.keyCode === 8) {
                e.preventDefault();
                e.stopPropagation();
                this._close();
            }
            return;
        }

        // --------------------------------------------------------------------
        // Handle Back / Return / Escape navigation
        // Standard player UX:
        //  1. If the Queue Modal is currently open, initial Back dismisses it
        //  2. If the OSD overlay is currently visible, initial Back press hides it
        //  3. If the OSD overlay is already hidden, Back press exits playback
        // (Note: The on-screen OSD back button explicitly triggers 'close' and always exits)
        // --------------------------------------------------------------------
        const isBackKey = e.keyCode === 461 || e.keyCode === 10009 || e.keyCode === 27 || e.keyCode === 8;
        if (isBackKey) {
            e.preventDefault();
            e.stopPropagation();
            if (this._isQueueModalOpen) {
                this._closeQueueModal();
            } else if (this._isOsdVisible) {
                this._hideOsd();
            } else {
                this._close();
            }
            return;
        }

        // --------------------------------------------------------------------
        // Trailer Queue Modal Key Interception
        // When the modal overlay is active, route directional navigation
        // directly to the trailer playlist list without triggering media playback shortcuts.
        // --------------------------------------------------------------------
        if (this._isQueueModalOpen) {
            switch (e.keyCode) {
                case 38: // Up arrow: move focus up
                    e.preventDefault();
                    e.stopPropagation();
                    this._moveQueueFocus(-1);
                    return;
                case 40: // Down arrow: move focus down
                    e.preventDefault();
                    e.stopPropagation();
                    this._moveQueueFocus(1);
                    return;
                case 37: // Left arrow: dismiss modal back to transport controls
                    e.preventDefault();
                    e.stopPropagation();
                    this._closeQueueModal();
                    return;
                case 13: // Enter: select and switch to chosen trailer
                    e.preventDefault();
                    e.stopPropagation();
                    // Debounce rapid Enter presses right after panel opening
                    if (this._queueOpenedAt && Date.now() - this._queueOpenedAt < 300) {
                        return;
                    }
                    this._selectQueueItem(this._queueFocusIndex);
                    return;
                default:
                    // Consume any other hotkeys while modal is open
                    e.preventDefault();
                    e.stopPropagation();
                    return;
            }
        }

        const wasHidden = !this._isOsdVisible;

        // Reset auto-hide countdown and keep OSD visibly displayed
        // Crucial: pass shouldFocus = false so that simple key interactions
        // do not forcefully steal or reset focus back to the play/pause button!
        this._resetAutoHide();
        this._showOsd(false);

        // Dynamically place focus only upon initial wakeup from hidden state
        if (wasHidden) {
            if (e.keyCode === 37 || e.keyCode === 39) {
                // If woken by a seek action (Left/Right), focus the slider so the user can continue seeking quickly
                focusManager.focusElement(this._positionSliderEl);
            } else {
                // Otherwise default to the play/pause button
                focusManager.focusElement(this._playPauseBtn);
            }
        }

        switch (e.keyCode) {
            case 10252: // MediaPlayPause
            case 415: // MediaPlay
            case 19: // Pause
            case 32: // Space
                e.preventDefault();
                e.stopPropagation();
                this._executeAction('togglePlay');
                return;
            case 37: // Left
                if (wasHidden || this._positionSliderEl.classList.contains('focused')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._executeAction('rewind');
                    return;
                }
                break;
            case 39: // Right
                if (wasHidden || this._positionSliderEl.classList.contains('focused')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._executeAction('fastForward');
                    return;
                }
                break;
            case 412: // MediaRewind
                e.preventDefault();
                e.stopPropagation();
                this._executeAction('rewind');
                return;
            case 417: // MediaFastForward
                e.preventDefault();
                e.stopPropagation();
                this._executeAction('fastForward');
                return;
            case 413: // MediaStop
                e.preventDefault();
                e.stopPropagation();
                this._close();
                return;
            case 34: // WebOS Prev
            case 10232: // Tizen Prev
                e.preventDefault();
                e.stopPropagation();
                this._executeAction('prev');
                return;
            case 33: // WebOS Next
            case 10233: // Tizen Next
                e.preventDefault();
                e.stopPropagation();
                this._executeAction('next');
                return;
        }
    }

    _onMouseMove(e) {
        // Ignore cursor movement triggers while the loading view is presented
        if (this._isLoading) return;

        // If the trailer queue modal is open, handle row hover selection
        if (this._isQueueModalOpen) {
            const row = e?.target?.closest?.('.queue-row[data-index]');
            if (row) {
                const idx = parseInt(row.dataset.index, 10);
                if (!isNaN(idx) && idx !== this._queueFocusIndex) {
                    this._queueFocusIndex = idx;
                    this._updateQueueFocus();
                }
            }
            return;
        }

        if (!PlayerSettings.get('enableMagicCursor')) return;
        this._showOsd(false);

        if (!e) return;

        // Programmatic hover support for Magic Remote / Mouse
        const els = document.elementsFromPoint(e.clientX, e.clientY);
        let targetBtn = null;

        for (const el of els) {
            // Find the first OSD button or slider under the cursor
            const btn = el.closest?.('[data-action], .osd-slider-container');
            if (btn) {
                targetBtn = btn;
                break;
            }
        }

        // Clean up previous hover
        if (this._lastHoveredEl && this._lastHoveredEl !== targetBtn) {
            this._lastHoveredEl.classList.remove('magic-hover');
        }

        // Apply new hover
        if (targetBtn) {
            targetBtn.classList.add('magic-hover');
            this._lastHoveredEl = targetBtn;
        } else {
            this._lastHoveredEl = null;
        }
    }

    _showOsd(shouldFocus = true) {
        this._isOsdVisible = true;
        this._osdEl.classList.remove('osd-is-hidden');
        this._osdEl.querySelector('.osd-main').classList.remove('osd-hidden');

        if (shouldFocus) {
            this._clearMagicHover();
            // Only lock focus if explicitly requested (e.g. D-pad or click)
            focusManager.setActiveSection('trailer-player');
            focusManager.focusElement(this._playPauseBtn);
        }

        this._resetAutoHide();
    }

    _hideOsd() {
        // Do not auto-hide the OSD while the trailer queue modal is open
        if (this._isQueueModalOpen) return;
        this._isOsdVisible = false;
        this._osdEl.classList.add('osd-is-hidden');
        this._osdEl.querySelector('.osd-main').classList.add('osd-hidden');
        this._clearMagicHover();
    }

    _clearMagicHover() {
        if (this._osdEl) {
            this._osdEl.querySelectorAll('.magic-hover').forEach((el) => el.classList.remove('magic-hover'));
        }
        this._lastHoveredEl = null;
    }

    _toggleOsd() {
        if (this._isOsdVisible) {
            this._hideOsd();
        } else {
            this._showOsd();
        }
    }

    _resetAutoHide() {
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);
        // Only auto hide if playing AND the queue modal is not open
        if (this._isPlaying && !this._isQueueModalOpen) {
            this._autoHideTimer = setTimeout(() => this._hideOsd(), 4000);
        }
    }

    // =========================================================================
    // Trailer Queue Modal Management
    // =========================================================================

    /**
     * Toggles the visibility state of the trailer queue modal overlay.
     * If the queue is open, dismisses it; otherwise, prepares and shows it.
     *
     * @param {boolean} [forceShow] - Optional explicit toggle state override.
     */
    _toggleQueueModal(forceShow) {
        // Evaluate destination display state
        const shouldShow = forceShow !== undefined ? forceShow : !this._isQueueModalOpen;

        // Route to opening or dismissal handlers
        if (shouldShow) {
            this._openQueueModal();
        } else {
            this._closeQueueModal();
        }
    }

    /**
     * Opens the trailer queue modal, populating list entries from this._trailers,
     * highlighting the currently active trailer, and centering it into the viewport.
     */
    _openQueueModal() {
        // Prevent opening while loading or if already open
        if (this._isQueueModalOpen || this._isLoading) return;

        // Mark state and suspend auto-hide timer while user browses queue
        this._isQueueModalOpen = true;
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);

        // Render queue modal markup into the overlays container
        this._renderQueueModal();

        // Reveal panel with CSS transition
        if (this._queueModalOverlay) {
            this._queueModalOverlay.classList.add('visible');
        }

        // Initialize focus cursor at currently playing trailer index
        this._queueFocusIndex = this._currentIndex;
        this._updateQueueFocus();

        // Scroll the currently active trailer item into view
        this._scrollActiveQueueItemIntoView();

        // Record timestamp to debounce instant accidental Enter triggers
        this._queueOpenedAt = Date.now();
    }

    /**
     * Dismisses the trailer queue modal panel and restores focus to OSD controls.
     */
    _closeQueueModal() {
        if (!this._isQueueModalOpen) return;

        // Clear active modal open flag
        this._isQueueModalOpen = false;

        // Trigger slide-out and backdrop fade dismissal
        if (this._queueModalOverlay) {
            this._queueModalOverlay.classList.remove('visible');
        }

        // Restore focus to Queue button or play/pause button
        focusManager.setActiveSection('trailer-player');
        if (this._queueBtn && this._queueBtn.getAttribute('tabindex') !== '-1') {
            focusManager.focusElement(this._queueBtn);
        } else {
            focusManager.focusElement(this._playPauseBtn);
        }

        // Invalidate spatial navigation cache
        focusManager.invalidateCache('trailer-player');

        // Resume standard playback auto-hide countdown
        this._resetAutoHide();
    }

    /**
     * Constructs the full DOM tree for the trailer queue modal matching the
     * native player QueueModal layout and CSS classes.
     */
    _renderQueueModal() {
        if (!this._overlaysContainer) {
            this._overlaysContainer = this._overlay.querySelector('#trailerOsdOverlays');
            if (!this._overlaysContainer) return;
        }

        // Clean up any stale modal overlay instance
        if (this._queueModalOverlay) {
            this._queueModalOverlay.remove();
            this._queueModalOverlay = null;
        }

        const overlay = document.createElement('div');
        overlay.className = 'queue-modal-overlay';
        overlay.id = 'trailerQueueModalOverlay';

        // Prepare movie or show context name for row subtitles
        const parentItemName = this._parentPage?._item?.Name || this._parentPage?._item?.OriginalTitle || '';
        const parentItemYear = this._parentPage?._item?.ProductionYear || '';

        // Generate rows HTML for each trailer
        const rowsHtml = (this._trailers || [])
            .map((trailer, index) => {
                const isActive = index === this._currentIndex;
                const name = trailer.Name || `${i18n.t('Trailer') || 'Trailer'} ${index + 1}`;

                // Determine thumbnail URL: priority to YouTube thumbnail, then parent item art
                const ytId = this._extractYouTubeId(trailer.Url);
                let thumbUrl = '';
                if (ytId) {
                    thumbUrl = `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`;
                } else if (this._parentPage?._item?.Id) {
                    thumbUrl =
                        api.getImageUrl(this._parentPage._item.Id, 'Primary', { maxHeight: 120 }) ||
                        api.getImageUrl(this._parentPage._item.Id, 'Backdrop', { maxWidth: 240 }) ||
                        '';
                }

                // Compose contextual subtitle
                let subtitle = '';
                if (trailer.ItemName) {
                    subtitle = `${trailer.ItemName}${trailer.ItemYear ? ` (${trailer.ItemYear})` : ''}`;
                } else if (parentItemName) {
                    subtitle = `${parentItemName}${parentItemYear ? ` (${parentItemYear})` : ''}`;
                }

                const fallbackHtml = this._getFallbackHtml(name);

                return `
                <div class="queue-row ${isActive ? 'queue-row--active' : ''}"
                     data-index="${index}"
                     tabindex="${isActive ? '0' : '-1'}">

                    <!-- Queue position indicator -->
                    <span class="queue-row__number">${index + 1}</span>

                    <!-- Video thumbnail preview wrap -->
                    <div class="queue-row__thumb-wrap">
                        ${
                            thumbUrl
                                ? `
                            <img class="queue-row__thumb" src="${thumbUrl}" alt=""
                                 onerror="this.style.display='none'; const fb = this.parentElement.querySelector('.media-fallback'); if(fb) fb.style.display='flex';" />
                            <div style="display: none; width: 100%; height: 100%;">
                                ${fallbackHtml}
                            </div>
                        `
                                : fallbackHtml
                        }
                        ${isActive ? '<div class="queue-row__playing-indicator"></div>' : ''}
                    </div>

                    <!-- Trailer info textual metadata -->
                    <div class="queue-row__info">
                        <span class="queue-row__name">${name}</span>
                        ${subtitle ? `<span class="queue-row__subtitle">${subtitle}</span>` : ''}
                    </div>
                </div>
            `;
            })
            .join('');

        const countText = `${this._trailers.length} ${this._trailers.length === 1 ? i18n.t('Item') || 'item' : i18n.t('Items') || 'items'}`;

        overlay.innerHTML = `
            <div class="queue-modal">
                <!-- Modal header bar -->
                <div class="queue-modal__header">
                    <span class="queue-modal__title">${i18n.t('Trailers') || 'Trailers'}</span>
                    <span class="queue-modal__count">${countText}</span>
                </div>

                <!-- Scrollable list of trailers -->
                <div class="queue-modal__list" id="trailerQueueModalList">
                    ${rowsHtml || `<p class="queue-modal__empty">${i18n.t('NoTrailersAvailable') || 'No trailers available.'}</p>`}
                </div>
            </div>
        `;

        this._overlaysContainer.appendChild(overlay);
        this._queueModalOverlay = overlay;
    }

    /**
     * Generates a deterministic fallback gradient artwork card with user initials
     * matching the core Litefin media-fallback stylesheet specifications.
     *
     * @param {string} name - Title string to hash for gradient selection.
     * @returns {string} HTML snippet representing the fallback card.
     */
    _getFallbackHtml(name) {
        let hash = 0;
        for (let i = 0; i < (name || '').length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const gradNum = (Math.abs(hash) % 6) + 1;
        const words = (name || '').trim().split(/[\s_-]+/);
        let initials = words[0] ? words[0][0] : '?';
        if (words.length > 1 && words[1]) initials += words[1][0];
        initials = initials.toUpperCase();

        return `
            <div class="media-fallback grad-${gradNum}" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                <div class="media-fallback-initials">${initials}</div>
                <div class="media-fallback-name">${name || ''}</div>
            </div>
        `;
    }

    /**
     * Updates the focus visual treatment on queue rows and auto-scrolls the
     * focused item into view.
     */
    _updateQueueFocus() {
        if (!this._queueModalOverlay) return;

        // Clear previous focus highlight on all rows
        this._queueModalOverlay.querySelectorAll('.queue-row').forEach((row) => {
            row.classList.remove('focused');
        });

        // Apply focus highlight to active target row
        const targetRow = this._queueModalOverlay.querySelector(`.queue-row[data-index="${this._queueFocusIndex}"]`);
        if (targetRow) {
            targetRow.classList.add('focused');
            targetRow.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
    }

    /**
     * Adjusts the current queue focus selection index by the given delta offset.
     *
     * @param {number} delta - Step distance (-1 for up, 1 for down).
     */
    _moveQueueFocus(delta) {
        const count = this._trailers ? this._trailers.length : 0;
        if (count === 0) return;

        // Clamp index between valid list bounds
        this._queueFocusIndex = Math.max(0, Math.min(count - 1, this._queueFocusIndex + delta));
        this._updateQueueFocus();
    }

    /**
     * Automatically scrolls the actively playing trailer row to the center
     * of the list panel upon opening.
     */
    _scrollActiveQueueItemIntoView() {
        if (!this._queueModalOverlay) return;
        const activeRow = this._queueModalOverlay.querySelector('.queue-row--active');
        if (activeRow) {
            activeRow.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
    }

    /**
     * Selects and loads a target trailer by index from the queue list.
     *
     * @param {number} index - Index of selected trailer in this._trailers.
     */
    _selectQueueItem(index) {
        if (index < 0 || index >= this._trailers.length) return;

        // If a different trailer was selected, trigger transition
        if (index !== this._currentIndex) {
            if (this._isChangingTrailer) return;
            this._isChangingTrailer = true;
            setTimeout(() => {
                this._isChangingTrailer = false;
            }, 800);

            this._currentIndex = index;
            this._loadCurrentTrailer();
        }

        // Close the queue modal overlay
        this._closeQueueModal();

        // Route primary control focus to Play/Pause
        focusManager.setActiveSection('trailer-player');
        focusManager.focusElement(this._playPauseBtn);
        focusManager.invalidateCache('trailer-player');
    }

    _close() {
        if (this._isProxy) {
            this._sendProxyCommand('stop');
        }
        this.destroy();
    }

    _initProxyPlayer(videoId) {
        const container = this._overlay.querySelector('#trailerIframeContainer');
        // Clear fallback mode class to enforce isolated headless styling
        if (container) {
            container.classList.remove('trailer-fallback-mode');
        }
        container.innerHTML = `<iframe id="ytProxyIframe" src="http://localhost:8123/player.html?videoId=${encodeURIComponent(videoId)}" width="100%" height="100%" frameborder="0" allow="autoplay; encrypted-media; fullscreen"></iframe>`;
        this._proxyIframe = this._overlay.querySelector('#ytProxyIframe');

        window.removeEventListener('message', this._onProxyMessage);
        window.addEventListener('message', this._onProxyMessage);

        this._proxyDuration = 0;
        this._proxyCurrentTime = 0;
    }

    _onProxyMessage(ev) {
        if (!ev.data || !ev.data.__ytbridge) return;
        const msg = ev.data;

        if (msg.event === 'playing') {
            this._isPlaying = true;
            this._playPauseBtn.innerHTML = osdIcons.pause;
            this._hideLoading();
            this._resetAutoHide();
        } else if (msg.event === 'paused') {
            this._isPlaying = false;
            this._playPauseBtn.innerHTML = osdIcons.play;
            this._resetAutoHide();
        } else if (msg.type === 'time') {
            this._proxyCurrentTime = msg.t / 1000;
            this._proxyDuration = msg.d / 1000;

            if (this._proxyDuration > 0) {
                this._currentTimeEl.textContent = this._formatTicks(this._proxyCurrentTime * 10000000);

                const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
                const isRemaining = timeDisplayMode === 'remaining';
                const durationDisplaySecs = isRemaining
                    ? this._proxyDuration - this._proxyCurrentTime
                    : this._proxyDuration;
                const totalStr = (isRemaining ? '-' : '') + this._formatTicks(durationDisplaySecs * 10000000);
                this._totalTimeEl.textContent = totalStr;

                const percent = (this._proxyCurrentTime / this._proxyDuration) * 100;

                // Only force slider value/visuals if user isn't actively interacting with it
                if (!this._isDraggingSlider && !this._isSeeking) {
                    this._positionFillEl.style.width = `${percent}%`;
                    this._positionSliderEl.value = Math.max(0, Math.min(100, percent));
                }
            }

            // Sync playback state indicator without triggering auto-advance loops.
            // Note: Auto-advance (next trailer) is strictly handled by discrete 'state'
            // events below to prevent 500ms heartbeat polling from triggering repetitive calls.
            if (msg.s !== undefined && msg.s !== -1) {
                if (msg.s === 1) {
                    this._isPlaying = true;
                    this._playPauseBtn.innerHTML = osdIcons.pause;
                } else if (msg.s === 2) {
                    this._isPlaying = false;
                    this._playPauseBtn.innerHTML = osdIcons.play;
                }
            }
        } else if (msg.type === 'state') {
            const state = msg.data;
            if (state === 1) {
                this._isPlaying = true;
                this._playPauseBtn.innerHTML = osdIcons.pause;
                this._hideLoading();
                this._resetAutoHide();
            } else if (state === 2) {
                this._isPlaying = false;
                this._playPauseBtn.innerHTML = osdIcons.play;
                this._resetAutoHide();
            } else if (state === 0) {
                // Discrete completion event from playback engine: advance to next trailer
                this._executeAction('next');
            }
        } else if (msg.type === 'title') {
            if (msg.data && this._titleEl.textContent !== msg.data) {
                this._titleEl.textContent = msg.data;
            }
        }
    }

    _sendProxyCommand(cmd, val) {
        if (this._proxyIframe && this._proxyIframe.contentWindow) {
            this._proxyIframe.contentWindow.postMessage({ __ytbridge_cmd: true, cmd: cmd, val: val }, '*');
        }
    }
}
