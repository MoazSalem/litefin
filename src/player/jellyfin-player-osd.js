/**
 * Player OSD - On-Screen Display Controller
 * 
 * Manages the video player overlay UI for Litefin.
 * Layout matches Jellyfin Tizen TV OSD.
 */

(function () {
    'use strict';

    // ========================================================================
    // Configuration
    // ========================================================================

    const CONFIG = {
        autoHideDelay: 5000,
        updateInterval: 500,
        seekStep: 10000
    };

    // ========================================================================
    // State
    // ========================================================================

    let osdElement = null;
    let autoHideTimer = null;
    let updateTimer = null;
    let isOsdVisible = true;
    let isDraggingSeekbar = false;

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
        sync: '<span class="material-icons">sync</span>'
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
        show();

        // Set initial focus on play button and start auto-hide timer
        setTimeout(() => updateFocus(), 100);
        resetAutoHide();

        console.log('[OSD] Initialized');
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
                    <button class="osd-btn osd-back-btn" data-action="back" tabindex="0" title="Back">
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
        show();
        resetAutoHide();

        const player = window.playerInstance;
        const { headerRow, controlsRow, seekbar } = getFocusableElements();

        switch (e.keyCode) {
            // ============================================================
            // D-Pad Navigation
            // ============================================================
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

            case 37: // Left arrow
                if (currentFocusRow === 1) {
                    // Move left in controls row
                    if (currentFocusIndex > 0) {
                        currentFocusIndex--;
                        updateFocus();
                    }
                } else if (currentFocusRow === 2) {
                    // On seekbar - seek backward
                    executeAction('rewind');
                }
                // Row 0 (header) - no left/right, only one button
                e.preventDefault();
                break;

            case 39: // Right arrow
                if (currentFocusRow === 1) {
                    // Move right in controls row
                    if (currentFocusIndex < controlsRow.length - 1) {
                        currentFocusIndex++;
                        updateFocus();
                    }
                } else if (currentFocusRow === 2) {
                    // On seekbar - seek forward
                    executeAction('fastForward');
                }
                // Row 0 (header) - no left/right, only one button
                e.preventDefault();
                break;

            // ============================================================
            // Enter / OK - Activate focused element
            // ============================================================
            case 13: // Enter
                if (currentFocusRow === 0 && headerRow[0]) {
                    // Back button
                    executeAction('back');
                } else if (currentFocusRow === 1 && controlsRow[currentFocusIndex]) {
                    const action = controlsRow[currentFocusIndex].dataset.action;
                    if (action) executeAction(action);
                } else if (currentFocusRow === 2) {
                    // On seekbar - toggle play
                    executeAction('togglePlay');
                }
                e.preventDefault();
                break;

            // ============================================================
            // Media Keys
            // ============================================================
            case 415:   // Tizen Play
            case 10252: // Tizen Play/Pause toggle
                executeAction('togglePlay');
                e.preventDefault();
                break;

            case 19: // Pause
            case 10253: // Tizen Pause
                if (player && player.pause) player.pause();
                e.preventDefault();
                break;

            case 412: // Tizen Rewind
                executeAction('rewind');
                e.preventDefault();
                break;

            case 417: // Tizen FastForward
                executeAction('fastForward');
                e.preventDefault();
                break;

            // ============================================================
            // Back / Exit
            // ============================================================
            case 10009: // Tizen Back
            case 27:    // Escape
            case 8:     // Backspace
                executeAction('back');
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
                if (player.stop) player.stop();
                history.back();
                break;

            case 'togglePlay':
                if (player.togglePlay) player.togglePlay();
                setTimeout(updatePlayPauseButton, 100);
                break;

            case 'rewind':
                const skipBack = parseInt(localStorage.getItem('jellyfin-player-skipBackLength')) || CONFIG.seekStep;
                if (player.seekRelative) player.seekRelative(-skipBack);
                break;

            case 'fastForward':
                const skipFwd = parseInt(localStorage.getItem('jellyfin-player-skipForwardLength')) || CONFIG.seekStep;
                if (player.seekRelative) player.seekRelative(skipFwd);
                break;

            case 'previousTrack':
            case 'nextTrack':
                // TODO: Playlist navigation
                break;

            case 'subtitles':
                console.log('[OSD] Subtitles menu');
                break;

            case 'audio':
                console.log('[OSD] Audio menu');
                break;

            case 'favorite':
                console.log('[OSD] Toggle favorite');
                break;

            case 'settings':
                console.log('[OSD] Settings menu');
                break;
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
        const player = window.playerInstance;
        if (player && player.isPaused && player.isPaused()) {
            resetAutoHide();
            return;
        }
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

    function destroy() {
        stopUpdates();
        if (autoHideTimer) clearTimeout(autoHideTimer);
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('mousemove', handleActivity);
        document.removeEventListener('touchstart', handleActivity);
    }

    // ========================================================================
    // Expose API
    // ========================================================================

    window.PlayerOSD = { init, show, hide, destroy };

})();
