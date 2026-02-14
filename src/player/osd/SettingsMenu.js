import BaseMenu from './BaseMenu.js';
import { ICONS } from './icons.js';

/**
 * SettingsMenu
 * 
 * Handles player configuration options.
 * Currently supports:
 * - Playback Speed selection.
 * - "Stats for nerds" (toggling the PlaybackInfo overlay).
 * 
 * Uses a modal list layout for option selection.
 */
export default class SettingsMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
    }

    open() {
        this.focusIndex = 0;
        this.render();
        this.show();
    }

    show() {
        // Capture focus context before opening
        this._prevFocus = this.osd._getFocused(); // Helper in controller or native
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

        // Restore focus to the specific button that opened it
        if (this._prevRow !== undefined) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();
        }
    }

    render() {
        if (!this.$el) {
            this.$el = document.createElement('div');
            this.$el.className = 'track-menu-overlay';
            document.body.appendChild(this.$el);

            this.$el.addEventListener('click', (e) => {
                if (e.target === this.$el) {
                    this.osd.closeMenu();
                }
            });
        }

        const options = [
            { id: 'playbackInfo', label: 'Playback Info', icon: ICONS.info },
            { id: 'subtitleOffset', label: 'Subtitle Offset', icon: ICONS.sync }
            // Future: { id: 'skipIntro', label: 'Skip Intro', icon: ... }
        ];

        const optionsHtml = options.map((opt, i) => `
            <button class="track-option track-item" data-id="${opt.id}" data-menu-index="${i}">
                <span class="track-option-icon">${opt.icon || ''}</span>
                <span class="track-option-label">${opt.label}</span>
            </button>
        `).join('');

        this.$el.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title">Settings</div>
                <div class="track-menu-options">
                    ${optionsHtml}
                </div>
            </div>
        `;

        this.$el.querySelectorAll('.track-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.focusIndex = parseInt(btn.dataset.menuIndex);
                this.handleEnter();
            });
        });

        this.updateFocus();
    }

    handleKey(key) {
        const options = this.$el?.querySelectorAll('.track-option') || [];
        
        switch (key) {
            case 'up':
                if (this.focusIndex > 0) {
                    this.focusIndex--;
                    this.updateFocus();
                }
                return true;
            case 'down':
                if (this.focusIndex < options.length - 1) {
                    this.focusIndex++;
                    this.updateFocus();
                }
                return true;
            case 'enter':
                // Rely on native click event which is triggered by the browser on Enter
                return true;
            case 'back':
            case 'left':
            case 'right':
                this.osd.closeMenu();
                return true;
        }
        return false;
    }

    handleEnter() {
        const options = this.$el?.querySelectorAll('.track-option') || [];
        const focusedOption = options[this.focusIndex];
        if (!focusedOption) return;

        const actionId = focusedOption.dataset.id;
        
        // Use closeMenu to cleanup focus properly
        this.osd.closeMenu();

        switch (actionId) {
            case 'playbackInfo':
                this.osd.togglePlaybackInfo(!this.osd.playbackInfo.isVisible);
                break;
            case 'subtitleOffset':
                this.osd.toggleSubtitleOffset(!this.osd.subtitleOffset.isVisible);
                break;
        }
    }

    updateFocus() {
        if (!this.$el) return;
        const options = this.$el.querySelectorAll('.track-option');
        options.forEach((opt, i) => {
            const isFocused = i === this.focusIndex;
            opt.classList.toggle('focused', isFocused);
            if (isFocused) {
                opt.focus();
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }
}