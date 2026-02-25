import BaseMenu from './BaseMenu.js';
import { ICONS } from './icons.js';
import { playQueue } from '../../core/PlayQueue.js';
import { i18n } from '../../utils/i18n.js';

/**
 * RepeatModeMenu
 * 
 * Sub-menu for selecting the repeat mode (Repeat None, Repeat All, Repeat One).
 */
export default class RepeatModeMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
    }

    open() {
        this.render();
        this.show();
    }

    show() {
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

        const currentMode = playQueue.getRepeatMode() || 'RepeatNone';

        const modes = [
            { id: 'RepeatNone', label: i18n.t('Off'), key: 'Off', icon: ICONS.repeat },
            { id: 'RepeatAll', label: i18n.t('RepeatAll'), key: 'RepeatAll', icon: ICONS.repeat },
            { id: 'RepeatOne', label: i18n.t('RepeatOne'), key: 'RepeatOne', icon: ICONS.repeatOne }
        ];

        let selectedIndex = modes.findIndex(m => m.id === currentMode);
        if (selectedIndex === -1) selectedIndex = 0;
        this.focusIndex = selectedIndex;

        const optionsHtml = modes.map((mode, i) => {
            const isSelected = mode.id === currentMode;
            return `
            <button class="track-option track-item ${isSelected ? 'selected' : ''}" data-id="${mode.id}" data-menu-index="${i}">
                <span class="track-option-icon">${mode.icon}</span>
                <span class="track-option-label" data-i18n="${mode.key}">${mode.label}</span>
                ${isSelected ? `<span class="track-option-check">${ICONS.check}</span>` : ''}
            </button>
        `}).join('');

        this.$el.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title" data-i18n="RepeatMode">${i18n.t('RepeatMode')}</div>
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
                } else {
                    this.focusIndex = options.length - 1;
                }
                this.updateFocus();
                return true;
            case 'down':
                if (this.focusIndex < options.length - 1) {
                    this.focusIndex++;
                } else {
                    this.focusIndex = 0;
                }
                this.updateFocus();
                return true;
            case 'enter':
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

        const modeId = focusedOption.dataset.id;
        playQueue.setRepeatMode(modeId);

        this.osd.closeMenu();
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
