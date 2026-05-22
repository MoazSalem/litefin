import BaseMenu from './BaseMenu.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { i18n } from '../../utils/i18n.js';
import { platformInfo } from '../../utils/PlatformInfo.js';

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
    constructor( osdController ) {
        super( osdController );
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
        setTimeout( () => {
            this.inputBlocked = false;
        }, 300 );
    }

    render() {
        if ( !this.$el ) {
            this.$el = document.createElement( 'div' );
            this.$el.className = 'track-menu-overlay subtitle-settings-overlay';
            document.body.appendChild( this.$el );

            this.$el.addEventListener( 'click', ( e ) => {
                if ( e.target === this.$el ) {
                    this.osd.closeMenu();
                }
            } );
        }

        // Generate items list based on current settings
        this._buildItems();

        const itemsHtml = this.items.map( ( item, i ) => this._renderItem( item, i ) ).join( '' );

        this.$el.innerHTML = `
            <div class="track-menu subtitle-settings-menu">
                <div class="track-menu-title">${i18n.t('SubtitleAppearance')}</div>
                <div class="track-menu-options">
                    ${itemsHtml}
                </div>
            </div>
        `;

        this._updateSliderFills();

        this._bindEvents();
        this.updateFocus();
    }

    _buildItems() {
        const verticalPos = PlayerSettings.get( 'subtitleVerticalPosition' );
        const bgColor = PlayerSettings.get( 'subtitleTextBackground' );
        const shadowType = PlayerSettings.get( 'subtitleDropShadow' );

        // Check if we are currently rendering ASS subtitles
        const isASS = this.osd && this.osd.player && this.osd.player._subtitleManager && this.osd.player._subtitleManager.isASSActive();

        // Whether the outline/shadow user overrides are enabled (default: true)
        const overrideOutlineShadow = PlayerSettings.get( 'subtitleOverrideAssOutlineShadow' ) !== false;
        
        // Whether ASS fonts override is enabled (default: false)
        const overrideAssFonts = PlayerSettings.get('subtitleOverrideAssFonts') === true;

        // Check if a secondary subtitle track is active
        // osd.currentSecondarySubtitleIndex is -1 when no secondary track is selected
        const hasSecondary = this.osd && this.osd.currentSecondarySubtitleIndex !== undefined &&
                             this.osd.currentSecondarySubtitleIndex !== -1 &&
                             this.osd.currentSecondarySubtitleIndex !== null;

        this.items = [
            // Position
            {
                id: 'position',
                type: 'select',
                label: i18n.t('VerticalPosition'),
                labelKey: 'VerticalPosition',
                key: 'subtitleVerticalPosition',
                visible: !isASS,
                options: [
                    { value: '-1', label: i18n.t('BottomLow') },
                    { value: '-2', label: i18n.t('BottomStandard') },
                    { value: '-3.6', label: i18n.t('BottomHigh') },
                    { value: '0', label: i18n.t('Top') },
                    { value: '2', label: i18n.t('TopLow') },
                    { value: 'custom', label: i18n.t('CustomAbsolute') }
                ]
            },
            {
                id: 'customPosition',
                type: 'slider',
                label: i18n.t('AbsolutePosition'),
                labelKey: 'AbsolutePosition',
                key: 'subtitleVerticalPositionCustom',
                min: 0, max: 100, step: 1, unit: '%',
                visible: !isASS && verticalPos === 'custom'
            },

            // Appearance
            {
                id: 'size',
                type: 'select',
                label: i18n.t('LabelTextSize'),
                labelKey: 'LabelTextSize',
                key: 'subtitleSize',
                visible: !isASS,
                options: [
                    { value: 'small', label: i18n.t('Small') },
                    { value: 'medium', label: i18n.t('Medium') },
                    { value: 'mediumlarge', label: i18n.t('MediumLarge') },
                    { value: 'large', label: i18n.t('Large') },
                    { value: 'larger', label: i18n.t('Larger') },
                    { value: 'extralarge', label: i18n.t('ExtraLarge') },
                    { value: 'custom', label: i18n.t('Custom') }
                ]
            },
            {
                id: 'customSize',
                type: 'slider',
                label: i18n.t('CustomSize'),
                labelKey: 'CustomSize',
                key: 'subtitleSizeCustomValue',
                min: 1, max: 20, step: 0.1, unit: 'vh',
                visible: !isASS && PlayerSettings.get('subtitleSize') === 'custom'
            },
            {
                id: 'font',
                type: 'select',
                label: i18n.t('FontFamily'),
                labelKey: 'FontFamily',
                key: 'subtitleFont',
                visible: !isASS,
                options: [
                    { value: '', label: i18n.t(platformInfo.isWebOS ? 'DefaultWebOSSans' : 'DefaultTizenSans') },
                    { value: 'poppins', label: i18n.t('ModernPoppins') },
                    { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                    { value: 'typewriter', label: i18n.t('Typewriter') },
                    { value: 'print', label: i18n.t('Print') },
                    { value: 'console', label: i18n.t('Console') },
                    { value: 'cursive', label: i18n.t('Cursive') },
                    { value: 'casual', label: i18n.t('Casual') },
                    { value: 'smallcaps', label: i18n.t('SmallCaps') },
                    { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' },
                    { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' },
                    { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' },
                    { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' },
                    { value: 'inter', label: i18n.t('FontInter') || 'Inter' },
                    { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' },
                    { value: 'baloo', label: i18n.t('FontBaloo') || 'Baloo Bhaijaan 2' }
                ]
            },
            {
                id: 'weight',
                type: 'select',
                label: i18n.t('FontWeight'),
                labelKey: 'FontWeight',
                key: 'subtitleWeight',
                visible: !isASS,
                options: [
                    { value: 'normal', label: i18n.t('Normal') },
                    { value: 'bold', label: i18n.t('Bold') }
                ]
            },

            // Colors & Opacity
            {
                id: 'color',
                type: 'select',
                label: i18n.t('TextColor'),
                labelKey: 'TextColor',
                key: 'subtitleTextColor',
                visible: !isASS,
                options: [
                    { value: '#ffffff', label: i18n.t('SubtitleWhite') },
                    { value: '#d3d3d3', label: i18n.t('LightGrey') },
                    { value: '#a9a9a9', label: i18n.t('DarkGrey') },
                    { value: '#000000', label: i18n.t('SubtitleBlack') },
                    { value: '#ffff00', label: i18n.t('SubtitleYellow') },
                    { value: '#00ffff', label: i18n.t('SubtitleCyan') },
                    { value: '#0000ff', label: i18n.t('SubtitleBlue') }
                ]
            },
            
            /* -------------------------------------------------------------
               SDR Subtitle Opacity Slider (Apple HIG Elegant Layout)
               Allows precise opacity adjustments when viewing standard range media.
               ------------------------------------------------------------- */
            {
                id: 'textOpacitySdr',
                type: 'slider',
                label: i18n.t('TextOpacitySdr'),
                labelKey: 'TextOpacitySdr',
                key: 'subtitleTextOpacity',
                min: 0,
                max: 100,
                step: 5,
                unit: '%',
                visible: !isASS
            },

            /* -------------------------------------------------------------
               HDR Subtitle Opacity Slider (Apple HIG Elegant Layout)
               Allows separate precise control when viewing HDR media (high peak brightness).
               ------------------------------------------------------------- */
            {
                id: 'textOpacityHdr',
                type: 'slider',
                label: i18n.t('TextOpacityHdr'),
                labelKey: 'TextOpacityHdr',
                key: 'subtitleTextOpacityHdr',
                min: 0,
                max: 100,
                step: 5,
                unit: '%',
                visible: !isASS
            },

            // Background
            {
                id: 'bg',
                type: 'select',
                label: i18n.t('BackgroundColor'),
                labelKey: 'BackgroundColor',
                key: 'subtitleTextBackground',
                visible: !isASS,
                options: [
                    { value: 'transparent', label: i18n.t('None') },
                    { value: '#000000', label: i18n.t('SubtitleBlack') },
                    { value: '#ffffff', label: i18n.t('SubtitleWhite') },
                    { value: '#d3d3d3', label: i18n.t('LightGrey') },
                    { value: '#a9a9a9', label: i18n.t('DarkGrey') },
                    { value: '#ffff00', label: i18n.t('SubtitleYellow') },
                    { value: '#00ffff', label: i18n.t('SubtitleCyan') },
                    { value: '#0000ff', label: i18n.t('SubtitleBlue') }
                ]
            },
            {
                id: 'bgOpacity',
                type: 'slider',
                label: i18n.t('BackgroundOpacity'),
                labelKey: 'BackgroundOpacity',
                key: 'subtitleBackgroundOpacity',
                min: 0, max: 100, step: 5, unit: '%',
                visible: !isASS && bgColor !== 'transparent'
            },

            // Shadow
            {
                id: 'shadow',
                type: 'select',
                label: i18n.t('TextShadow'),
                labelKey: 'TextShadow',
                key: 'subtitleDropShadow',
                visible: !isASS,
                options: [
                    { value: 'none', label: i18n.t('None') },
                    { value: 'uniform', label: i18n.t('Uniform') },
                    { value: 'dropshadow', label: i18n.t('DropShadow') },
                    { value: 'raised', label: i18n.t('Raised') },
                    { value: 'depressed', label: i18n.t('Depressed') },
                    { value: 'border', label: i18n.t('Border') }
                ]
            },
            {
                id: 'borderWidth',
                type: 'slider',
                label: i18n.t('BorderWidth'),
                labelKey: 'BorderWidth',
                key: 'subtitleBorderWidth',
                min: 1, max: 20, step: 1, unit: 'px',
                visible: !isASS && shadowType === 'border'
            },
            {
                id: 'shadowColor',
                type: 'select',
                label: i18n.t('ShadowColor'),
                labelKey: 'ShadowColor',
                key: 'subtitleDropShadowColor',
                options: [
                    { value: '#000000', label: i18n.t('SubtitleBlack') },
                    { value: '#ffffff', label: i18n.t('SubtitleWhite') },
                    { value: '#ff0000', label: i18n.t('SubtitleRed') },
                    { value: '#00ff00', label: i18n.t('SubtitleGreen') },
                    { value: '#0000ff', label: i18n.t('SubtitleBlue') },
                    { value: '#ffff00', label: i18n.t('SubtitleYellow') },
                    { value: '#00ffff', label: i18n.t('SubtitleCyan') },
                    { value: '#ff00ff', label: i18n.t('SubtitleMagenta') },
                    { value: '#808080', label: i18n.t('Grey') }
                ],
                visible: !isASS && shadowType !== 'none'
            },
            {
                id: 'shadowOpacity',
                type: 'slider',
                label: i18n.t('ShadowOpacity'),
                labelKey: 'ShadowOpacity',
                key: 'subtitleDropShadowOpacity',
                min: 0, max: 100, step: 5, unit: '%',
                visible: !isASS && shadowType !== 'none'
            },
            {
                id: 'shadowBlur',
                type: 'slider',
                label: i18n.t('ShadowBlur'),
                labelKey: 'ShadowBlur',
                key: 'subtitleDropShadowBlur',
                min: 0, max: 20, step: 1, unit: 'px',
                visible: !isASS && shadowType !== 'none' && shadowType !== 'border'
            }, 
            {
                id: 'overrideAssFonts',
                type: 'select',
                label: i18n.t('OverrideAssFonts'),
                labelKey: 'OverrideAssFonts',
                key: 'subtitleOverrideAssFonts',
                visible: isASS,
                options: [
                    { value: true,  label: i18n.t('On') },
                    { value: false, label: i18n.t('Off') }
                ]
            },
            {
                id: 'fontAss',
                type: 'select',
                label: i18n.t('AssFontFamily'),
                labelKey: 'AssFontFamily',
                key: 'subtitleFontAss',
                visible: isASS && overrideAssFonts,
                options: [
                    { value: '', label: i18n.t(platformInfo.isWebOS ? 'DefaultWebOSSans' : 'DefaultTizenSans') },
                    { value: 'poppins', label: i18n.t('ModernPoppins') },
                    { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                    { value: 'typewriter', label: i18n.t('Typewriter') },
                    { value: 'print', label: i18n.t('Print') },
                    { value: 'console', label: i18n.t('Console') },
                    { value: 'cursive', label: i18n.t('Cursive') },
                    { value: 'casual', label: i18n.t('Casual') },
                    { value: 'smallcaps', label: i18n.t('SmallCaps') },
                    { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' },
                    { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' },
                    { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' },
                    { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' },
                    { value: 'inter', label: i18n.t('FontInter') || 'Inter' },
                    { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' },
                    { value: 'baloo', label: i18n.t('FontBaloo') || 'Baloo Bhaijaan 2' }
                ]
            },
            {
                id: 'fontScaleAss',
                type: 'slider',
                label: i18n.t('FontScaleAss'),
                labelKey: 'FontScaleAss',
                key: 'subtitleFontScale',
                min: 0.5, max: 3.0, step: 0.1, unit: 'x',
                visible: isASS
            },
            {
                id: 'bottomOffsetAss',
                type: 'slider',
                label: i18n.t('VerticalPositionAss'),
                labelKey: 'VerticalPositionAss',
                key: 'subtitleBottomOffset',
                min: -100, max: 750, step: 5, unit: 'px',
                visible: isASS
            },
            {
                id: 'overrideOutlineShadow',
                type: 'select',
                label: i18n.t( 'OverrideOutlineShadow' ),
                labelKey: 'OverrideOutlineShadow',
                key: 'subtitleOverrideAssOutlineShadow',
                visible: isASS,
                options: [
                    { value: true,  label: i18n.t( 'On' )  },
                    { value: false, label: i18n.t( 'Off' ) }
                ]
            },
            {
                id: 'outlineThicknessAss',
                type: 'slider',
                label: i18n.t('OutlineThicknessAss'),
                labelKey: 'OutlineThicknessAss',
                key: 'subtitleOutlineThickness',
                min: 0.0, max: 5.0, step: 0.1, unit: '',
                visible: isASS && overrideOutlineShadow
            },
            {
                id: 'shadowThicknessAss',
                type: 'slider',
                label: i18n.t('ShadowThicknessAss'),
                labelKey: 'ShadowThicknessAss',
                key: 'subtitleShadowThickness',
                min: 0.0, max: 5.0, step: 0.1, unit: '',
                visible: isASS && overrideOutlineShadow
            },
            {
                id: 'lineHeightAss',
                type: 'slider',
                label: i18n.t('VerticalSpacingAss'),
                labelKey: 'VerticalSpacingAss',
                key: 'subtitleLineHeight',
                min: -50, max: 50, step: 1, unit: 'px',
                visible: isASS
            },
            {
                id: 'letterSpacingAss',
                type: 'slider',
                label: i18n.t('HorizontalSpacingAss'),
                labelKey: 'HorizontalSpacingAss',
                key: 'subtitleLetterSpacing',
                min: -20, max: 40, step: 0.5, unit: 'px',
                visible: isASS
            },
 
            // ================================================================
            // SECONDARY SUBTITLE SETTINGS
            // Shown only when a secondary subtitle track is active and primary
            // is not ASS. Secondary inherits all appearance from primary \u2014
            // only position and size are independently configurable here.
            // ================================================================
            {
                id: 'secondaryPosition',
                type: 'slider',
                label: i18n.t('SecondarySubtitlePosition'),
                labelKey: 'SecondarySubtitlePosition',
                key: 'secondarySubtitleVerticalPositionCustom',
                min: 0, max: 100, step: 1, unit: '%',
                visible: hasSecondary
            },
            {
                id: 'secondarySize',
                type: 'select',
                label: i18n.t('SecondarySize'),
                labelKey: 'SecondarySize',
                key: 'secondarySubtitleSize',
                visible: hasSecondary,
                options: [
                    { value: 'smaller',    label: i18n.t('Smaller') },
                    { value: 'small',      label: i18n.t('Small') },
                    { value: 'medium',     label: i18n.t('Medium') },
                    { value: 'large',      label: i18n.t('Large') },
                    { value: 'larger',     label: i18n.t('Larger') },
                    { value: 'extralarge', label: i18n.t('ExtraLarge') }
                ]
            }
        ];

        // Filter out invisible items
        this.items = this.items.filter( item => item.visible !== false );
    }

    _renderItem( item, index ) {
        const isFocused = index === this.focusIndex;
        const value = item.type === 'slider' ? item.value ?? PlayerSettings.get( item.key ) : PlayerSettings.get( item.key );

        let controlHtml = '';
        if ( item.type === 'select' ) {
            const currentOption = item.options.find( opt => String( opt.value ) === String( value ) ) || item.options[ 0 ];
            controlHtml = `<div class="sub-setting-value">${currentOption.label}</div>`;
        } else if ( item.type === 'slider' ) {
            const percent = ( ( value - item.min ) / ( item.max - item.min ) ) * 100;
            const sign = ( item.id === 'offset' && value > 0 ) ? '+' : '';
            controlHtml = `
                <div class="sub-setting-slider-group">
                    <div class="osd-slider-container menu-slider">
                        <div class="osd-slider-track">
                            <div class="osd-slider-fill" data-percent="${percent}"></div>
                        </div>
                        <input type="range" class="osd-slider" min="${item.min}" max="${item.max}" step="${item.step}" value="${value}">
                    </div>
                    <span class="sub-setting-value">${sign}${value}${item.unit || ''}</span>
                </div>
            `;
        }

        return `
            <div class="track-option track-item subtitle-setting-item ${isFocused ? 'focused' : ''}" 
                 data-index="${index}" 
                 tabindex="0">
                <div class="sub-setting-label" data-i18n="${item.labelKey || ''}">${item.label}</div>
                <div class="sub-setting-control">${controlHtml}</div>
            </div>
        `;
    }

    _bindEvents() {
        // TV navigation uses keyboard events via handleKey, not click events
        // Click handlers removed to prevent spurious triggers on menu open
    }

    handleKey( key ) {
        if ( this.inputBlocked ) return true;

        const maxIndex = this.items.length - 1;

        switch ( key ) {
            case 'up':
                if ( this.focusIndex > 0 ) {
                    this.focusIndex--;
                } else {
                    this.focusIndex = maxIndex;
                }
                this.updateFocus();
                return true;
            case 'down':
                if ( this.focusIndex < maxIndex ) {
                    this.focusIndex++;
                } else {
                    this.focusIndex = 0;
                }
                this.updateFocus();
                return true;
            case 'left':
                this._handleAdjust( document.documentElement.dir === 'rtl' ? 1 : -1 );
                return true;
            case 'right':
                this._handleAdjust( document.documentElement.dir === 'rtl' ? -1 : 1 );
                return true;
            case 'enter':
                this._handleAdjust( 1 ); // Cycling for select items
                return true;
            case 'back':
                this.hide();
                this.osd.toggleSettings( true );
                return true;
        }
        return false;
    }

    _handleAdjust( direction ) {
        const item = this.items[ this.focusIndex ];
        if ( !item ) return;

        if ( item.type === 'select' ) {
            const currentValue = String( PlayerSettings.get( item.key ) );
            const currentIndex = item.options.findIndex( opt => String( opt.value ) === currentValue );
            let nextIndex = currentIndex + direction;

            if ( nextIndex < 0 ) nextIndex = item.options.length - 1;
            if ( nextIndex >= item.options.length ) nextIndex = 0;

            const nextOption = item.options[ nextIndex ];
            PlayerSettings.set( item.key, nextOption.value );

            // Special case: Vertical Position affects Custom Offset
            // Background/Shadow affect their sliders
            this.render(); // Re-render to update dynamic visibility

        } else if ( item.type === 'slider' ) {
            const currentValue = PlayerSettings.get( item.key );
            let nextValue = currentValue + ( item.step * direction );

            // Clamp
            nextValue = Math.max( item.min, Math.min( item.max, nextValue ) );
            // Use 2 decimal places for better slider precision (e.g. 0.05 steps)
            nextValue = Math.round( nextValue * 100 ) / 100;

            PlayerSettings.set( item.key, nextValue );
            this.render();
        }

        // Apply changes immediately (most logic is in PlayerSettings.set listeners in PlayerPage/JellyfinPlayer)
        if ( this.player && this.player.refreshSubtitles ) {
            this.player.refreshSubtitles();
        }
    }

    updateFocus() {
        if ( !this.$el ) return;
        const items = this.$el.querySelectorAll( '.track-item' );
        items.forEach( ( opt, i ) => {
            const isFocused = i === this.focusIndex;
            opt.classList.toggle( 'focused', isFocused );
            if ( isFocused ) {
                opt.focus();
                opt.scrollIntoView( { block: 'nearest', behavior: 'smooth' } );
            }
        } );
    }

    /**
     * Update all slider fill widths based on their data-percent attributes.
     * This is the CSP-Safe way to handle progress bar fills on Tizen.
     */
    _updateSliderFills() {
        if ( !this.$el ) return;
        const fills = this.$el.querySelectorAll( '.osd-slider-fill' );
        fills.forEach( ( fill ) => {
            const percent = fill.getAttribute( 'data-percent' );
            if ( percent !== null ) {
                fill.style.width = percent + '%';
            }
        } );
    }
}
