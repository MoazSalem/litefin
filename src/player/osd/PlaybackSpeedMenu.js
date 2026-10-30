// Base class representing standard player menu structures and layouts.
import BaseMenu from './BaseMenu.js';

// Centralized icon store loaded globally to reuse SVG layouts for playback menu checks.
import { osdIcons } from '../../utils/Icons.js';

// Class level logger to log changes to the media player speed settings.
import { logger } from '../../utils/Logger.js';

// Localization function library for translation of player UI elements.
import { i18n } from '../../utils/i18n.js';

const log = logger.create('PlaybackSpeedMenu');

export default class PlaybackSpeedMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
        this.title = i18n.t('PlaybackRate');

        /*
         * ====================================================================
         * Comprehensive Playback Rate Spectrum
         * ====================================================================
         * Covers all player backend capabilities across platforms:
         * - 0.25x (ultra-slow)
         * - 0.5x, 0.75x
         * - 1.0x (standard / normal rate)
         * - 1.25x, 1.5x, 1.75x, 2.0x (smooth audio acceleration)
         * - 2.5x, 3.0x, 3.5x, 4.0x (high-speed scrubbing)
         * - 8.0x (hardware trickplay fast-forward)
         * ====================================================================
         */
        this.availableSpeeds = [
            0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 8
        ];

        // Initialize options annotated with initial support flags
        this._refreshOptions();
    }

    /**
     * Rebuild the speed options array and query the active player backend
     * to determine if each speed is natively supported.
     *
     * @private
     */
    _refreshOptions() {
        // Retrieve player instance from OSDController
        const player = this.osd?.player;

        // webOS speeds were tried on a TV: above 2x the picture skips frames and the sound is gone,
        // so those are left out of the list instead of being offered with a warning
        const hideUnsupported = player?.getBackendType?.() === 'webos';

        // Map every speed into an option object with localized label and support status
        this.options = this.availableSpeeds.map(speed => {
            // Check native hardware support via JellyfinPlayer or local fallback
            const isSupported = player?.isPlaybackSpeedSupported
                ? player.isPlaybackSpeedSupported(speed)
                : this._isSpeedSupportedFallback(speed);

            return {
                id: speed,
                label: i18n.t('SpeedValue', [ speed.toString() ]),
                isSupported
            };
        }).filter(opt => opt.isSupported || !hideUnsupported);
    }

    /**
     * Fallback validation for active player backend support.
     * Used when the player instance is deferred or during cold boot.
     *
     * @private
     * @param {number} speed - The playback speed multiplier
     * @returns {boolean} Whether the speed is natively supported by the backend
     */
    _isSpeedSupportedFallback(speed) {
        // Resolve backend type identifier ('movi' | 'html5' | 'tizen' | 'webos' | 'exoplayer')
        const backend = this.osd?.player?.getBackendType?.() ||
                        this.osd?.player?._backendType || 'html5';

        switch (backend) {
            case 'webos':
                return speed >= 0.25 && speed <= 2;

            case 'tizen':
                // Samsung AVPlay trickplay engine expects integer multipliers [1, 2, 4, 8]
                return Number.isInteger(speed) && [1, 2, 4, 8].includes(speed);

            case 'movi':
                // movi-player WebCodecs WASM engine clamps playbackRate to a maximum of 2.0x
                return speed >= 0.25 && speed <= 2;

            case 'exoplayer':
                // Android ExoPlayer with Sonic audio processor supports standard positive floats
                return speed >= 0.25 && speed <= 8;

            case 'html5':
            default:
                // Standard browser HTML5 video element (Chrome, Edge, Firefox, Safari)
                return speed >= 0.25 && speed <= 4;
        }
    }

    open() {
        // Re-evaluate options against currently active player backend
        this._refreshOptions();

        // Pre-select current speed
        const currentSpeed = this.osd.player.getPlaybackSpeed();
        const index = this.options.findIndex(opt => opt.id === currentSpeed);
        
        // Find default 1x index or fallback to index 3 (1.0x in standard list)
        const defaultIndex = this.options.findIndex(opt => opt.id === 1);
        this.focusIndex = index !== -1 ? index : (defaultIndex !== -1 ? defaultIndex : 3);
        
        this.render();
        this.show();
    }

    show() {
        // Capture focus context
        this._prevFocus = this.osd._getFocused(); 
        this._prevRow = this.osd._currentFocusRow;
        this._prevIndex = this.osd._currentFocusIndex;

        this.isVisible = true;
        if (this.$el) {
            this.$el.classList.add('visible');
            this.updateFocus();
        }
    }

    hide() {
        this.isVisible = false;
        if (this.$el) {
            this.$el.classList.remove('visible');
        }

        // Restore focus to Settings Menu if it's open
        if (this._prevRow !== undefined) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();

            /*
             * Lock out enter/click inputs for 350ms to absorb any ghost key presses
             * or trailing clicks on the newly focused parent button on the OSD.
             */
            this.osd._focusRestoreLockout = true;
            if (this.osd._focusRestoreLockoutTimer) {
                clearTimeout(this.osd._focusRestoreLockoutTimer);
            }
            this.osd._focusRestoreLockoutTimer = setTimeout(() => {
                this.osd._focusRestoreLockout = false;
                this.osd._focusRestoreLockoutTimer = null;
            }, 350);
        }
    }

    render() {
        if (!this.$el) {
            this.$el = document.createElement('div');
            this.$el.className = 'track-menu-overlay'; // Reuse track menu styles
            document.body.appendChild(this.$el);

            this.$el.addEventListener('click', (e) => {
                if (e.target === this.$el) {
                    this.osd.closeMenu();
                }
            });
        }

        const currentSpeed = this.osd.player.getPlaybackSpeed();

        // Loop through all speeds to construct the options template.
        const optionsHtml = this.options.map((opt, i) => {
            // Determine if the speed index is equal to current playback rate.
            const isSelected = opt.id === currentSpeed;
            const isSupported = opt.isSupported;
            
            // ================================================================
            // Dynamic Selection Mark
            // ================================================================
            // Checkmark SVG applied to option that is actively used.
            // We use the unified check icon directly.
            const checkIcon = isSelected ? osdIcons.check : '';

            /*
             * Hardware capability indicator pill badge:
             * Clearly flags playback rates outside native backend support
             * while preserving full focus, clickability, and user override.
             */
            const unsupportedBadge = !isSupported
                ? `<span class="track-badge track-badge-unsupported" data-i18n="Unsupported">${i18n.t('Unsupported') || 'Unsupported'}</span>`
                : '';
            
            // Build and return the HTML button structure for the specific speed.
            return `
            <button class="track-option track-item ${isSelected ? 'selected' : ''} ${!isSupported ? 'speed-unsupported' : ''}" 
                    data-id="${opt.id}" data-menu-index="${i}">
                <span class="track-option-icon">${opt.icon || ''}</span>
                <span class="track-option-label">
                    <span class="track-label-text">${opt.label}</span>
                    ${unsupportedBadge}
                </span>
                <span class="track-option-check">${checkIcon}</span>
            </button>
            `;
        }).join('');

        this.$el.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title" data-i18n="PlaybackRate">${i18n.t('PlaybackRate')}</div>
                <div class="track-menu-options">
                    ${optionsHtml}
                </div>
            </div>
        `;

        this.$el.querySelectorAll('.track-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                /*
                 * ================================================================
                 * TIZEN TV CLICK ORIGIN GUARD
                 * ================================================================
                 * Discard synthetic focus-clicks and Enter-synthesized clicks (detail === 0
                 * or clientX === 0 && clientY === 0). D-pad Enter is handled exclusively
                 * via handleKey() -> handleEnter().
                 * ================================================================
                 */
                if (btn._programmaticFocus) return;
                if (e.detail === 0) return;
                if (e.clientX === 0 && e.clientY === 0) return;

                this.focusIndex = parseInt(btn.dataset.menuIndex);
                this.handleEnter();
            });
        });

        this.updateFocus();
    }

    handleKey(key) {
        switch (key) {
            case 'up':
                if (this.focusIndex > 0) {
                    this.focusIndex--;
                } else {
                    this.focusIndex = this.options.length - 1;
                }
                this.updateFocus();
                return true;
            case 'down':
                if (this.focusIndex < this.options.length - 1) {
                    this.focusIndex++;
                } else {
                    this.focusIndex = 0;
                }
                this.updateFocus();
                return true;
            case 'enter':
                this.handleEnter();
                return true;
            case 'back':
            case 'left':
            case 'right':
                this.hide();
                // Return to Settings Menu (Options)
                this.osd.toggleSettings(true);
                return true;
        }
        return false;
    }

    handleEnter() {
        const selected = this.options[this.focusIndex];
        if (selected) {
            log.info(`Selected playback speed: ${selected.id}x (backend support: ${selected.isSupported ? 'native' : 'unsupported/override'})`);
            this.osd.player.setPlaybackSpeed(selected.id);
            this.osd.closeMenu();
        }
    }

    updateFocus() {
        if (!this.$el) return;
        const options = this.$el.querySelectorAll('.track-option');
        options.forEach((opt, i) => {
            const isFocused = i === this.focusIndex;
            opt.classList.toggle('focused', isFocused);
            if (isFocused) {
                opt._programmaticFocus = true;
                opt.focus({ preventScroll: true });
                setTimeout(() => { opt._programmaticFocus = false; }, 0);
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }
}
