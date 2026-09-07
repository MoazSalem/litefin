// Base class providing overlay modal logic and key handlers for generic player menus.
import BaseMenu from './BaseMenu.js';

// Centralized icon resource definitions to display outlines and filled vectors.
import { osdIcons } from '../../utils/Icons.js';

// Logger interface to stream diagnostic information concerning settings state.
import { logger } from '../../utils/Logger.js';

// Global local configurations and persistent user storage mapping.
import { PlayerSettings } from '../../utils/PlayerSettings.js';

// Direct internationalization API to dynamically translate strings.
import { i18n } from '../../utils/i18n.js';

const log = logger.create('QualityMenu');

export default class QualityMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
        this.title = i18n.t('Quality');
        
        // Standard Jellyfin bitrates
        this.bitrates = [
            { val: 120000000, label: '120 Mbps' },
            { val: 100000000, label: '100 Mbps' },
            { val: 80000000, label: '80 Mbps' },
            { val: 60000000, label: '60 Mbps' },
            { val: 40000000, label: '40 Mbps' },
            { val: 20000000, label: '20 Mbps' },
            { val: 15000000, label: '15 Mbps' },
            { val: 10000000, label: '10 Mbps' },
            { val: 8000000, label: '8 Mbps' },
            { val: 6000000, label: '6 Mbps' },
            { val: 4000000, label: '4 Mbps' },
            { val: 3000000, label: '3 Mbps' },
            { val: 2000000, label: '2 Mbps' },
            { val: 1500000, label: '1.5 Mbps' }, // SD starts roughly here
            { val: 1000000, label: '1 Mbps' },
            { val: 720000, label: '720 Kbps' },
            { val: 420000, label: '420 Kbps' }
        ];
    }

    open() {
        const player = this.osd.player;
        const currentSource = player.getCurrentMediaSource();
        const currentMaxBitrate = player.getMaxBitrate(); // We need to implement this in Player
        const sourceBitrate = currentSource ? currentSource.Bitrate : Infinity;

        // Filter options:
        // 1. Auto (always first)
        // 2. Bitrates <= sourceBitrate + small margin (to avoid hiding the source quality if it's borderline)
        const margin = 100000; // 100kbps margin
        const limit = (sourceBitrate || Infinity) + margin;

        // ====================================================================
        // Default Option Mapping
        // ====================================================================
        // Establish primary auto mode fallback setting index 0 at top of selection.
        // We reference the unified osdIcons.check icon directly.
        const options = [{ id: 0, label: i18n.t('Auto'), icon: osdIcons.check }];
        
        this.bitrates.forEach(b => {
            if (b.val <= limit) {
                options.push({
                    id: b.val,
                    label: b.label,
                    icon: ''
                });
            }
        });

        this.validOptions = options;

        // Find initial focus
        // User requested: start focus at selected value
        const currentVal = currentMaxBitrate || 0;
        let index = 0;
        
        // If we are in "Auto" mode (0), try to find the global limit's index
        if (currentVal === 0) {
            const globalLimit = PlayerSettings.get('maxBitrateInternet');
            if (globalLimit) {
                index = this.validOptions.findIndex(opt => opt.id === globalLimit);
            }
        } else {
             index = this.validOptions.findIndex(opt => opt.id === currentVal);
        }
        
        if (index === -1) {
             index = 0; 
        }

        this.focusIndex = index;
        
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

        // Get current setting to show checkmark
        const player = this.osd.player;
        let currentMaxBitrate = player.getMaxBitrate() || 0;

        // Visual logic:
        // If currentMaxBitrate matches a valid option, select it.
        // If not (e.g. 120Mbps default when only 20Mbps available, OR explicit 0), fallback to Auto (0).
        if (!this.validOptions.find(opt => opt.id === currentMaxBitrate)) {
            currentMaxBitrate = 0;
        }

        // Construct layout elements representing active bandwidth settings.
        const optionsHtml = this.validOptions.map((opt, i) => {
            // Assess selection matches comparing option item to current bitrate.
            const isSelected = opt.id === currentMaxBitrate;
            
            // ================================================================
            // Dynamic Selection Mark
            // ================================================================
            // Assign unified check icon element to identify selected list values.
            const checkIcon = isSelected ? osdIcons.check : '';
            
            // User requested: Auto = Direct Play, Lower = Transcoding
            const secondaryLabel = opt.id === 0 ? i18n.t('DirectPlay') : i18n.t('Transcoding');
            const secondaryKey = opt.id === 0 ? 'DirectPlay' : 'Transcoding';
            
            // Format dynamic label
            let label = opt.label;
            let labelKey = '';
            if (opt.id > 0) {
                if (opt.id >= 1000000) {
                    label = i18n.t('BitrateMbps', [ (opt.id / 1000000).toString() ]);
                } else {
                    label = i18n.t('BitrateKbps', [ (opt.id / 1000).toString() ]);
                }
            } else {
                labelKey = 'Auto';
            }

            return `
            <button class="track-option track-item ${isSelected ? 'selected' : ''}" 
                    data-id="${opt.id}" data-menu-index="${i}">
                <div class="track-option-content">
                    <span class="track-option-label" ${labelKey ? `data-i18n="${labelKey}"` : ''}>${label}</span>
                    <span class="track-option-secondary" data-i18n="${secondaryKey}">${secondaryLabel}</span>
                </div>
                <span class="track-option-check">${checkIcon}</span>
            </button>
            `;
        }).join('');

        this.$el.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title" data-i18n="Quality">${this.title}</div>
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
                    this.focusIndex = this.validOptions.length - 1;
                }
                this.updateFocus();
                return true;
            case 'down':
                if (this.focusIndex < this.validOptions.length - 1) {
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
        const selected = this.validOptions[this.focusIndex];
        if (selected) {
            log.info('Selected bitrate:', selected.id);
            this.osd.player.setMaxBitrate(selected.id);
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
