import Component from '../core/Component.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { ICONS } from '../player/osd/icons.js'; // Borrowing native OSD icons

/**
 * TrailerPlayer
 * Displays a fullscreen iframe to play remote trailers (mostly YouTube),
 * with a minimal OSD that matches the native Tizen player UI.
 */
export class TrailerPlayer extends Component {
    constructor(trailers, parentPage) {
        super();
        this._trailers = trailers;
        this._parentPage = parentPage;
        
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
    }

    static show(trailers, parentPage) {
        if (!trailers || !trailers.length) return;
        const player = new TrailerPlayer(trailers, parentPage);
        player.mount(document.body);
        return player;
    }

    render() {
        this._overlay = document.createElement('div');
        this._overlay.className = 'trailer-player-overlay';
        this._overlay.style.zIndex = '99999'; // Ensure it's above everything

        this._overlay.innerHTML = `
            <div class="trailer-iframe-container" id="trailerIframeContainer"></div>
            
            <div class="player-osd trailer-osd osd-is-hidden" id="trailerOsd">
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
        this._positionSliderEl.addEventListener('change', (e) => {
            if (this._ytPlayer && this._ytPlayer.getDuration) {
                const percent = parseFloat(e.target.value);
                const duration = this._ytPlayer.getDuration();
                const targetTime = (percent / 100) * duration;
                this._ytPlayer.seekTo(targetTime, true);
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
        
        // Show initial loading state OSD
        this._showOsd();
        this._loadCurrentTrailer();
    }

    onBeforeDestroy() {
        document.removeEventListener('keydown', this._handleKeyDown, true);
        
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

    _loadCurrentTrailer() {
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

        const url = trailer.Url || '';
        
        // For phase 1 we only perfectly support YouTube via the API
        const ytId = this._extractYouTubeId(url);
        
        if (ytId) {
            this._initYouTubePlayer(ytId);
        } else {
            // Fallback: generic iframe — no API control
            const iframeRow = this._overlay.querySelector('#trailerIframeContainer');
            iframeRow.innerHTML = `<iframe src="${url}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay"></iframe>`;
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

        // Load API script if needed
        if (!window.YT || !window.YT.Player) {
            const tag = document.createElement('script');
            tag.src = "https://www.youtube.com/iframe_api";
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            
            // Wait for API ready
            window.onYouTubeIframeAPIReady = () => {
                this._createYTPlayer(videoId);
            };
        } else {
            this._createYTPlayer(videoId);
        }
    }

    _createYTPlayer(videoId) {
        this._ytPlayer = new window.YT.Player('yt-player-host', {
            videoId: videoId,
            playerVars: {
                autoplay: 1,
                controls: 0, // Disable YT native controls, we provide our OSD
                disablekb: 1, // Disable YT keyboard controls
                fs: 0,
                rel: 0,
                modestbranding: 1,
                iv_load_policy: 3
            },
            events: {
                'onReady': (e) => this._onYTReady(e),
                'onStateChange': (e) => this._onYTStateChange(e)
            }
        });
    }

    _onYTReady(event) {
        event.target.playVideo();
        this._startProgressUpdate();
        
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
                this._totalTimeEl.textContent = this._formatTicks(total * 10000000);
                
                const percent = (current / total) * 100;
                this._positionFillEl.style.width = `${percent}%`;
                // Only update physical slider value if not actively dragging/focused
                if (document.activeElement !== this._positionSliderEl) {
                    this._positionSliderEl.value = percent;
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
                if (!this._ytPlayer) break;
                if (this._isPlaying) {
                    this._ytPlayer.pauseVideo();
                } else {
                    this._ytPlayer.playVideo();
                }
                break;
            case 'rewind':
                if (this._ytPlayer && this._ytPlayer.getCurrentTime) {
                    const ct = this._ytPlayer.getCurrentTime();
                    this._ytPlayer.seekTo(Math.max(0, ct - 10), true);
                }
                break;
            case 'fastForward':
                if (this._ytPlayer && this._ytPlayer.getCurrentTime && this._ytPlayer.getDuration) {
                    const ct = this._ytPlayer.getCurrentTime();
                    const dur = this._ytPlayer.getDuration();
                    this._ytPlayer.seekTo(Math.min(dur, ct + 30), true);
                }
                break;
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
        // Tizen specific keys and generic media keys intercept
        this._resetAutoHide();
        this._showOsd();

        switch (e.keyCode) {
            case 10009: // Return
            case 27: // Escape
            case 8: // Backspace
                e.preventDefault();
                e.stopPropagation();
                this._close();
                return;
            case 415: // MediaPlay
            case 19: // Pause
            case 32: // Space
                e.preventDefault();
                e.stopPropagation();
                this._executeAction('togglePlay');
                return;
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
        this.destroy();
    }
}
