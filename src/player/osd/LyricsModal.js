import Component from '../../core/Component.js';
import { logger } from '../../utils/Logger.js';

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
    }

    render() {
        this.el = document.createElement('div');
        this.el.id = 'lyrics-modal';
        this.el.className = 'osd-modal lyrics-modal hidden';
        
        this.el.innerHTML = `
            <div class="osd-modal-header">
                <h2>Lyrics</h2>
                <div class="osd-modal-close">X</div>
            </div>
            <div class="lyrics-container">
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
        this.el.classList.remove('hidden');
        
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
            this.el.classList.add('hidden');
        }
        this._lyrics = [];
        this._currentLineIndex = -1;
        this._focusedIndex = -1;
        this._focusableLines = [];
        if (this._scrollTimeout) {
            clearTimeout(this._scrollTimeout);
        }
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
            
            html += `<div class="${classes.join(' ')}" data-index="${index}" id="lyric-line-${index}">`;
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
            
            // When automatically advancing, we also want to move focus if user hasn't manually taken over
            // For simplicity on TV, we'll keep the focused item locked to the currently playing item
            // unless they are actively scrolling. 
            this._focusLine(Math.max(0, newIndex), instant);
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

        this.$container.scrollTo({
            top: scrollTop,
            behavior: instant ? 'auto' : 'smooth'
        });
    }

    /**
     * Handle d-pad navigation and enter within the modal
     * @param {string} key - 'up', 'down', 'enter', 'back'
     * @returns {boolean} - True if handled
     */
    handleInput(key) {
        if (!this._isVisible) return false;

        if (key === 'back') {
            this.osdController.toggleLyricsModal(false);
            return true;
        }

        if (this._focusableLines.length === 0) return true;

        if (key === 'up') {
            if (this._focusedIndex > 0) {
                this._focusLine(this._focusedIndex - 1);
            }
            return true;
        }

        if (key === 'down') {
            if (this._focusedIndex < this._focusableLines.length - 1) {
                this._focusLine(this._focusedIndex + 1);
            }
            return true;
        }

        if (key === 'enter' && this._isDynamic) {
            const targetLyric = this._lyrics[this._focusedIndex];
            if (targetLyric && typeof targetLyric.Start !== 'undefined') {
                log.info(`Seeking to lyric at ${targetLyric.Start} ticks`);
                // Use the main player to seek via OSDController proxy
                this.osdController._performDebouncedSeek(0); // Clear debounce
                this.osdController.player().seek(targetLyric.Start);
                
                // Keep modal open, just seek
            }
            return true;
        }

        return true; // We consume all other inputs while modal is open
    }
}
