import BaseMenu from './BaseMenu.js';
import { ICONS } from './icons.js';
import { logger } from '../../utils/Logger.js';
import { i18n } from '../../utils/i18n.js';

const log = logger.create('AspectRatioMenu');

export default class AspectRatioMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
        this.options = [
            { id: 'auto', label: i18n.t('Auto'), key: 'Auto', icon: ICONS.aspectRatio },
            { id: 'zoom', label: i18n.t('Zoom'), key: 'Zoom', icon: ICONS.zoomIn },
            { id: 'stretch', label: i18n.t('Stretch'), key: 'Stretch', icon: ICONS.aspectRatio } // Reusing icon for now
        ];
    }

    open() {
        this.focusIndex = 0;
        // Pre-select current aspect ratio
        const current = this.osd.player.getAspectRatio();
        const index = this.options.findIndex(opt => opt.id === current);
        if (index !== -1) {
            this.focusIndex = index;
        }

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

        // Restore focus to Settings Menu if it's open, otherwise back to OSD
        // Note: Logic in OSDController usually handles "back" stack, but here we just restore
        // to where we came from.
        if (this._prevRow !== undefined) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();
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

        const current = this.osd.player.getAspectRatio();

        const optionsHtml = this.options.map((opt, i) => {
            const isSelected = opt.id === current;
            const checkIcon = isSelected ? ICONS.check : '';
            
            return `
            <button class="track-option track-item ${isSelected ? 'selected' : ''}" 
                    data-id="${opt.id}" data-menu-index="${i}">
                <span class="track-option-icon">${opt.icon || ''}</span>
                <span class="track-option-label" data-i18n="${opt.key}">${opt.label}</span>
                <span class="track-option-check">${checkIcon}</span>
            </button>
            `;
        }).join('');

        this.$el.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title" data-i18n="AspectRatio">${i18n.t('AspectRatio')}</div>
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
                return true; // Click handled by click listener
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
            log.info('Selected aspect ratio:', selected.id);
            this.osd.player.setAspectRatio(selected.id);
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
                opt.focus();
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }
}
