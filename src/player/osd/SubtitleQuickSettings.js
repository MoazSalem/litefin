import BaseMenu from './BaseMenu.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';

/**
 * SubtitleQuickSettings
 * 
 * A comprehensive modal for the OSD that allows real-time subtitle customization.
 * Features:
 * - Appearance settings (Size, Font, Color, Opacity).
 * - Position settings (Vertical, Custom Offset).
 * - Shadow/Background customization.
 * - Dynamic visibility for dependent sliders.
 * - Synchronization with global PlayerSettings.
 */
export default class SubtitleQuickSettings extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
        this.focusIndex = 0;
        this.items = [];
    }

    open() {
        this.focusIndex = 0;
        this.render();
        this.show();
        
        // Prevent immediate key handling (e.g. the Enter key that opened the menu)
        this.inputBlocked = true;
        setTimeout(() => {
            this.inputBlocked = false;
        }, 300);
    }

    render() {
        if (!this.$el) {
            this.$el = document.createElement('div');
            this.$el.className = 'track-menu-overlay subtitle-settings-overlay';
            document.body.appendChild(this.$el);

            this.$el.addEventListener('click', (e) => {
                if (e.target === this.$el) {
                    this.osd.closeMenu();
                }
            });
        }

        // Generate items list based on current settings
        this._buildItems();

        const itemsHtml = this.items.map((item, i) => this._renderItem(item, i)).join('');

        this.$el.innerHTML = `
            <div class="track-menu subtitle-settings-menu">
                <div class="track-menu-title">Subtitle Appearance</div>
                <div class="track-menu-options">
                    ${itemsHtml}
                </div>
            </div>
        `;

        this._bindEvents();
        this.updateFocus();
    }

    _buildItems() {
        const verticalPos = PlayerSettings.get('subtitleVerticalPosition');
        const bgColor = PlayerSettings.get('subtitleTextBackground');
        const shadowType = PlayerSettings.get('subtitleDropShadow');

        this.items = [
            // Position
            { 
                id: 'position', 
                type: 'select', 
                label: 'Vertical Position', 
                key: 'subtitleVerticalPosition',
                options: [
                    { value: '-1', label: 'Bottom (Low)' },
                    { value: '-2', label: 'Bottom (Standard)' },
                    { value: '-3.6', label: 'Bottom (High)' },
                    { value: '0', label: 'Top' },
                    { value: '2', label: 'Top (Low)' },
                    { value: 'custom', label: 'Custom (Absolute)' }
                ]
            },
            { 
                id: 'customPosition', 
                type: 'slider', 
                label: 'Absolute Position', 
                key: 'subtitleVerticalPositionCustom', 
                min: 0, max: 100, step: 1, unit: '%',
                visible: verticalPos === 'custom'
            },

            // Appearance
            { 
                id: 'size', 
                type: 'select', 
                label: 'Text Size', 
                key: 'subtitleSize',
                options: [
                    { value: 'small', label: 'Small' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'large', label: 'Large' },
                    { value: 'larger', label: 'Larger' },
                    { value: 'extralarge', label: 'Extra Large' }
                ]
            },
            {
                id: 'font',
                type: 'select',
                label: 'Font Family',
                key: 'subtitleFont',
                options: [
                    { value: '', label: 'Default - Tizen Sans' },
                    { value: 'poppins', label: 'Modern - Poppins' },
                    { value: 'noto-arabic', label: 'Arabic - Noto Sans' },
                    { value: 'typewriter', label: 'Typewriter' },
                    { value: 'print', label: 'Print' },
                    { value: 'console', label: 'Console' },
                    { value: 'cursive', label: 'Cursive' },
                    { value: 'casual', label: 'Casual' },
                    { value: 'smallcaps', label: 'Small Caps' }
                ]
            },
            {
                id: 'weight',
                type: 'select',
                label: 'Font Weight',
                key: 'subtitleWeight',
                options: [
                    { value: 'normal', label: 'Normal' },
                    { value: 'bold', label: 'Bold' }
                ]
            },

            // Colors & Opacity
            {
                id: 'color',
                type: 'select',
                label: 'Text Color',
                key: 'subtitleTextColor',
                options: [
                    { value: '#ffffff', label: 'White' },
                    { value: '#d3d3d3', label: 'Light Grey' },
                    { value: '#a9a9a9', label: 'Dark Grey' },
                    { value: '#000000', label: 'Black' },
                    { value: '#ffff00', label: 'Yellow' },
                    { value: '#00ffff', label: 'Cyan' },
                    { value: '#0000ff', label: 'Blue' }
                ]
            },
            { id: 'textOpacity', type: 'slider', label: 'Text Opacity', key: 'subtitleTextOpacity', min: 0, max: 100, step: 5, unit: '%' },
            
            // Background
            {
                id: 'bg',
                type: 'select',
                label: 'Background',
                key: 'subtitleTextBackground',
                options: [
                    { value: 'transparent', label: 'None' },
                    { value: '#000000', label: 'Black' },
                    { value: '#ffffff', label: 'White' },
                    { value: '#d3d3d3', label: 'Light Grey' },
                    { value: '#a9a9a9', label: 'Dark Grey' },
                    { value: '#ffff00', label: 'Yellow' },
                    { value: '#00ffff', label: 'Cyan' },
                    { value: '#0000ff', label: 'Blue' }
                ]
            },
            { 
                id: 'bgOpacity', 
                type: 'slider', 
                label: 'Background Opacity', 
                key: 'subtitleBackgroundOpacity', 
                min: 0, max: 100, step: 5, unit: '%',
                visible: bgColor !== 'transparent'
            },

            // Shadow
            {
                id: 'shadow',
                type: 'select',
                label: 'Text Shadow',
                key: 'subtitleDropShadow',
                options: [
                    { value: 'none', label: 'None' },
                    { value: 'uniform', label: 'Uniform' },
                    { value: 'dropshadow', label: 'Drop Shadow' },
                    { value: 'raised', label: 'Raised' },
                    { value: 'depressed', label: 'Depressed' }
                ]
            },
            {
                id: 'shadowColor',
                type: 'select',
                label: 'Shadow Color',
                key: 'subtitleDropShadowColor',
                options: [
                    { value: '#000000', label: 'Black' },
                    { value: '#ffffff', label: 'White' },
                    { value: '#ff0000', label: 'Red' },
                    { value: '#00ff00', label: 'Green' },
                    { value: '#0000ff', label: 'Blue' },
                    { value: '#ffff00', label: 'Yellow' },
                    { value: '#00ffff', label: 'Cyan' },
                    { value: '#ff00ff', label: 'Magenta' },
                    { value: '#808080', label: 'Grey' }
                ],
                visible: shadowType !== 'none'
            },
            { 
                id: 'shadowOpacity', 
                type: 'slider', 
                label: 'Shadow Opacity', 
                key: 'subtitleDropShadowOpacity', 
                min: 0, max: 100, step: 5, unit: '%',
                visible: shadowType !== 'none'
            },
            { 
                id: 'shadowBlur', 
                type: 'slider', 
                label: 'Shadow Blur', 
                key: 'subtitleDropShadowBlur', 
                min: 0, max: 20, step: 1, unit: 'px',
                visible: shadowType !== 'none'
            }
        ];

        // Filter out invisible items
        this.items = this.items.filter(item => item.visible !== false);
    }

    _renderItem(item, index) {
        const isFocused = index === this.focusIndex;
        const value = item.type === 'slider' ? item.value ?? PlayerSettings.get(item.key) : PlayerSettings.get(item.key);
        
        let controlHtml = '';
        if (item.type === 'select') {
            const currentOption = item.options.find(opt => String(opt.value) === String(value)) || item.options[0];
            controlHtml = `<div class="sub-setting-value">${currentOption.label}</div>`;
        } else if (item.type === 'slider') {
            const percent = ((value - item.min) / (item.max - item.min)) * 100;
            const sign = (item.id === 'offset' && value > 0) ? '+' : '';
            controlHtml = `
                <div class="sub-setting-slider-group">
                    <div class="osd-slider-container menu-slider">
                        <input type="range" class="osd-slider" min="${item.min}" max="${item.max}" step="${item.step}" value="${value}" disabled style="--progress: ${percent}%">
                    </div>
                    <span class="sub-setting-value">${sign}${value}${item.unit || ''}</span>
                </div>
            `;
        }

        return `
            <div class="track-option track-item subtitle-setting-item ${isFocused ? 'focused' : ''}" 
                 data-index="${index}" 
                 tabindex="0">
                <div class="sub-setting-label">${item.label}</div>
                <div class="sub-setting-control">${controlHtml}</div>
            </div>
        `;
    }

    _bindEvents() {
        // TV navigation uses keyboard events via handleKey, not click events
        // Click handlers removed to prevent spurious triggers on menu open
    }

    handleKey(key) {
        if (this.inputBlocked) return true;

        const maxIndex = this.items.length - 1;

        switch (key) {
            case 'up':
                if (this.focusIndex > 0) {
                    this.focusIndex--;
                } else {
                    this.focusIndex = maxIndex;
                }
                this.updateFocus();
                return true;
            case 'down':
                if (this.focusIndex < maxIndex) {
                    this.focusIndex++;
                } else {
                    this.focusIndex = 0;
                }
                this.updateFocus();
                return true;
            case 'left':
                this._handleAdjust(-1);
                return true;
            case 'right':
                this._handleAdjust(1);
                return true;
            case 'enter':
                this._handleAdjust(1); // Cycling for select items
                return true;
            case 'back':
                this.hide();
                this.osd.toggleSettings(true);
                return true;
        }
        return false;
    }

    _handleAdjust(direction) {
        const item = this.items[this.focusIndex];
        if (!item) return;

        if (item.type === 'select') {
            const currentValue = String(PlayerSettings.get(item.key));
            const currentIndex = item.options.findIndex(opt => String(opt.value) === currentValue);
            let nextIndex = currentIndex + direction;

            if (nextIndex < 0) nextIndex = item.options.length - 1;
            if (nextIndex >= item.options.length) nextIndex = 0;

            const nextOption = item.options[nextIndex];
            PlayerSettings.set(item.key, nextOption.value);
            
            // Special case: Vertical Position affects Custom Offset
            // Background/Shadow affect their sliders
            this.render(); // Re-render to update dynamic visibility

        } else if (item.type === 'slider') {
            const currentValue = PlayerSettings.get(item.key);
            let nextValue = currentValue + (item.step * direction);
            
            // Clamp
            nextValue = Math.max(item.min, Math.min(item.max, nextValue));
            nextValue = Math.round(nextValue * 10) / 10; // Precision

            PlayerSettings.set(item.key, nextValue);
            this.render();
        }

        // Apply changes immediately (most logic is in PlayerSettings.set listeners in PlayerPage/JellyfinPlayer)
        if (this.player && this.player.refreshSubtitles) {
             this.player.refreshSubtitles();
        }
    }

    updateFocus() {
        if (!this.$el) return;
        const items = this.$el.querySelectorAll('.track-item');
        items.forEach((opt, i) => {
            const isFocused = i === this.focusIndex;
            opt.classList.toggle('focused', isFocused);
            if (isFocused) {
                opt.focus();
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }
}
