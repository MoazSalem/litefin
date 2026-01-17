/**
 * Player OSD - On-Screen Display Controller
 * 
 * Manages the video player overlay UI for Litefin.
 * Layout matches Jellyfin Tizen TV OSD.
 */

(function () {
    'use strict';

    // ========================================================================
    // Debug Mode (Enable with ?debug=true in URL)
    // ========================================================================
    const DEBUG_ENABLED = new URLSearchParams(window.location.search).get('debug') === 'true';

    const originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info
    };

    // Only set up debug overlay if debug mode is enabled
    if (DEBUG_ENABLED) {
        function initDebugOverlay() {
            if (!document.getElementById('debug-overlay')) {
                const overlay = document.createElement('div');
                overlay.id = 'debug-overlay';
                document.body.appendChild(overlay);
            }
        }

        function logToOverlay(type, args) {
            initDebugOverlay();
            const overlay = document.getElementById('debug-overlay');
            if (overlay) {
                const msg = args.map(arg =>
                    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
                ).join(' ');

                // Only show important logs
                const isImportant = type === 'error' ||
                    msg.includes('[DeviceProfile]') ||
                    msg.includes('[TizenAVPlayer]') ||
                    msg.includes('[JellyfinPlayer]') ||
                    msg.includes('[OSD]') ||
                    msg.includes('Tizen');

                if (!isImportant) return;

                const line = document.createElement('div');
                line.className = `log-${type}`;
                line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
                overlay.insertBefore(line, overlay.firstChild);

                // Limit lines
                if (overlay.children.length > 100) {
                    overlay.removeChild(overlay.lastChild);
                }
            }
        }

        // Override console methods to log to overlay
        console.log = function (...args) {
            originalConsole.log.apply(console, args);
            logToOverlay('info', args);
        };

        console.error = function (...args) {
            originalConsole.error.apply(console, args);
            logToOverlay('error', args);
        };

        console.warn = function (...args) {
            originalConsole.warn.apply(console, args);
            logToOverlay('warn', args);
        };

        console.info = function (...args) {
            originalConsole.info.apply(console, args);
            logToOverlay('info', args);
        };
    }

    // Capture global errors
    window.onerror = function (msg, url, line, col, error) {
        console.error('Global Error:', msg, url, line, col, error);
        return false;
    };

    // ========================================================================
    // Configuration
    // ========================================================================

    const CONFIG = {
        autoHideDelay: 5000,
        updateInterval: 500,
        seekStepBack: 5000,    // 5 seconds default
        seekStepForward: 10000 // 10 seconds default
    };

    // ========================================================================
    // State
    // ========================================================================

    let osdElement = null;
    let autoHideTimer = null;
    let updateTimer = null;
    let isOsdVisible = false;
    let isDraggingSeekbar = false;
    let seekDebounceTimer = null;
    let seekTargetTicks = null;
    let seekStartTime = null; // Track when continuous seeking started (for speed acceleration)

    // Track menu state
    let trackMenuOverlay = null;
    let isTrackMenuOpen = false;
    let trackMenuType = null; // 'subtitles' or 'audio'
    let trackMenuFocusIndex = 0;
    let currentSubtitleIndex = -1;
    let currentAudioIndex = 0;

    // ========================================================================
    // Material Design Icons
    // ========================================================================

    const ICONS = {
        arrowBack: '<span class="material-icons">arrow_back</span>',
        skipPrevious: '<span class="material-icons">skip_previous</span>',
        skipNext: '<span class="material-icons">skip_next</span>',
        fastRewind: '<span class="material-icons">fast_rewind</span>',
        fastForward: '<span class="material-icons">fast_forward</span>',
        play: '<span class="material-icons">play_arrow</span>',
        pause: '<span class="material-icons">pause</span>',
        closedCaption: '<span class="material-icons">closed_caption</span>',
        audiotrack: '<span class="material-icons">audiotrack</span>',
        settings: '<span class="material-icons">settings</span>',
        favorite: '<span class="material-icons">favorite_border</span>',
        favoriteFilled: '<span class="material-icons">favorite</span>',
        sync: '<span class="material-icons">sync</span>',
        check: '<span class="material-icons">check</span>'
    };

    // ========================================================================
    // Initialization
    // ========================================================================

    function init(options = {}) {
        osdElement = document.getElementById('osd-overlay');
        if (!osdElement) {
            console.error('[OSD] osd-overlay element not found');
            return;
        }

        Object.assign(CONFIG, options);
        addMaterialIcons();
        render();
        bindEvents();
        startUpdates();
        hide();

        // Set initial focus on play button and start auto-hide timer
        // setTimeout(() => updateFocus(), 100);
        resetAutoHide();

        console.log('[OSD] Initialized');

        // Bind to player events for track updates
        const player = window.playerInstance;
        if (player) {
            player.on('mediastreamschange', onMediaStreamsChange);

            // Initialize state from player
            if (player.getCurrentAudioStreamIndex) {
                const aIndex = player.getCurrentAudioStreamIndex();
                if (aIndex !== undefined) currentAudioIndex = aIndex;
            }
            if (player.getCurrentSubtitleStreamIndex) {
                const sIndex = player.getCurrentSubtitleStreamIndex();
                if (sIndex !== undefined) currentSubtitleIndex = sIndex;
            }
        }
    }

    function onMediaStreamsChange(e) {
        console.log('[OSD] onMediaStreamsChange:', e);
        if (e.detail) {
            if (e.detail.audioStreamIndex !== undefined) {
                currentAudioIndex = e.detail.audioStreamIndex;
            }
            if (e.detail.subtitleStreamIndex !== undefined) {
                currentSubtitleIndex = e.detail.subtitleStreamIndex;
            }
        }
    }

    function addMaterialIcons() {
        if (!document.querySelector('link[href*="material-icons"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
            document.head.appendChild(link);
        }
    }

    // ========================================================================
    // Rendering - Tizen TV Layout
    // ========================================================================

    function render() {
        const title = getItemTitle();

        osdElement.innerHTML = `
            <!-- ============================================================ -->
            <!-- TOP HEADER: Back + Title (left), Sync icon (right)           -->
            <!-- ============================================================ -->
            <div class="osd-header">
                <div class="osd-header-left">
                    <button class="osd-btn osd-back-btn" data-action="exit" tabindex="0" title="Back">
                        ${ICONS.arrowBack}
                    </button>
                    <span class="osd-title" id="osdTitle">${title}</span>
                </div>
                <div class="osd-header-right">
                    <span class="osd-sync-icon hide" id="osdSyncIcon">${ICONS.sync}</span>
                    <span class="osd-clock" id="osdClock"></span>
                </div>
            </div>

            <!-- ============================================================ -->
            <!-- BOTTOM OSD: Controls row + Slider row                        -->
            <!-- ============================================================ -->
            <div class="osd-bottom">
                <!-- Controls Row (above slider) -->
                <div class="osd-controls-row">
                    <!-- Left: Playback controls -->
                    <div class="osd-controls-left">
                        <button class="osd-btn" data-action="previousTrack" tabindex="0" title="Previous">
                            ${ICONS.skipPrevious}
                        </button>
                        <button class="osd-btn" data-action="rewind" tabindex="0" title="Rewind">
                            ${ICONS.fastRewind}
                        </button>
                        
                        <!-- Big blue play/pause button -->
                        <button class="osd-btn osd-btn-play" data-action="togglePlay" tabindex="0" id="osdPlayPauseBtn">
                            ${ICONS.pause}
                        </button>
                        
                        <button class="osd-btn" data-action="fastForward" tabindex="0" title="Fast Forward">
                            ${ICONS.fastForward}
                        </button>
                        <button class="osd-btn" data-action="nextTrack" tabindex="0" title="Next">
                            ${ICONS.skipNext}
                        </button>
                        
                        <!-- Ends at (next to play buttons) -->
                        <span class="osd-ends-at" id="osdEndsAt"></span>
                    </div>

                    <!-- Spacer to push right controls to the right -->
                    <div class="osd-spacer"></div>

                    <!-- Right: Media controls -->
                    <div class="osd-controls-right">
                        <button class="osd-btn" data-action="favorite" tabindex="0" title="Favorite" id="osdFavoriteBtn">
                            ${ICONS.favorite}
                        </button>
                        <button class="osd-btn" data-action="subtitles" tabindex="0" title="Subtitles">
                            ${ICONS.closedCaption}
                        </button>
                        <button class="osd-btn" data-action="audio" tabindex="0" title="Audio">
                            ${ICONS.audiotrack}
                        </button>
                        <button class="osd-btn" data-action="settings" tabindex="0" title="Settings">
                            ${ICONS.settings}
                        </button>
                    </div>
                </div>

                <!-- Slider Row (at very bottom) -->
                <div class="osd-slider-row">
                    <span class="osd-time osd-time-current" id="osdCurrentTime">00:00</span>
                    <div class="osd-slider-container">
                        <div class="osd-seek-tooltip" id="osdSeekTooltip">00:00</div>
                        <input type="range" 
                               class="osd-slider" 
                               id="osdPositionSlider"
                               min="0" max="100" value="0" step="0.01"
                               tabindex="0" />
                    </div>
                    <span class="osd-time osd-time-total" id="osdTotalTime">00:00</span>
                </div>
            </div>
        `;
    }

    function getItemTitle() {
        const params = new URLSearchParams(window.location.search);
        const title = params.get('title');
        if (title) return decodeURIComponent(title);
        return 'Now Playing';
    }

    // ========================================================================
    // Event Binding
    // ========================================================================

    function bindEvents() {
        osdElement.addEventListener('click', handleClick);

        const posSlider = document.getElementById('osdPositionSlider');
        if (posSlider) {
            posSlider.addEventListener('input', handlePositionSliderInput);
            posSlider.addEventListener('change', handlePositionSliderChange);
            posSlider.addEventListener('mousedown', () => isDraggingSeekbar = true);
            posSlider.addEventListener('mouseup', () => isDraggingSeekbar = false);
        }

        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('mousemove', handleActivity);
        document.addEventListener('touchstart', handleActivity);
    }

    function handleClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        executeAction(btn.dataset.action);
        resetAutoHide();
    }

    function handlePositionSliderInput(e) {
        const player = window.playerInstance;
        if (!player) return;

        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;
        const percent = parseFloat(e.target.value) / 100;
        const position = duration * percent;

        const currentEl = document.getElementById('osdCurrentTime');
        if (currentEl) {
            currentEl.textContent = formatTime(position);
        }
        resetAutoHide();
    }

    function handlePositionSliderChange(e) {
        isDraggingSeekbar = false;
        const player = window.playerInstance;
        if (!player) return;

        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;
        const percent = parseFloat(e.target.value) / 100;
        const position = Math.floor(duration * percent);

        if (player.seek) player.seek(position);
        resetAutoHide();
    }

    // ========================================================================
    // Focus Management for TV Navigation
    // ========================================================================

    // Define focusable elements in order (row by row)
    // Row 0: Header row (back button)
    // Row 1: Controls row buttons
    // Row 2: Seekbar
    let currentFocusRow = 1;
    let currentFocusIndex = 2; // Start on play button (index 2 in controls)

    function getFocusableElements() {
        // Header row - just the back button
        const headerBackBtn = osdElement.querySelector('.osd-back-btn');
        const headerRow = headerBackBtn ? [headerBackBtn] : [];

        // Get all buttons in controls row (left + right)
        const controlsLeft = Array.from(osdElement.querySelectorAll('.osd-controls-left .osd-btn'));
        const controlsRight = Array.from(osdElement.querySelectorAll('.osd-controls-right .osd-btn'));
        const controlsRow = [...controlsLeft, ...controlsRight];

        // The seekbar
        const seekbar = osdElement.querySelector('.osd-slider');

        return {
            headerRow,
            controlsRow,
            seekbar
        };
    }

    function updateFocus() {
        const { headerRow, controlsRow, seekbar } = getFocusableElements();

        // Remove focus from all elements
        headerRow.forEach(btn => btn.classList.remove('focused'));
        controlsRow.forEach(btn => btn.classList.remove('focused'));
        seekbar?.classList.remove('focused');

        // Apply focus to current element based on row
        if (currentFocusRow === 0) {
            // Header row (back button)
            if (headerRow[0]) {
                headerRow[0].classList.add('focused');
                headerRow[0].focus();
            }
        } else if (currentFocusRow === 1) {
            // Controls row
            const index = Math.min(currentFocusIndex, controlsRow.length - 1);
            if (controlsRow[index]) {
                controlsRow[index].classList.add('focused');
                controlsRow[index].focus();
            }
        } else {
            // Seekbar row
            if (seekbar) {
                seekbar.classList.add('focused');
                seekbar.focus();
            }
        }
    }

    function handleKeyDown(e) {
        // Handle track menu navigation if open
        if (handleTrackMenuKeyDown(e)) {
            return;
        }

        const player = window.playerInstance;
        const wasHidden = !isOsdVisible;
        const isBackKey = [10009, 27, 8].includes(e.keyCode);
        const isPlayKey = [13, 415, 10252].includes(e.keyCode);
        const isMediaSeekKey = [412, 417].includes(e.keyCode); // Rewind/FastForward media keys
        const isLeftRight = [37, 39].includes(e.keyCode);

        // Back key: If OSD visible, hide it. If hidden, exit player.
        if (isBackKey) {
            executeAction('back');
            e.preventDefault();
            return;
        }

        // Always show OSD and reset timer for non-back keys
        show();
        resetAutoHide();

        // ============================================================
        // Play/Pause Keys (OK, Play, Play/Pause)
        // When OSD hidden: focus play button and toggle play
        // When OSD visible: OK activates focused control, Play keys toggle
        // ============================================================
        if (isPlayKey) {
            const isEnterKey = e.keyCode === 13;

            if (wasHidden) {
                // OSD was hidden - focus play button and toggle play
                currentFocusRow = 1;
                currentFocusIndex = 2; // Play button is index 2
                updateFocus();
                executeAction('togglePlay');
            } else if (isEnterKey) {
                // OSD visible + Enter/OK - activate current focused control
                const { headerRow, controlsRow } = getFocusableElements();
                if (currentFocusRow === 0 && headerRow[0]) {
                    executeAction('back');
                } else if (currentFocusRow === 1 && controlsRow[currentFocusIndex]) {
                    const action = controlsRow[currentFocusIndex].dataset.action;
                    if (action) executeAction(action);
                } else if (currentFocusRow === 2) {
                    // On seekbar - toggle play
                    executeAction('togglePlay');
                }
            } else {
                // OSD visible + Play/Pause keys - always toggle play
                executeAction('togglePlay');
            }
            e.preventDefault();
            return;
        }

        // ============================================================
        // Media Seek Keys (Rewind, FastForward) - always seek
        // ============================================================
        if (isMediaSeekKey) {
            currentFocusRow = 2; // Seekbar row
            updateFocus();
            if (e.keyCode === 412) {
                executeAction('rewind');
            } else {
                executeAction('fastForward');
            }
            e.preventDefault();
            return;
        }

        // ============================================================
        // Left/Right Arrow Keys
        // When OSD was hidden: focus seekbar and seek
        // When OSD was visible: navigate controls
        // ============================================================
        if (isLeftRight) {
            if (wasHidden) {
                // OSD was hidden - focus seekbar and seek
                currentFocusRow = 2;
                updateFocus();
                if (e.keyCode === 37) {
                    executeAction('rewind');
                } else {
                    executeAction('fastForward');
                }
            } else {
                // OSD was visible - navigate or seek based on current row
                const { controlsRow } = getFocusableElements();
                if (currentFocusRow === 1) {
                    // Controls row - navigate left/right
                    if (e.keyCode === 37 && currentFocusIndex > 0) {
                        currentFocusIndex--;
                        updateFocus();
                    } else if (e.keyCode === 39 && currentFocusIndex < controlsRow.length - 1) {
                        currentFocusIndex++;
                        updateFocus();
                    }
                } else if (currentFocusRow === 2) {
                    // Seekbar row - seek
                    if (e.keyCode === 37) {
                        executeAction('rewind');
                    } else {
                        executeAction('fastForward');
                    }
                }
                // Row 0 (header) - no left/right navigation
            }
            e.preventDefault();
            return;
        }

        // ============================================================
        // D-Pad Navigation (Up/Down for OSD navigation)
        // ============================================================
        const { headerRow, controlsRow } = getFocusableElements();

        switch (e.keyCode) {
            case 38: // Up arrow
                if (currentFocusRow > 0) {
                    currentFocusRow--;
                    updateFocus();
                }
                e.preventDefault();
                break;

            case 40: // Down arrow
                if (currentFocusRow < 2) {
                    currentFocusRow++;
                    updateFocus();
                }
                e.preventDefault();
                break;

            case 19: // Pause
            case 10253: // Tizen Pause
                if (player && player.pause) player.pause();
                e.preventDefault();
                break;
        }
    }

    function handleActivity() {
        show();
        resetAutoHide();
    }

    // ========================================================================
    // Actions
    // ========================================================================

    function executeAction(action) {
        const player = window.playerInstance;
        if (!player) return;

        switch (action) {
            case 'back':
                // If OSD is visible, hide it first; otherwise exit
                if (isOsdVisible) {
                    hide();
                } else {
                    if (player.stop) player.stop();
                    history.back();
                }
                break;

            case 'exit':
                // Always exit
                if (player.stop) player.stop();
                history.back();
                break;

            case 'togglePlay':
                if (player.togglePlay) player.togglePlay();
                setTimeout(updatePlayPauseButton, 100);
                break;

            case 'rewind':
                const skipBackMs = parseInt(localStorage.getItem('jellyfin-player-skipBackLength')) || CONFIG.seekStepBack;
                performDebouncedSeek(-skipBackMs * 10000); // Convert MS to Ticks
                break;

            case 'fastForward':
                const skipFwdMs = parseInt(localStorage.getItem('jellyfin-player-skipForwardLength')) || CONFIG.seekStepForward;
                performDebouncedSeek(skipFwdMs * 10000); // Convert MS to Ticks
                break;

            case 'previousTrack':
            case 'nextTrack':
                // TODO: Playlist navigation
                break;

            case 'subtitles':
                openTrackMenu('subtitles');
                break;

            case 'audio':
                openTrackMenu('audio');
                break;

            case 'favorite':
                console.log('[OSD] Toggle favorite');
                break;

            case 'settings':
                console.log('[OSD] Settings menu');
                break;
        }
    }

    function performDebouncedSeek(offsetTicks) {
        const player = window.playerInstance;
        if (!player) return;

        try {
            show();
            resetAutoHide();

            // Initialize seek session if starting fresh
            if (seekTargetTicks === null) {
                seekTargetTicks = (player.getCurrentPositionTicks && player.getCurrentPositionTicks()) || 0;
                seekStartTime = Date.now(); // Start tracking seek duration
            }

            // Calculate seek speed multiplier based on how long user has been seeking
            // 0-3s: 1x, 3-5s: 2x, 5-8s: 3x, 8-11s: 4x, 11+: 5x
            const seekDuration = (Date.now() - seekStartTime) / 1000;
            let speedMultiplier = 1;
            if (seekDuration >= 11) {
                speedMultiplier = 5;
            } else if (seekDuration >= 8) {
                speedMultiplier = 4;
            } else if (seekDuration >= 5) {
                speedMultiplier = 3;
            } else if (seekDuration >= 3) {
                speedMultiplier = 2;
            }

            // Ensure offset is a number
            if (isNaN(offsetTicks)) {
                console.error('[OSD] Invalid seek offset:', offsetTicks);
                return;
            }

            // Apply speed multiplier to offset
            const adjustedOffset = offsetTicks * speedMultiplier;
            seekTargetTicks += adjustedOffset;

            // Clamp to duration
            const duration = (player.getDurationTicks && player.getDurationTicks()) || 0;
            if (seekTargetTicks < 0) seekTargetTicks = 0;
            if (seekTargetTicks > duration) seekTargetTicks = duration;

            // Clear existing timer
            if (seekDebounceTimer) {
                clearTimeout(seekDebounceTimer);
            }

            // Update UI with preview
            const previewPlayer = {
                getCurrentPositionTicks: () => seekTargetTicks,
                getDurationTicks: () => duration
            };
            updateTimeDisplay(previewPlayer);
            updatePositionSlider(previewPlayer);

            // Show seek tooltip with target time and speed indicator
            const tooltip = document.getElementById('osdSeekTooltip');
            const slider = document.getElementById('osdPositionSlider');
            if (tooltip && slider) {
                const speedIndicator = speedMultiplier > 1 ? ` (${speedMultiplier}x)` : '';
                tooltip.textContent = formatTime(seekTargetTicks) + speedIndicator;
                tooltip.classList.add('visible');

                // Position tooltip above the current slider position
                const percent = duration > 0 ? (seekTargetTicks / duration) * 100 : 0;
                tooltip.style.left = percent + '%';
            }

            // Set timer to commit seek and reset state
            seekDebounceTimer = setTimeout(() => {
                console.log('[OSD] Committing seek to:', seekTargetTicks);
                if (player.seek) player.seek(seekTargetTicks);
                seekTargetTicks = null;
                seekStartTime = null; // Reset seek session
                seekDebounceTimer = null;

                // Hide tooltip after seek commits
                if (tooltip) tooltip.classList.remove('visible');
            }, 500); // 500ms wait
        } catch (err) {
            console.error('[OSD] Seek error:', err);
            seekTargetTicks = null;
            seekStartTime = null;
        }
    }

    // ========================================================================
    // UI Updates
    // ========================================================================

    function startUpdates() {
        updateTimer = setInterval(updateState, CONFIG.updateInterval);
    }

    function stopUpdates() {
        if (updateTimer) {
            clearInterval(updateTimer);
            updateTimer = null;
        }
    }

    function updateState() {
        const player = window.playerInstance;
        if (!player) return;

        // Don't update UI from player if we are in the middle of a remote seek
        if (seekTargetTicks !== null) return;

        updateTimeDisplay(player);
        updateClock();
        if (!isDraggingSeekbar) {
            updatePositionSlider(player);
        }
        updatePlayPauseButton();
    }

    function updateClock() {
        const clockEl = document.getElementById('osdClock');
        if (!clockEl) return;

        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        clockEl.textContent = `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
    }

    function updateTimeDisplay(player) {
        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        const currentEl = document.getElementById('osdCurrentTime');
        const totalEl = document.getElementById('osdTotalTime');

        if (currentEl && !isDraggingSeekbar) {
            currentEl.textContent = formatTime(current);
        }
        if (totalEl) {
            totalEl.textContent = formatTime(duration);
        }

        // Ends At
        const endsAtEl = document.getElementById('osdEndsAt');
        if (endsAtEl && duration > 0) {
            const remainingMs = (duration - current) / 10000;
            const endTime = new Date(Date.now() + remainingMs);
            const hours = endTime.getHours();
            const minutes = endTime.getMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12;
            endsAtEl.textContent = `Ends at ${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
        }
    }

    function updatePositionSlider(player) {
        const slider = document.getElementById('osdPositionSlider');
        if (!slider) return;

        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        const percent = duration > 0 ? (current / duration) * 100 : 0;
        slider.value = percent;

        // Update progress track gradient
        slider.style.setProperty('--progress', percent + '%');
    }

    function updatePlayPauseButton() {
        const player = window.playerInstance;
        const btn = document.getElementById('osdPlayPauseBtn');
        if (!btn || !player) return;

        const isPaused = player.isPaused ? player.isPaused() : false;
        btn.innerHTML = isPaused ? ICONS.play : ICONS.pause;
    }

    // ========================================================================
    // Show/Hide
    // ========================================================================

    function show() {
        if (isOsdVisible) return;
        osdElement.classList.remove('osd-hidden');
        isOsdVisible = true;
    }

    function hide() {
        // Allow hiding even if paused
        /*
        if (player && player.isPaused && player.isPaused()) {
            resetAutoHide();
            return;
        }
        */
        osdElement.classList.add('osd-hidden');
        isOsdVisible = false;
    }

    function resetAutoHide() {
        if (autoHideTimer) clearTimeout(autoHideTimer);
        autoHideTimer = setTimeout(() => hide(), CONFIG.autoHideDelay);
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    function formatTime(ticks) {
        if (!ticks || ticks < 0) return '00:00';

        const totalSeconds = Math.floor(ticks / 10000000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const pad = (n) => String(n).padStart(2, '0');

        if (hours > 0) {
            return `${hours}:${pad(minutes)}:${pad(seconds)}`;
        }
        return `${pad(minutes)}:${pad(seconds)}`;
    }

    // ========================================================================
    // Track Selection Menu
    // ========================================================================

    function openTrackMenu(type) {
        const player = window.playerInstance;
        if (!player) return;

        trackMenuType = type;
        trackMenuFocusIndex = 0;

        // Get tracks
        let tracks = [];
        let title = '';
        let currentIndex = -1;

        if (type === 'subtitles') {
            tracks = player.getSubtitleTracks ? player.getSubtitleTracks() : [];
            title = 'Subtitles';
            currentIndex = currentSubtitleIndex;
            // Add "Off" option at the beginning
            tracks = [{ Index: -1, DisplayTitle: 'Off' }, ...tracks];
        } else if (type === 'audio') {
            tracks = player.getAudioTracks ? player.getAudioTracks() : [];
            title = 'Audio';
            currentIndex = currentAudioIndex;
        }

        if (tracks.length === 0) {
            console.log('[OSD] No tracks available for', type);
            return;
        }

        // Find current selection index in menu
        trackMenuFocusIndex = tracks.findIndex(t => t.Index === currentIndex);
        if (trackMenuFocusIndex < 0) trackMenuFocusIndex = 0;

        renderTrackMenu(title, tracks, currentIndex);
        isTrackMenuOpen = true;
        trackMenuOverlay.classList.add('visible');
        updateTrackMenuFocus();
    }

    function closeTrackMenu() {
        if (trackMenuOverlay) {
            trackMenuOverlay.classList.remove('visible');
        }
        isTrackMenuOpen = false;
        trackMenuType = null;
    }

    function renderTrackMenu(title, tracks, currentIndex) {
        if (!trackMenuOverlay) {
            trackMenuOverlay = document.createElement('div');
            trackMenuOverlay.className = 'track-menu-overlay';
            document.body.appendChild(trackMenuOverlay);
        }

        const optionsHtml = tracks.map((track, i) => {
            const isSelected = track.Index === currentIndex;
            const label = track.DisplayTitle || track.Title || `Track ${track.Index}`;
            return `
                <button class="track-option ${isSelected ? 'selected' : ''}" data-index="${track.Index}" data-menu-index="${i}">
                    <span class="track-option-check">${ICONS.check}</span>
                    <span class="track-option-label">${label}</span>
                </button>
            `;
        }).join('');

        trackMenuOverlay.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title">${title}</div>
                <div class="track-menu-options">
                    ${optionsHtml}
                </div>
            </div>
        `;

        // Add click handlers
        trackMenuOverlay.querySelectorAll('.track-option').forEach(btn => {
            btn.addEventListener('click', () => {
                const menuIndex = parseInt(btn.dataset.menuIndex);
                selectTrackByMenuIndex(menuIndex);
            });
        });

        trackMenuOverlay.addEventListener('click', (e) => {
            if (e.target === trackMenuOverlay) {
                closeTrackMenu();
            }
        });
    }

    function updateTrackMenuFocus() {
        if (!trackMenuOverlay) return;
        const options = trackMenuOverlay.querySelectorAll('.track-option');
        options.forEach((opt, i) => {
            const isFocused = i === trackMenuFocusIndex;
            opt.classList.toggle('focused', isFocused);
            if (isFocused) {
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }

    function selectTrackByMenuIndex(menuIndex) {
        const player = window.playerInstance;
        if (!player) return;

        if (trackMenuType === 'subtitles') {
            // Menu index 0 = Off (-1)
            if (menuIndex === 0) {
                currentSubtitleIndex = -1;
                if (player.setSubtitleStreamIndex) {
                    player.setSubtitleStreamIndex(-1);
                }
                console.log('[OSD] Subtitles Off');
            } else {
                // menuIndex 1 corresponds to tracks[0]
                const tracks = player.getSubtitleTracks ? player.getSubtitleTracks() : [];
                const track = tracks[menuIndex - 1];
                if (track) {
                    currentSubtitleIndex = track.Index;
                    if (player.setSubtitleStreamIndex) {
                        player.setSubtitleStreamIndex(track.Index);
                    }
                    console.log('[OSD] Subtitle track set to index:', track.Index);
                }
            }
        } else if (trackMenuType === 'audio') {
            // Audio has no "Off", menu index maps directly to tracks array
            const tracks = player.getAudioTracks ? player.getAudioTracks() : [];
            const track = tracks[menuIndex];
            if (track) {
                currentAudioIndex = track.Index;
                if (player.setAudioStreamIndex) {
                    player.setAudioStreamIndex(track.Index);
                }
                console.log('[OSD] Audio track set to index:', track.Index);
            }
        }

        closeTrackMenu();
    }

    function handleTrackMenuKeyDown(e) {
        if (!isTrackMenuOpen) return false;

        const options = trackMenuOverlay?.querySelectorAll('.track-option') || [];
        const optionCount = options.length;

        switch (e.keyCode) {
            case 38: // Up
                if (trackMenuFocusIndex > 0) {
                    trackMenuFocusIndex--;
                    updateTrackMenuFocus();
                }
                e.preventDefault();
                return true;

            case 40: // Down
                if (trackMenuFocusIndex < optionCount - 1) {
                    trackMenuFocusIndex++;
                    updateTrackMenuFocus();
                }
                e.preventDefault();
                return true;

            case 13: // Enter
                selectTrackByMenuIndex(trackMenuFocusIndex);
                e.preventDefault();
                return true;

            case 10009: // Tizen Back
            case 27:    // Escape
            case 8:     // Backspace
                closeTrackMenu();
                e.preventDefault();
                return true;
        }

        return false;
    }

    function destroy() {
        stopUpdates();
        if (autoHideTimer) clearTimeout(autoHideTimer);
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('mousemove', handleActivity);
        document.removeEventListener('touchstart', handleActivity);
        if (trackMenuOverlay) {
            trackMenuOverlay.remove();
            trackMenuOverlay = null;
        }
    }

    // ========================================================================
    // Expose API
    // ========================================================================

    window.PlayerOSD = { init, show, hide, destroy };

})();
