import Component from '../../core/Component.js';
import { logger } from '../../utils/Logger.js';
import { osdIcons } from '../../utils/Icons.js';
import { i18n } from '../../utils/i18n.js';

const log = logger.create('LyricsModal');

/**
 * LyricsModal
 * Displays scrolling lyrics for the currently playing audio item.
 */
export default class LyricsModal extends Component {
    constructor(osdController) {
        super();
        this.osdController = osdController;
        
        this._lyrics = [];
        this._isDynamic = false;
        this._currentLineIndex = -1;
        this._scrollTimeout = null;
        
        // Navigation state
        this._focusedIndex = -1;
        this._focusableLines = [];
        
        this._isVisible = false;
        this._isUserScrolling = false;
        this._userScrollTimeout = null;
    }

    _handleUserInteraction() {
        this._isUserScrolling = true;
        if (this._userScrollTimeout) clearTimeout(this._userScrollTimeout);
        
        // Snap back after 3 seconds of inactivity
        this._userScrollTimeout = setTimeout(() => {
            this._isUserScrolling = false;
            
            if (this._isVisible && this._isDynamic && this._currentLineIndex >= 0) {
                if (this._focusedIndex >= 0) {
                    this._focusLine(this._currentLineIndex);
                } else {
                    const targetEl = this._focusableLines[this._currentLineIndex];
                    if (targetEl) this._scrollToElement(targetEl, false);
                }
            }
        }, 3000);
    }

    render() {
        this.el = document.createElement('div');
        this.el.id = 'lyrics-modal';
        this.el.className = 'osd-modal lyrics-modal';
        
        this.el.innerHTML = `
            <div class="osd-offset-header" style="border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 10px;">
                <div class="osd-offset-title-group">
                    <span class="osd-offset-title">${i18n.t('Lyrics') || 'Lyrics'}</span>
                </div>
                <!-- Close Button utilizing unified close icon -->
                <button class="osd-offset-close focusable" data-action="lyrics" tabindex="0">
                    ${osdIcons.close}
                </button>
            </div>
            <div class="lyrics-container" style="height: calc(100% - 40px); overflow-y: hidden;">
                <div class="lyrics-content">
                    <div class="lyrics-loading">Loading lyrics...</div>
                </div>
            </div>
        `;
        
        this.$content = this.el.querySelector('.lyrics-content');
        this.$container = this.el.querySelector('.lyrics-container');
        
        return this.el;
    }

    /**
     * Open the lyrics modal
     * @param {Array} lyrics - Array of lyric objects { Text, Start }
     * @param {number} positionTicks - Current playback position
     */
    open(lyrics, positionTicks) {
        if (!this.el) {
            this.render();
            // Append to OSD Overlays layer
            const overlaysEl = this.osdController._osdEl.querySelector('.osd-overlays');
            if (overlaysEl) {
                overlaysEl.appendChild(this.el);
            }
        }

        this._isVisible = true;
        this.el.classList.add('visible');
        
        this._lyrics = lyrics || [];
        this._isDynamic = this._lyrics.length > 0 && typeof this._lyrics[0].Start !== 'undefined';
        
        this._renderLyrics();
        
        if (this._isDynamic && positionTicks) {
            this.updatePosition(positionTicks, true); // Instant jump on open
        } else {
            // Focus first line if static
            this._focusLine(0);
        }
    }

    /**
     * Hide the modal
     */
    hide() {
        this._isVisible = false;
        if (this.el) {
            this.el.classList.remove('visible');
        }
        this._lyrics = [];
        this._currentLineIndex = -1;
        this._focusedIndex = -1;
        this._focusableLines = [];
        if (this._scrollTimeout) {
            clearTimeout(this._scrollTimeout);
        }
        if (this._userScrollTimeout) {
            clearTimeout(this._userScrollTimeout);
        }
        this._isUserScrolling = false;
    }

    /**
     * Render the lyrics lines into the DOM
     */
    _renderLyrics() {
        if (!this._lyrics || this._lyrics.length === 0) {
            this.$content.innerHTML = `<div class="lyrics-empty">No lyrics available for this track.</div>`;
            this._focusableLines = [];
            return;
        }

        let html = '';
        this._lyrics.forEach((lyric, index) => {
            const classes = ['lyric-line'];
            if (this._isDynamic) classes.push('dynamic');
            
            // Text needs to be escaped
            const text = lyric.Text ? lyric.Text.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
            
            html += `<div class="${classes.join(' ')}" data-index="${index}" id="lyric-line-${index}" tabindex="-1">`;
            html += text || '&nbsp;'; // Keep empty lines taking up space
            html += `</div>`;
        });

        this.$content.innerHTML = html;
        this._focusableLines = Array.from(this.$content.querySelectorAll('.lyric-line'));
    }

    /**
     * Update the highlighted lyric based on current playback time
     * @param {number} positionTicks - Current time in ticks (10000 ticks = 1 ms)
     * @param {boolean} instant - True to skip smooth scrolling
     */
    updatePosition(positionTicks, instant = false) {
        if (!this._isVisible || !this._isDynamic || this._lyrics.length === 0) return;

        // Tizen ES6 compatibility fallback for findLastIndex
        let newIndex = -1;
        for (let i = this._lyrics.length - 1; i >= 0; i--) {
            if (this._lyrics[i].Start <= positionTicks) {
                newIndex = i;
                break;
            }
        }
        
        if (newIndex !== this._currentLineIndex) {
            this._currentLineIndex = newIndex;
            this._updateLineClasses();
            
            if (!this._isUserScrolling) {
                if (this._focusedIndex >= 0) {
                    this._focusLine(Math.max(0, newIndex), instant);
                } else {
                    const targetEl = this._focusableLines[Math.max(0, newIndex)];
                    if (targetEl) this._scrollToElement(targetEl, instant);
                }
            }
        }
    }

    _updateLineClasses() {
        this._focusableLines.forEach((el, index) => {
            el.classList.remove('past', 'current', 'future');
            if (index < this._currentLineIndex) {
                el.classList.add('past');
            } else if (index === this._currentLineIndex) {
                el.classList.add('current');
            } else {
                el.classList.add('future');
            }
        });
    }

    _focusLine(index, instant = false) {
        if (index < 0 || index >= this._focusableLines.length) return;
        
        // Remove old focus
        if (this._focusedIndex >= 0 && this._focusableLines[this._focusedIndex]) {
            this._focusableLines[this._focusedIndex].classList.remove('focused');
        }
        
        this._focusedIndex = index;
        const targetEl = this._focusableLines[index];
        targetEl.classList.add('focused');
        targetEl.focus({ preventScroll: true }); // Physically move DOM focus so synthetic clicks hit here
        
        // Scroll into view
        this._scrollToElement(targetEl, instant);
    }

    _scrollToElement(el, instant) {
        if (!this.$container || !el) return;

        // Calculate center position
        const containerHeight = this.$container.clientHeight;
        const targetTop = el.offsetTop;
        const targetHeight = el.offsetHeight;
        
        const scrollTop = targetTop - (containerHeight / 2) + (targetHeight / 2);

        /*
         * ---------------------------------------------------------------------
         * LEGACY SCROLL SUPPORT FALLBACK
         * ---------------------------------------------------------------------
         * Detect if scrollBehavior is supported natively by the browser.
         * Older Tizen and WebOS platforms (running Chromium < 49) do not support
         * the scrollTo options object (with top/behavior keys). Passing it will
         * fail silently or throw. We fallback to direct scrollTop assignment.
         * ---------------------------------------------------------------------
         */
        const supportsScrollOptions = 'scrollBehavior' in document.documentElement.style;

        if (supportsScrollOptions && !instant) {
            try {
                this.$container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
                return;
            } catch (e) {
                log.warn('scrollTo options failed, using fallback scrollTop:', e);
            }
        }

        // Direct assignment fallback - universally supported on all legacy browsers/platforms
        this.$container.scrollTop = scrollTop;
    }

    handleKey(key) {
        if (!this._isVisible) return false;

        const currentEl = this.osdController._cachedOverlayRow[this.osdController._currentFocusIndex];
        const isClose = currentEl && currentEl.classList.contains('osd-offset-close');

        switch (key) {
            case 'left':
                /*
                 * -------------------------------------------------------------
                 * DPAD LEFT EXIT PATH
                 * -------------------------------------------------------------
                 * Close the lyrics modal and return focus to the player controls.
                 * -------------------------------------------------------------
                 */
                this.osdController.toggleLyricsModal(false);
                return true;

            case 'right':
                /*
                 * -------------------------------------------------------------
                 * DPAD RIGHT NAVIGATION
                 * -------------------------------------------------------------
                 * Horizontal navigation support for the close button.
                 * -------------------------------------------------------------
                 */
                if (isClose && this._focusedIndex === -1) {
                    // Close button horizontal nav -> return to player header or allow default
                    this.osdController._currentFocusRow = 0;
                    this.osdController._currentFocusIndex = 0;
                    this.osdController.activeMenu = null;
                    this.osdController.show();
                    this.osdController._updateFocus();
                    return true;
                }
                return false;

            case 'up':
                if (isClose && this._focusedIndex === -1) return false;
                
                if (this._focusableLines.length > 0 && this._focusedIndex >= 0) {
                    this._handleUserInteraction();
                    if (this._focusedIndex > 0) {
                        this._focusLine(this._focusedIndex - 1);
                    } else if (this._focusedIndex === 0) {
                        // Move to close button
                        const idx = this.osdController._cachedOverlayRow.findIndex(el => el.classList.contains('osd-offset-close'));
                        if (idx !== -1) {
                            if (this._focusableLines[this._focusedIndex]) {
                                this._focusableLines[this._focusedIndex].classList.remove('focused');
                                this._focusableLines[this._focusedIndex].blur(); // Let go of line
                            }
                            this._focusedIndex = -1;
                            this.osdController._currentFocusRow = -1;
                            this.osdController._currentFocusIndex = idx;
                            this.osdController._updateFocus();
                        }
                    }
                    return true;
                }
                return false;

            case 'down':
                if (isClose && this._focusedIndex === -1) {
                    // Move from close button down into the lyrics
                    if (this._focusableLines.length > 0) {
                        this._handleUserInteraction();
                        const targetLine = Math.max(0, this._currentLineIndex);
                        this._focusLine(targetLine);
                        if (currentEl) {
                            currentEl.classList.remove('focused');
                            // Leaving close button: TV focus engine handles moving it via explicit .focus()
                            // in _focusLine, but we can call .blur() on the button just to be absolutely sure
                            currentEl.blur(); 
                        }
                    }
                    return true;
                }
                
                if (this._focusableLines.length > 0 && this._focusedIndex >= 0) {
                    this._handleUserInteraction();
                    if (this._focusedIndex < this._focusableLines.length - 1) {
                        this._focusLine(this._focusedIndex + 1);
                    } else {
                        // Reached bottom, go back to player controls
                        if (this._focusableLines[this._focusedIndex]) {
                            this._focusableLines[this._focusedIndex].classList.remove('focused');
                            this._focusableLines[this._focusedIndex].blur();
                        }
                        this.osdController._currentFocusRow = 1;
                        const lyricsIdx = this.osdController._findActionIndex('lyrics');
                        this.osdController._currentFocusIndex = lyricsIdx !== -1 ? lyricsIdx : 0;
                        this.osdController.show();
                        this.osdController._updateFocus();
                        this._focusedIndex = -1;
                    }
                    return true;
                }
                return false;

            case 'enter':
                if (isClose && this._focusedIndex === -1) {
                    this.osdController.toggleLyricsModal(false);
                    return true;
                }

                if (this._isDynamic && this._focusedIndex >= 0) {
                    const targetLyric = this._lyrics[this._focusedIndex];
                    if (targetLyric && typeof targetLyric.Start !== 'undefined') {
                        log.info(`Seeking to lyric at ${targetLyric.Start} ticks`);
                        // OSDController.player is a getter property, not a function
                        if (this.osdController.player && this.osdController.player.seek) {
                            this.osdController.player.seek(targetLyric.Start);
                        }
                        
                        // Treat seeking as resuming locked mode
                        this._isUserScrolling = false;
                        if (this._userScrollTimeout) clearTimeout(this._userScrollTimeout);
                    }
                    return true;
                }
                return false;

            case 'back':
                this.osdController.toggleLyricsModal(false);
                return true;
        }

        return false;
    }
}
