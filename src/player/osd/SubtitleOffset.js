import BaseMenu from './BaseMenu.js';
import { ICONS } from './icons.js';

/**
 * SubtitleOffset
 * 
 * Provides an interface to adjust the subtitle synchronization offset.
 * Features:
 * - A center-weighted seekbar for positive/negative delay adjustments.
 * - Real-time updates to the active player's subtitle offset.
 * - Persistent visual feedback of the current offset value.
 */
export default class SubtitleOffset extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.offset = 0;
        this.isModal = false; // Persistent widget
    }

    toggle(show) {
        if (show) {
            // Render if missing
            if (!this.$el) {
                this.render();
            }

            this.isVisible = true;
            this.$el.classList.add('visible');
            
            // Sync UI to current offset
            this.updateUI();
            this.ignoreInputUntil = Date.now() + 300;
        } else {
            this.isVisible = false;
            if (this.$el) {
                this.$el.classList.remove('visible');
            }
        }
    }

    render() {
        const html = `
            <div id="osdOffsetOverlay" class="osd-offset-popup">
                <div class="osd-offset-header">
                    <div class="osd-offset-title-group">
                        <span class="osd-offset-title">SUBTITLE OFFSET</span>
                        <span class="osd-offset-value" id="osdOffsetValue">0.0s</span>
                    </div>
                    <button class="osd-offset-close focusable" data-action="closeSubtitleOffset" tabindex="0">
                        ${ICONS.close}
                    </button>
                </div>
                <div class="osd-offset-content">
                    <div class="osd-slider-container menu-slider">
                        <div class="osd-slider-track">
                            <div class="osd-slider-fill" id="osdOffsetFill"></div>
                        </div>
                        <input type="range" class="osd-offset-slider focusable" id="osdOffsetSlider" 
                               min="-30" max="30" step="0.1" value="0" tabindex="0">
                    </div>
                </div>
            </div>
        `;
        
        const overlays = this.osd._osdEl.querySelector('.osd-overlays');
        if (overlays) {
            const temp = document.createElement('div');
            temp.innerHTML = html;
            this.$el = temp.firstElementChild;
            overlays.appendChild(this.$el);

            // Bind slider input for mouse/touch
            const slider = this.$el.querySelector('#osdOffsetSlider');
            if (slider) {
                slider.addEventListener('input', (e) => {
                    this.offset = parseFloat(e.target.value);
                    this.updateUI();
                    if (this.player?.setSubtitleOffset) {
                        this.player.setSubtitleOffset(this.offset);
                    }
                });
            }
        }
    }

    adjust(deltaSeconds) {
        // Round to 1 decimal place
        let newOffset = Math.round((this.offset + deltaSeconds) * 10) / 10;
        
        // Clamp -30 to +30
        if (newOffset < -30) newOffset = -30;
        if (newOffset > 30) newOffset = 30;

        this.offset = newOffset;
        this.updateUI();

        if (this.player && this.player.setSubtitleOffset) {
            this.player.setSubtitleOffset(this.offset);
        }
    }

    updateUI() {
        if (!this.$el) return;
        const valueEl = this.$el.querySelector('#osdOffsetValue');
        const slider = this.$el.querySelector('#osdOffsetSlider');
        
        if (valueEl) {
            const sign = this.offset > 0 ? '+' : '';
            valueEl.textContent = `${sign}${this.offset.toFixed(1)}s`;
        }
        
        if (slider) {
            slider.value = this.offset;
            const min = parseFloat(slider.min || -30);
            const max = parseFloat(slider.max || 30);
            const percent = ((this.offset - min) / (max - min)) * 100;
            
            // For center-weighted fill, we need two points
            const start = Math.min(50, percent);
            const end = Math.max(50, percent);
            
            const fill = this.$el.querySelector('#osdOffsetFill');
            if (fill) {
                fill.style.left = start + '%';
                fill.style.width = (end - start) + '%';
            }
        }
    }

    handleKey(key) {
        if (!this.isVisible) return false;
        if (this.ignoreInputUntil && Date.now() < this.ignoreInputUntil) return true;

        const currentEl = this.osd._cachedOverlayRow[this.osd._currentFocusIndex];
        const isSlider = currentEl?.id === 'osdOffsetSlider';
        const isClose = currentEl?.classList.contains('osd-offset-close');

        switch (key) {
            case 'left':
                if (isSlider) {
                    // Rely on native input behavior to avoid double steps (0.2 instead of 0.1)
                    return true;
                }
                if (isClose) {
                    // Go to Player Close button (Header Row 0, Index 0)
                    this.osd._currentFocusRow = 0;
                    this.osd._currentFocusIndex = 0;
                    this.osd.activeMenu = null; // Return control to main OSD
                    this.osd.show(); // Ensure OSD is visible
                    this.osd._updateFocus();
                    return true;
                }
                return false;
            case 'right': {
                if (isSlider) {
                    // Rely on native input behavior
                    return true;
                }
                
                // If on Close button, try to move to PI Close if open
                const idx = this.osd._cachedOverlayRow.findIndex(el => el.classList.contains('playback-info-close'));
                if (idx !== -1) {
                    this.osd._currentFocusIndex = idx;
                    this.osd.activeMenu = this.osd.playbackInfo; // Switch control to PlaybackInfo
                    this.osd._updateFocus();
                    return true;
                }
                return true; // Block Right from Close if PI not open
            }
            case 'up': {
                if (isSlider) {
                    // Move focus to close button
                    const idx = this.osd._cachedOverlayRow.findIndex(el => el.classList.contains('osd-offset-close'));
                    if (idx !== -1) {
                        this.osd._currentFocusIndex = idx;
                        this.osd._updateFocus();
                        return true;
                    }
                }
                return true; // Block Up from Close/Slider
            }
            case 'down': {
                if (isClose) {
                    // Move focus to slider
                    const idx = this.osd._cachedOverlayRow.findIndex(el => el.classList.contains('osd-offset-slider'));
                    if (idx !== -1) {
                        this.osd._currentFocusIndex = idx;
                        this.osd._updateFocus();
                        return true;
                    }
                }
                // If on slider, go to Play/Pause
                this.osd._currentFocusRow = 1;
                const playIdx = this.osd._findActionIndex('togglePlay');
                this.osd._currentFocusIndex = playIdx !== -1 ? playIdx : 2;
                this.osd.show(); // Ensure OSD is visible
                this.osd._updateFocus();
                return true;
            }
        }
        return false;
    }
}