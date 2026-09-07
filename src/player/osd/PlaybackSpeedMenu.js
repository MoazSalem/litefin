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
        this.options = [
            0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4
        ].map(speed => ({
            id: speed,
            label: i18n.t('SpeedValue', [ speed.toString() ]),
        }));
    }

    open() {
        // Pre-select current speed
        const currentSpeed = this.osd.player.getPlaybackSpeed();
        const index = this.options.findIndex(opt => opt.id === currentSpeed);
        
        this.focusIndex = index !== -1 ? index : 2; // Default to 1x (index 2) if not found
        
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
            
            // ================================================================
            // Dynamic Selection Mark
            // ================================================================
            // Checkmark SVG applied to option that is actively used.
            // We use the unified check icon directly.
            const checkIcon = isSelected ? osdIcons.check : '';
            
            // Build and return the HTML button structure for the specific speed.
            return `
            <button class="track-option track-item ${isSelected ? 'selected' : ''}" 
                    data-id="${opt.id}" data-menu-index="${i}">
                <span class="track-option-icon">${opt.icon || ''}</span>
                <span class="track-option-label">${opt.label}</span>
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
            log.info('Selected speed:', selected.id);
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
