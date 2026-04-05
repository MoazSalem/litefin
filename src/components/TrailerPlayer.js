import Component from '../core/Component.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { ICONS } from '../player/osd/icons.js'; // Borrowing native OSD icons
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
        
        // Focus state restoration
        this._previousFocusTarget = focusManager.getFocused();
        
        // Bindings
        this._handleKeyDown = this._handleKeyDown.bind(this);
        this._onYTReady = this._onYTReady.bind(this);
        this._onYTStateChange = this._onYTStateChange.bind(this);
        this._updateProgress = this._updateProgress.bind(this);
        this._onProxyMessage = this._onProxyMessage.bind(this);
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
        
        const backdropStyle = backdropUrl ? `background-image: url('${backdropUrl}'); background-size: cover; background-position: center;` : 'background-color: #000;';

        this._overlay.innerHTML = `
            <div class="trailer-iframe-container" id="trailerIframeContainer" style="opacity: 0; transition: opacity 0.5s ease; position: absolute; top:0; left:0; width: 100%; height: 100%; z-index: 1;"></div>
            
            <div class="player-osd trailer-osd osd-is-hidden" id="trailerOsd" style="z-index: 2;">
                <div class="osd-main">
                    <!-- Header -->
                    <div class="osd-header">
                        <div class="osd-header-left">
                            <button class="osd-btn osd-back-btn focusable" data-action="close" aria-label="${i18n.t('Close') || 'Close'}" tabindex="0">
                                ${ICONS.arrowBack}
                            </button>
                            <span class="osd-title" id="trailerTitle"></span>
                        </div>
                    </div>

                    <!-- Bottom Area -->
                    <div class="osd-bottom">
                        <div class="osd-controls-row" style="justify-content: center;">
                            <div class="osd-controls-left" style="margin: 0 auto;">
                                <button class="osd-btn focusable" data-action="prev" tabindex="0" id="trailerPrevBtn">${ICONS.skipPrevious}</button>
                                <button class="osd-btn focusable" data-action="rewind" tabindex="0">${ICONS.fastRewind}</button>
                                <button class="osd-btn osd-btn-play focusable" id="trailerPlayPauseBtn" data-action="togglePlay" tabindex="0">${ICONS.pause}</button>
                                <button class="osd-btn focusable" data-action="fastForward" tabindex="0">${ICONS.fastForward}</button>
                                <button class="osd-btn focusable" data-action="next" tabindex="0" id="trailerNextBtn">${ICONS.skipNext}</button>
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
            </div>

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
        this._currentTimeEl = this._overlay.querySelector('#trailerCurrentTime');
        this._totalTimeEl = this._overlay.querySelector('#trailerTotalTime');
        this._positionFillEl = this._overlay.querySelector('#trailerPositionFill');
        this._positionSliderEl = this._overlay.querySelector('#trailerPositionSlider');

        // Bind clicks
        this._overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (btn) {
                e.stopPropagation();
                this._executeAction(btn.dataset.action);
            } else {
                // Click anywhere else toggles OSD
                this._toggleOsd();
            }
        });

        // Scrubbing via slider
        this._positionSliderEl.addEventListener('mousedown', () => this._isDraggingSlider = true);
        this._positionSliderEl.addEventListener('touchstart', () => this._isDraggingSlider = true, { passive: true });
        
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
            this._seekLockTimer = setTimeout(() => this._isSeeking = false, 1500);

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

        // Register focus trap with grid orientation to allow up/down
        focusManager.register('trailer-player', this._osdEl, {
            selector: '.focusable',
            orientation: 'grid'
        });
        
        // Start player hidden natively and let user interactions trigger the OSD
        this._hideOsd();
        focusManager.setActiveSection('trailer-player');
        focusManager.focusElement(this._playPauseBtn);
        
        this._loadCurrentTrailer();
    }

    onBeforeDestroy() {
        document.removeEventListener('keydown', this._handleKeyDown, true);
        
        if (this._isProxy) { window.removeEventListener('message', this._onProxyMessage); }
        if (this._progressTimer) clearInterval(this._progressTimer);
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);
        
        if (this._ytPlayer) {
            try { this._ytPlayer.destroy(); } catch(e){}
        }

        focusManager.unregister('trailer-player');

        // Restore focus
        if (this._previousFocusTarget) {
            setTimeout(() => {
                focusManager.focusElement(this._previousFocusTarget);
            }, 50);
        }
    }

    _showLoading() {
        if (!this._overlay) return;
        const iframe = this._overlay.querySelector('#trailerIframeContainer');
        const backdrop = this._overlay.querySelector('#trailerBackdrop');
        const spinner = this._overlay.querySelector('.loading-spinner');
        
        if (iframe) iframe.style.opacity = '0';
        if (backdrop) {
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
        
        // Update nav buttons
        if (this._currentIndex === 0) {
            this._prevBtn.classList.add('osd-btn-disabled');
            this._prevBtn.setAttribute('tabindex', '-1');
        } else {
            this._prevBtn.classList.remove('osd-btn-disabled');
            this._prevBtn.setAttribute('tabindex', '0');
        }

        if (this._currentIndex === this._trailers.length - 1) {
            this._nextBtn.classList.add('osd-btn-disabled');
            this._nextBtn.setAttribute('tabindex', '-1');
        } else {
            this._nextBtn.classList.remove('osd-btn-disabled');
            this._nextBtn.setAttribute('tabindex', '0');
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
            console.error('[TrailerPlayer] Fallback crawler failed:', e && e.message || e);
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
        container.innerHTML = '<div id="yt-player-host"></div>';

        const createPlayer = () => this._createYTPlayer(videoId);

        console.log('[TrailerPlayer] _initYouTubePlayer videoId=', videoId,
            '| window.YT=', !!window.YT,
            '| window.YT.Player=', !!(window.YT && window.YT.Player));

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
            autoplay:         '1',
            controls:         '1', // Show native controls since we can't drive it via JS
            rel:              '0',
            modestbranding:   '1',
            playsinline:      '1',
            enablejsapi:      '0', // Explicitly off — we're in fallback, not using the API
            fs:               '1', // Allow fullscreen from native controls
            iv_load_policy:   '3',
            origin:           'https://www.youtube.com',
            host:             'https://www.youtube.com'
        };

        const paramsString = Object.keys(paramsObj)
            .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(paramsObj[key]))
            .join('&');

        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${videoId}?${paramsString}`;
        iframe.width = '100%';
        iframe.height = '100%';
        iframe.setAttribute('frameborder', '0');
        iframe.allow = 'autoplay; encrypted-media; fullscreen';
        iframe.allowFullscreen = true;
        
        const revealIframe = () => {
            if (this._overlay) {
                this._hideLoading();
            }
        };

        iframe.addEventListener('load', revealIframe);
        
        // Failsafe: some TV browsers swallow cross-origin load events
        setTimeout(revealIframe, 3000);

        container.innerHTML = '';
        container.appendChild(iframe);

        /* Hide our custom OSD — we have no JS handle into this iframe */
        this._hideOsd();
    }

    _createYTPlayer(videoId) {
        console.log('[TrailerPlayer] _createYTPlayer called, videoId=', videoId, '| YT.Player=', typeof window.YT?.Player);
        /* ── playerVars mirroring the jellyfin-web youtubePlayer plugin ─────
           Key differences from the old config:
             • enablejsapi: 1  — allows postMessage control, mandatory on TV browsers
             • playsinline: 1  — prevents native fullscreen hijack on some platforms
             • origin          — must match the page origin so the iframe API handshake succeeds
             • autoplay removed — unreliable inside sandboxed iframes on TV; we call
                                  playVideo() explicitly in the onReady callback instead
             • disablekb removed — this was blocking API command delivery on Tizen/WebOS */
        this._ytPlayer = new window.YT.Player('yt-player-host', {
            videoId: videoId,
            playerVars: {
                controls: 0,        // Hide native YT UI; we draw our own OSD
                enablejsapi: 1,     // Enable JS API postMessage bridge
                modestbranding: 1,  // Minimal YouTube branding
                rel: 0,             // No related videos on end
                showinfo: 0,        // Deprecated but safe to include
                fs: 0,              // No native fullscreen button
                playsinline: 1,     // Inline playback, don't hijack full screen
                iv_load_policy: 3,  // No video annotations
                // origin + host are the primary fix for error 153 (embed denied).
                // Using youtube.com (not nocookie) matches what YouTube validates against.
                origin: 'https://www.youtube.com',
                host:   'https://www.youtube.com'
            },
            events: {
                'onReady': (e) => this._onYTReady(e),
                'onStateChange': (e) => this._onYTStateChange(e),
                'onError': (e) => this._onYTError(e)
            }
        });
        console.log('[TrailerPlayer] YT.Player instantiated:', this._ytPlayer);
    }

    _onYTError(event) {
        // YT error codes: 2=bad param, 5=HTML5 error, 100=not found, 101/150=embed denied
        const errorMap = { 2: 'Bad request', 5: 'HTML5 error', 100: 'Not found', 101: 'Embed denied', 150: 'Embed denied' };
        const msg = errorMap[event.data] || `Error ${event.data}`;
        console.warn('[TrailerPlayer] YouTube error:', msg);
        // Auto-advance to next trailer on error
        this._executeAction('next');
    }

    _onYTReady(event) {
        event.target.playVideo();
        this._startProgressUpdate();
        
        // Failsafe: if autoplay is blocked, it will never reach PLAYING state.
        // Reveal the player once the API confirms it is loaded.
        setTimeout(() => {
            this._hideLoading();
        }, 500);

        // Try to get real YouTube title immediately once ready
        try {
            const data = event.target.getVideoData();
            if (data && data.title) {
                this._titleEl.textContent = data.title;
            }
        } catch(e) {}
    }

    _onYTStateChange(event) {
        // YT.PlayerState.PLAYING = 1, PAUSED = 2, ENDED = 0
        if (event.data === 1) { // Playing
            this._isPlaying = true;
            this._playPauseBtn.innerHTML = ICONS.pause;
            this._hideLoading();
            
            // Try again on play in case data was delayed
            try {
                const data = this._ytPlayer.getVideoData();
                if (data && data.title) {
                    this._titleEl.textContent = data.title;
                }
            } catch(e) {}
            
        } else if (event.data === 2) { // Paused
            this._isPlaying = false;
            this._playPauseBtn.innerHTML = ICONS.play;
        } else if (event.data === 0) { // Ended
            this._executeAction('next'); // Auto-advance to next trailer
        }
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
                const durationDisplaySecs = isRemaining ? (total - current) : total;
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
        if (!ticks || isNaN(ticks)) return "00:00";
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
                let targetSecs = 0, durationSecs = 0;
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
                    this._seekLockTimer = setTimeout(() => this._isSeeking = false, 1500);
                    
                    this._currentTimeEl.textContent = this._formatTicks(targetSecs * 10000000);
                    
                    const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
                    const isRemaining = timeDisplayMode === 'remaining';
                    const durationDisplaySecs = isRemaining ? (durationSecs - targetSecs) : durationSecs;
                    const totalStr = (isRemaining ? '-' : '') + this._formatTicks(durationDisplaySecs * 10000000);
                    this._totalTimeEl.textContent = totalStr;
                    
                    const percent = (targetSecs / durationSecs) * 100;
                    this._positionFillEl.style.width = `${percent}%`;
                    this._positionSliderEl.value = Math.max(0, Math.min(100, percent));
                }
                break;
            }
            case 'fastForward': {
                let targetSecs = 0, durationSecs = 0;
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
                    this._seekLockTimer = setTimeout(() => this._isSeeking = false, 1500);
                    
                    this._currentTimeEl.textContent = this._formatTicks(targetSecs * 10000000);
                    
                    const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
                    const isRemaining = timeDisplayMode === 'remaining';
                    const durationDisplaySecs = isRemaining ? (durationSecs - targetSecs) : durationSecs;
                    const totalStr = (isRemaining ? '-' : '') + this._formatTicks(durationDisplaySecs * 10000000);
                    this._totalTimeEl.textContent = totalStr;
                    
                    const percent = (targetSecs / durationSecs) * 100;
                    this._positionFillEl.style.width = `${percent}%`;
                    this._positionSliderEl.value = Math.max(0, Math.min(100, percent));
                }
                break;
            }
            case 'prev':
                if (this._currentIndex > 0) {
                    this._currentIndex--;
                    this._loadCurrentTrailer();
                }
                break;
            case 'next':
                if (this._currentIndex < this._trailers.length - 1) {
                    this._currentIndex++;
                    this._loadCurrentTrailer();
                } else {
                    // Ends playback if no more trailers
                    this._close();
                }
                break;
        }
    }

    _handleKeyDown(e) {
        const wasHidden = !this._isOsdVisible;
        
        // Tizen specific keys and generic media keys intercept
        this._resetAutoHide();
        this._showOsd();

        // Dynamically place focus upon wakeup
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
            case 461: // WebOS Back
            case 10009: // Return
            case 27: // Escape
            case 8: // Backspace
                e.preventDefault();
                e.stopPropagation();
                this._close();
                return;
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

    _showOsd() {
        this._isOsdVisible = true;
        this._osdEl.classList.remove('osd-is-hidden');
        this._osdEl.querySelector('.osd-main').classList.remove('osd-hidden');
        
        // Trap focus into OSD
        if (focusManager.getActiveSection() !== 'trailer-player') {
            focusManager.setActiveSection('trailer-player');
            focusManager.focusElement(this._playPauseBtn);
        }
        
        this._resetAutoHide();
    }

    _hideOsd() {
        this._isOsdVisible = false;
        this._osdEl.classList.add('osd-is-hidden');
        this._osdEl.querySelector('.osd-main').classList.add('osd-hidden');
        // We do not drop the focus trap, just let the buttons be visually hidden and disabled naturally via CSS opacity
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
        // Only auto hide if playing
        if (this._isPlaying) {
            this._autoHideTimer = setTimeout(() => this._hideOsd(), 4000);
        }
    }

    _close() {
        if (this._isProxy) {
            this._sendProxyCommand('stop');
        }
        this.destroy();
    }

    _initProxyPlayer(videoId) {
        const container = this._overlay.querySelector('#trailerIframeContainer');
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
            this._playPauseBtn.innerHTML = ICONS.pause;
            this._hideLoading();
        } else if (msg.event === 'paused') {
            this._isPlaying = false;
            this._playPauseBtn.innerHTML = ICONS.play;
            this._resetAutoHide();
        } else if (msg.type === 'time') {
            this._proxyCurrentTime = msg.t / 1000;
            this._proxyDuration = msg.d / 1000;
            
            if (this._proxyDuration > 0) {
                this._currentTimeEl.textContent = this._formatTicks(this._proxyCurrentTime * 10000000);
                
                const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
                const isRemaining = timeDisplayMode === 'remaining';
                const durationDisplaySecs = isRemaining ? (this._proxyDuration - this._proxyCurrentTime) : this._proxyDuration;
                const totalStr = (isRemaining ? '-' : '') + this._formatTicks(durationDisplaySecs * 10000000);
                this._totalTimeEl.textContent = totalStr;
                
                const percent = (this._proxyCurrentTime / this._proxyDuration) * 100;
                
                // Only force slider value/visuals if user isn't actively interacting with it
                if (!this._isDraggingSlider && !this._isSeeking) {
                    this._positionFillEl.style.width = `${percent}%`;
                    this._positionSliderEl.value = Math.max(0, Math.min(100, percent));
                }
            }
            
            if (msg.s !== undefined && msg.s !== -1) {
                if (msg.s === 1) { 
                    this._isPlaying = true; 
                    this._playPauseBtn.innerHTML = ICONS.pause; 
                } else if (msg.s === 2) { 
                    this._isPlaying = false; 
                    this._playPauseBtn.innerHTML = ICONS.play; 
                } else if (msg.s === 0) {
                    this._executeAction('next');
                }
            }
        } else if (msg.type === 'state') {
            const state = msg.data;
            if (state === 1) { 
                this._isPlaying = true; 
                this._playPauseBtn.innerHTML = ICONS.pause; 
            } else if (state === 2) { 
                this._isPlaying = false; 
                this._playPauseBtn.innerHTML = ICONS.play; 
            } else if (state === 0) {
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
