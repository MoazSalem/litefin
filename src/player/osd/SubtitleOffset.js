// Base class representing generic menu parameters and control flows.
import BaseMenu from './BaseMenu.js';

// Centralized icon store loaded globally to reuse SVG layout definitions.
import { osdIcons } from '../../utils/Icons.js';

// localization support utility to translate strings dynamically in-app.
import { i18n } from '../../utils/i18n.js';

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
            if (typeof this._cleanupOffsetDrag === 'function') {
                this._cleanupOffsetDrag();
            }
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
                        <span class="osd-offset-title">${i18n.t('SubtitleOffset')}</span>
                        <span class="osd-offset-value" id="osdOffsetValue">0.0s</span>
                    </div>
                    <!-- Close button mapping using centralized vector path -->
                    <button class="osd-offset-close focusable" data-action="closeSubtitleOffset" tabindex="0">
                        ${osdIcons.close}
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

            // Prevent clicks inside the popup from bubbling to background video play/pause toggle
            this.$el.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            // Bind slider container and range input for smooth mouse/touch/pointer scrubbing
            const sliderContainer = this.$el.querySelector('.osd-slider-container');
            const slider = this.$el.querySelector('#osdOffsetSlider');

            /*
             * Applies the calculated offset value, updates internal state,
             * re-renders fill bar and text values, and notifies the player.
             */
            const applyOffsetValue = (val) => {
                // Clamp between -30s and +30s and round to 1 decimal place
                let clamped = Math.max(-30, Math.min(30, val));
                clamped = Math.round(clamped * 10) / 10;
                this.offset = clamped;

                if (slider) {
                    slider.value = clamped;
                }

                // Update visual track and label indicators
                this.updateUI();

                // Direct sync to active player subtitle pipeline
                if (this.player?.setSubtitleOffset) {
                    this.player.setSubtitleOffset(this.offset);
                }
            };

            // Standard input and change event listeners on native range element
            if (slider) {
                slider.addEventListener('input', (e) => {
                    applyOffsetValue(parseFloat(e.target.value));
                });
                slider.addEventListener('change', (e) => {
                    applyOffsetValue(parseFloat(e.target.value));
                });
            }

            /*
             * Dragging & Scrubbing support for mouse and magic cursor:
             * Allows clicking or dragging anywhere within the 30px container height,
             * avoiding the precision requirement of hitting the 8px native track.
             */
            if (sliderContainer && slider) {
                const updateFromPointer = (e) => {
                    const rect = sliderContainer.getBoundingClientRect();
                    if (!rect.width) return;

                    // Account for document text direction in RTL mode
                    const isRTL = document.documentElement.dir === 'rtl';
                    let fraction = (e.clientX - rect.left) / rect.width;
                    if (isRTL) fraction = 1 - fraction;
                    fraction = Math.max(0, Math.min(1, fraction));

                    const min = parseFloat(slider.min || -30);
                    const max = parseFloat(slider.max || 30);
                    const val = min + fraction * (max - min);
                    applyOffsetValue(val);
                };

                let isDragging = false;

                const onPointerMove = (e) => {
                    if (!isDragging) return;
                    updateFromPointer(e);
                };

                const onPointerUp = () => {
                    if (isDragging) {
                        isDragging = false;
                        window.removeEventListener('pointermove', onPointerMove);
                        window.removeEventListener('pointerup', onPointerUp);
                        window.removeEventListener('mousemove', onPointerMove);
                        window.removeEventListener('mouseup', onPointerUp);
                    }
                };

                // Store cleanup reference for when the widget is hidden or unmounted
                this._cleanupOffsetDrag = onPointerUp;

                const onPointerDown = (e) => {
                    // Only respond to primary mouse button
                    if (e.button !== undefined && e.button !== 0) return;
                    // Guard against TV remote synthetic enter clicks
                    if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return;

                    e.stopPropagation();
                    isDragging = true;
                    updateFromPointer(e);

                    // Track global movement across the screen during drag
                    window.addEventListener('pointermove', onPointerMove);
                    window.addEventListener('pointerup', onPointerUp);
                    window.addEventListener('mousemove', onPointerMove);
                    window.addEventListener('mouseup', onPointerUp);
                };

                sliderContainer.addEventListener('pointerdown', onPointerDown);
                sliderContainer.addEventListener('mousedown', onPointerDown);
            }

            // Bind close button
            const closeBtn = this.$el.querySelector('.osd-offset-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.osd.toggleSubtitleOffset(false);
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
            valueEl.textContent = i18n.t('SecondsShort', [ `${sign}${this.offset.toFixed(1)}` ]);
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
                const isRTL = document.documentElement.dir === 'rtl';
                if (isRTL) {
                    fill.style.left = 'auto';
                    fill.style.right = start + '%';
                } else {
                    fill.style.right = 'auto';
                    fill.style.left = start + '%';
                }
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
            case 'right': {
                if (isSlider) {
                    // Rely on native input behavior to avoid double steps
                    return true;
                }

                const isRTL = document.documentElement.dir === 'rtl';
                const isEscapeKey = (isRTL && key === 'right') || (!isRTL && key === 'left');

                if (isEscapeKey && isClose) {
                    // Go to Player Close button (Header Row 0, Index 0)
                    this.osd._currentFocusRow = 0;
                    this.osd._currentFocusIndex = 0;
                    this.osd.activeMenu = null; // Return control to main OSD
                    this.osd.show(); // Ensure OSD is visible
                    this.osd._updateFocus();
                    return true;
                }
                
                // If not escaping but pressing the inward key from Close button (Right in LTR, Left in RTL)
                const isInwardKey = (isRTL && key === 'left') || (!isRTL && key === 'right');
                if (isInwardKey && isClose) {
                    // Try to move to PI Close if open
                    const idx = this.osd._cachedOverlayRow.findIndex(el => el.classList.contains('playback-info-close'));
                    if (idx !== -1) {
                        this.osd._currentFocusIndex = idx;
                        this.osd.activeMenu = this.osd.playbackInfo; // Switch control to PlaybackInfo
                        this.osd._updateFocus();
                        return true;
                    }
                    return true; // Block inward key if PI not open
                }

                return false;
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