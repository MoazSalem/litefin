/**
 * ============================================================================
 * Litefin Tizen - Subtitles Tab Controller
 * ============================================================================
 * Manages playback subtitle preferences, track persistence, external SRT/VTT
 * priority, SSA/ASS renderer engines, visual styling (fonts, colors, sizes,
 * background, shadows, SDR/HDR opacities), and advanced ASS style overrides.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { platformInfo } from '../../../utils/PlatformInfo.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';
import { focusManager } from '../../../ui/FocusManager.js';

const log = logger.create('SubtitlesTab');

/**
 * Controller for the Settings Subtitles tab.
 */
export class SubtitlesTab {
    /**
     * Initializes a new instance of SubtitlesTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Parent SettingsPage reference for rendering common controls
        this.page = pageContext;

        // Active DOM event listeners tracked for deterministic cleanup
        this._listeners = [];
    }

    /**
     * Helper to render dropdown markup via parent page facade.
     * @private
     */
    _drop(id, options, current) {
        if (this.page && typeof this.page._renderDropdown === 'function') {
            return this.page._renderDropdown(id, options, current);
        }
        return '';
    }

    /**
     * Helper to render slider markup via parent page facade.
     * @private
     */
    _slider(id, value, min, max, step, unit) {
        if (this.page && typeof this.page._renderSlider === 'function') {
            return this.page._renderSlider(id, value, min, max, step, unit);
        }
        return '';
    }

    /**
     * Helper to wrap a standard setting item with its label and control.
     * @private
     */
    _item(nameKey, nameFallback, descKey, descFallback, controlHtml, containerId = '', isVisible = true) {
        const idAttr = containerId ? ` id="${containerId}"` : '';
        const styleAttr = isVisible ? '' : ' style="display: none"';
        const nameText = i18n.t(nameKey) || nameFallback;
        const descText = i18n.t(descKey) || descFallback;

        return `
            <div class="setting-item"${idAttr}${styleAttr}>
                <div class="setting-label">
                    <span class="setting-name" data-i18n="${nameKey}">${nameText}</span>
                    <span class="setting-description" data-i18n="${descKey}">${descText}</span>
                </div>
                <div class="setting-control">${controlHtml}</div>
            </div>`;
    }

    /**
     * Helper to wrap a slider setting item.
     * @private
     */
    _sliderItem(nameKey, nameFallback, descKey, descFallback, sliderHtml, containerId = '', isVisible = true) {
        const idAttr = containerId ? ` id="${containerId}"` : '';
        const styleAttr = isVisible ? '' : ' style="display: none"';
        const nameText = i18n.t(nameKey) || nameFallback;
        const descText = i18n.t(descKey) || descFallback;

        return `
            <div class="setting-item"${idAttr}${styleAttr}>
                <div class="setting-label">
                    <span class="setting-name" data-i18n="${nameKey}">${nameText}</span>
                    <span class="setting-description" data-i18n="${descKey}">${descText}</span>
                </div>
                <div class="setting-control slider-control">${sliderHtml}</div>
            </div>`;
    }

    /**
     * Helper to render an accessible toggle switch button.
     * @private
     */
    _toggle(id, active, dataSetting) {
        return `<button class="toggle-switch ${active ? 'active' : ''}" id="${id}" data-setting="${dataSetting}" tabindex="0"></button>`;
    }

    /**
     * Registers an event listener and tracks it for deterministic teardown.
     * @private
     */
    _addListener(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this._listeners.push({ element, event, handler });
    }

    /**
     * Generates HTML markup for the Subtitles tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        // Collect preferred language options with 'None' fallback
        const prefLangs = [{ value: 'none', label: i18n.t('None') }, ...(this.page?.prefLanguages || [])];
        const savedSubtitleLang = storage.getItem('pref:subtitleLang') || 'none';

        // Dynamic visibility flags based on active PlayerSettings
        const isLibassWasm = PlayerSettings.get('assRenderer') === 'libass-wasm';
        const isCustomSize = PlayerSettings.get('subtitleSize') === 'custom';
        const dropShadowVal = PlayerSettings.get('subtitleDropShadow');
        const showBorderControls = dropShadowVal === 'border' || dropShadowVal === 'uniform_border';
        const showShadowOpacity = Boolean(dropShadowVal && dropShadowVal !== 'none' && dropShadowVal !== 'border');
        const enableAssMods = PlayerSettings.get('enableAssStyleModifications') === true;
        const overrideAssFonts = PlayerSettings.get('subtitleOverrideAssFonts') === true;
        const overrideOutlineShadow = PlayerSettings.get('subtitleOverrideAssOutlineShadow') !== false;

        // Subtitle color palette options
        const colorOptions = [
            { value: '#ffffff', label: i18n.t('SubtitleWhite') }, { value: '#d3d3d3', label: i18n.t('LightGrey') },
            { value: '#a9a9a9', label: i18n.t('DarkGrey') }, { value: '#000000', label: i18n.t('SubtitleBlack') },
            { value: '#ffff00', label: i18n.t('SubtitleYellow') }, { value: '#00ffff', label: i18n.t('SubtitleCyan') },
            { value: '#0000ff', label: i18n.t('SubtitleBlue') }
        ];

        // Shared font list generator
        const defaultFontLabel = i18n.t(platformInfo.isWebOS ? 'DefaultWebOSSans' : 'DefaultTizenSans');
        const standardFontOptions = [
            { value: '', label: defaultFontLabel }, { value: 'fallback-font', label: i18n.t('JellyfinFallbackFont') || 'Jellyfin Fallback Font' },
            { value: 'poppins', label: i18n.t('FontPoppins') || 'Poppins' }, { value: 'roboto', label: i18n.t('FontRoboto') || 'Roboto' },
            { value: 'google', label: i18n.t('FontGoogleSans') || 'Google Sans' }, { value: 'inter', label: i18n.t('FontInter') || 'Inter' },
            { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' }, { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
            { value: 'typewriter', label: i18n.t('Typewriter') }, { value: 'print', label: i18n.t('Print') },
            { value: 'console', label: i18n.t('Console') }, { value: 'cursive', label: i18n.t('Cursive') },
            { value: 'casual', label: i18n.t('Casual') }, { value: 'smallcaps', label: i18n.t('SmallCaps') },
            { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' }, { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' },
            { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' }, { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' },
            { value: 'baloo', label: i18n.t('FontBaloo') || 'Baloo Bhaijaan 2' }, { value: 'poiret-one', label: i18n.t('FontPoiretOne') || 'Poiret One' },
            { value: 'zen-kaku-gothic-new', label: i18n.t('FontZenKakuGothicNew') || 'Zen Kaku Gothic New' }, { value: 'opendyslexic', label: i18n.t('FontOpenDyslexic') || 'OpenDyslexic' },
            { value: 'atkinson', label: i18n.t('FontAtkinson') || 'Atkinson Hyperlegible' }, { value: 'manrope', label: i18n.t('FontManrope') || 'Manrope' }
        ];

        const assFontOptions = [
            { value: '', label: defaultFontLabel }, { value: 'poppins', label: i18n.t('ModernPoppins') },
            { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') }, { value: 'typewriter', label: i18n.t('Typewriter') },
            { value: 'print', label: i18n.t('Print') }, { value: 'console', label: i18n.t('Console') },
            { value: 'cursive', label: i18n.t('Cursive') }, { value: 'casual', label: i18n.t('Casual') },
            { value: 'smallcaps', label: i18n.t('SmallCaps') }, { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' },
            { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' }, { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' },
            { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' }, { value: 'inter', label: i18n.t('FontInter') || 'Inter' },
            { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' }, { value: 'baloo', label: i18n.t('FontBaloo') || 'Baloo Bhaijaan 2' },
            { value: 'poiret-one', label: i18n.t('FontPoiretOne') || 'Poiret One' }, { value: 'zen-kaku-gothic-new', label: i18n.t('FontZenKakuGothicNew') || 'Zen Kaku Gothic New' },
            { value: 'opendyslexic', label: i18n.t('FontOpenDyslexic') || 'OpenDyslexic' }, { value: 'atkinson', label: i18n.t('FontAtkinson') || 'Atkinson Hyperlegible' },
            { value: 'manrope', label: i18n.t('FontManrope') || 'Manrope' }, { value: 'fallback-font', label: i18n.t('JellyfinFallbackFont') || 'Jellyfin Fallback Font' }
        ];

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Subtitles">${i18n.t('Subtitles')}</h2>
                <p class="content-subtitle" data-i18n="SubtitlesTabDescription">
                    ${i18n.t('SubtitlesTabDescription') || 'Customize subtitle styling, text appearance, font sizes, colors, and ASS rendering.'}
                </p>

                <!-- Section 1: Playback & Delivery Preferences -->
                ${this._item('LabelPreferredSubtitleLanguage', 'Preferred Subtitle Language', 'PreferredSubtitleLanguageDescription', 'Language to auto-select.', this._drop('subtitle-lang-select', prefLangs, savedSubtitleLang))}
                ${this._item('LabelSubtitlePlaybackMode', 'Subtitle Playback Mode', 'SubtitleModeDescription', 'When to display subtitles.', this._drop('subtitle-mode-select', [
                    { value: 'Default', label: i18n.t('DefaultServerPreference') }, { value: 'Smart', label: i18n.t('SmartForeignAudioOnly') },
                    { value: 'OnlyForced', label: i18n.t('OnlyForced') }, { value: 'Always', label: i18n.t('Always') }, { value: 'None', label: i18n.t('None') }
                ], PlayerSettings.get('subtitleMode')))}
                ${this._item('SubtitleDelivery', 'Subtitle Delivery', 'SubtitleDeliveryDescription', 'Client vs Server burn-in.', this._drop('subtitle-burn-in-select', [
                    { value: '', label: i18n.t('ClientRendersRecommended') }, { value: 'allcomplex', label: i18n.t('AutoComplexFormatsOnly') }, { value: 'all', label: i18n.t('AlwaysBurnIn') }
                ], PlayerSettings.get('subtitleBurnIn') || ''))}
                ${this._item('LabelRememberTracksForSession', 'Remember Tracks for Session', 'RememberTracksForSessionDescription', 'Automatically carry active audio and subtitle tracks.', this._toggle('subtitle-remember-tracks-toggle', PlayerSettings.get('rememberTracksForSession') !== false, 'rememberTracksForSession'))}
                ${this._item('PreferExternalSubtitles', 'Prefer External Subtitles', 'PreferExternalSubtitlesDescription', 'Prefer external subtitle tracks over embedded ones.', this._toggle('subtitle-prefer-external-toggle', PlayerSettings.get('preferExternalSubtitles'), 'preferExternalSubtitles'))}
                ${this._item('DisableAssRendering', 'Disable ASS Styling', 'DisableAssRenderingDescription', 'Force plain text mode.', this._toggle('subtitle-force-text-toggle', PlayerSettings.get('disableAssStyling'), 'disableAssStyling'))}
                ${this._item('AssRenderer', 'ASS Subtitle Renderer', 'AssRendererDescription', 'Renderer engine.', this._drop('ass-renderer-select', [
                    { value: 'libass-wasm', label: platformInfo.hasWasmSupport ? 'libass-wasm (WebGL/WASM, Recommended)' : 'libass-wasm (WebGL/WASM, Unsupported)' },
                    { value: 'libjass', label: platformInfo.hasWasmSupport ? 'libjass (DOM, Older TV Compatible)' : 'libjass (DOM, Recommended / Older TV)' },
                    { value: 'assjs', label: 'ass.js (Lightweight DOM, Experimental)' }
                ], PlayerSettings.get('assRenderer')))}
                ${this._item('AssDropAnimations', 'Drop ASS Animations', 'AssDropAnimationsDescription', 'Skip animations on slow TVs.', this._toggle('toggle-subtitle-ass-drop-animations', PlayerSettings.get('subtitleAssDropAnimations'), 'subtitleAssDropAnimations'), 'ass-drop-animations-container', isLibassWasm)}
                ${this._item('AssPrescaleFactor', 'Subtitle Canvas Scale', 'AssPrescaleFactorDescription', 'Scale ASS canvas buffer.', this._drop('ass-prescale-factor-select', [
                    { value: 0.5, label: '0.5x (fastest)' }, { value: 0.6, label: '0.6x' }, { value: 0.7, label: '0.7x' },
                    { value: 0.8, label: '0.8x (recommended)' }, { value: 0.9, label: '0.9x' }, { value: 1.0, label: '1.0x (highest quality)' }
                ], PlayerSettings.get('subtitleAssPrescaleFactor')), 'ass-prescale-factor-container', isLibassWasm)}
                ${this._item('LabelPgsPlaybackMode', 'PGS Subtitle Engine', 'PgsPlaybackModeDescription', 'Graphic subtitles.', this._drop('pgs-playback-mode-select', [
                    { value: 'client', label: i18n.t('PgsModeClient') || 'Client Rendering (Web Worker, Smooth TV UI)' },
                    { value: 'burn', label: i18n.t('PgsModeBurn') || 'Transcode (Force Server Burn-In)' },
                    { value: 'disable', label: i18n.t('PgsModeDisable') || 'Disable and Hide Completely' }
                ], PlayerSettings.get('pgsPlaybackMode')))}

                <!-- Section 2: Subtitle Appearance -->
                <h3 class="setting-section-title" data-i18n="HeaderSubtitleAppearance">${i18n.t('HeaderSubtitleAppearance')}</h3>
                ${this._item('AppFont', 'Subtitle Font', 'AppFontDescription', 'Font family.', this._drop('subtitle-font-select', standardFontOptions, PlayerSettings.get('subtitleFont')))}
                ${this._item('LabelTextSize', 'Text Size', 'TextSizeDescription', 'Subtitle size preset.', this._drop('subtitle-size-select', [
                    { value: 'small', label: i18n.t('Small') }, { value: 'medium', label: i18n.t('Medium') },
                    { value: 'mediumlarge', label: i18n.t('MediumLarge') }, { value: 'large', label: i18n.t('Large') },
                    { value: 'larger', label: i18n.t('Larger') }, { value: 'extralarge', label: i18n.t('ExtraLarge') },
                    { value: 'custom', label: i18n.t('Custom') }
                ], PlayerSettings.get('subtitleSize')))}
                ${this._sliderItem('CustomSize', 'Custom Size', 'CustomSizeDescription', 'Custom height in vh.', this._slider('subtitle-custom-size', PlayerSettings.get('subtitleSizeCustomValue'), 1, 20, 0.1, 'vh'), 'subtitle-custom-size-container', isCustomSize)}
                ${this._item('LabelSubtitleVerticalPosition', 'Vertical Position', 'VerticalPositionDescription', 'Screen position.', this._drop('subtitle-position-select', [
                    { value: '-1', label: i18n.t('BottomLow') }, { value: '-2', label: i18n.t('BottomStandard') },
                    { value: '-5', label: i18n.t('BottomHigh') }, { value: '0', label: i18n.t('Top') },
                    { value: '2', label: i18n.t('TopLow') }, { value: 'custom', label: i18n.t('CustomAbsolute') }
                ], String(PlayerSettings.get('subtitleVerticalPosition'))))}
                ${this._sliderItem('AbsolutePosition', 'Absolute Position', 'AbsolutePositionDescription', 'Position from bottom.', this._slider('subtitle-custom-pos', PlayerSettings.get('subtitleVerticalPositionCustom'), 0, 100, 1), 'subtitle-custom-pos-container')}
                ${this._item('LabelSubtitleOsdDodging', 'Subtitle OSD Dodging', 'SubtitleOsdDodgingDescription', 'Shift subtitles above OSD controls.', this._toggle('subtitle-osd-dodging-toggle', PlayerSettings.get('subtitleOsdDodging') !== false, 'subtitleOsdDodging'))}
                ${this._item('LabelTextWeight', 'Font Weight', 'FontWeightDescription', 'Weight of font.', this._drop('subtitle-weight-select', [{ value: 'normal', label: i18n.t('Normal') }, { value: 'bold', label: i18n.t('Bold') }], PlayerSettings.get('subtitleWeight') || 'normal'))}
                ${this._item('LabelTextColorSdr', 'SDR Text Color', 'TextColorSdrDescription', 'Color for standard dynamic range.', this._drop('subtitle-color-select', colorOptions, PlayerSettings.get('subtitleTextColor') || '#ffffff'))}
                ${this._item('LabelTextColorHdr', 'HDR Text Color', 'TextColorHdrDescription', 'Color for high dynamic range.', this._drop('subtitle-color-select-hdr', colorOptions, PlayerSettings.get('subtitleTextColorHdr') || '#ffffff'))}
                ${this._item('SubtitleOverrideColors', 'Override Colors', 'SubtitleOverrideColorsDesc', 'Override embedded subtitle colors.', this._toggle('subtitle-override-colors-toggle', PlayerSettings.get('subtitleOverrideColors'), 'subtitleOverrideColors'))}
                ${this._sliderItem('TextOpacitySdr', 'SDR Text Opacity', 'TextOpacitySdrDescription', 'Opacity for SDR.', this._slider('subtitle-text-opacity', PlayerSettings.get('subtitleTextOpacity'), 0, 100, 5))}
                ${this._sliderItem('TextOpacityHdr', 'HDR Text Opacity', 'TextOpacityHdrDescription', 'Opacity for HDR.', this._slider('subtitle-text-opacity-hdr', PlayerSettings.get('subtitleTextOpacityHdr'), 0, 100, 5))}
                ${this._sliderItem('PgsOpacitySdr', 'PGS SDR Opacity', 'PgsOpacitySdrDescription', 'PGS opacity for SDR.', this._slider('subtitle-pgs-opacity', PlayerSettings.get('subtitlePgsOpacity') ?? 100, 0, 100, 5))}
                ${this._sliderItem('PgsOpacityHdr', 'PGS HDR Opacity', 'PgsOpacityHdrDescription', 'PGS opacity for HDR.', this._slider('subtitle-pgs-opacity-hdr', PlayerSettings.get('subtitlePgsOpacityHdr') ?? 70, 0, 100, 5))}
                ${this._item('BackgroundColor', 'Background Color', 'BackgroundColorDescription', 'Box backdrop color.', this._drop('subtitle-bg-select', [{ value: 'transparent', label: i18n.t('None') }, ...colorOptions], PlayerSettings.get('subtitleTextBackground')))}
                ${this._sliderItem('BackgroundOpacity', 'Background Opacity', 'BackgroundOpacityDescription', 'Backdrop opacity.', this._slider('subtitle-bg-opacity', PlayerSettings.get('subtitleBackgroundOpacity'), 0, 100, 5), 'subtitle-bg-opacity-container')}
                ${this._item('TextShadowStyle', 'Shadow Style', 'TextShadowStyleDescription', 'Edge styling.', this._drop('subtitle-shadow-select', [
                    { value: 'none', label: i18n.t('None') }, { value: 'uniform', label: i18n.t('Uniform') },
                    { value: 'border', label: i18n.t('Border') }, { value: 'uniform_border', label: i18n.t('UniformBorders') || 'Uniform + borders' },
                    { value: 'dropshadow', label: i18n.t('DropShadow') }, { value: 'raised', label: i18n.t('Raised') },
                    { value: 'depressed', label: i18n.t('Depressed') }
                ], PlayerSettings.get('subtitleDropShadow')))}
                ${this._sliderItem('BorderWidth', 'Border Width', 'BorderWidthDescription', 'Border thickness.', this._slider('subtitle-border-width', PlayerSettings.get('subtitleBorderWidth'), 1, 20, 1), 'subtitle-border-width-container', showBorderControls)}
                ${this._sliderItem('BorderOpacity', 'Border Opacity', 'BorderOpacityDescription', 'Border opacity.', this._slider('subtitle-border-opacity', PlayerSettings.get('subtitleBorderOpacity') ?? 100, 0, 100, 5), 'subtitle-border-opacity-container', showBorderControls)}
                ${this._item('ShadowColor', 'Shadow Color', 'ShadowColorDescription', 'Drop shadow tint.', this._drop('subtitle-shadow-color-select', [
                    ...colorOptions, { value: '#ff0000', label: i18n.t('SubtitleRed') },
                    { value: '#00ff00', label: i18n.t('SubtitleGreen') }, { value: '#ff00ff', label: i18n.t('SubtitleMagenta') },
                    { value: '#808080', label: i18n.t('Grey') }
                ], PlayerSettings.get('subtitleDropShadowColor') || '#000000'))}
                ${this._sliderItem('ShadowOpacity', 'Shadow Opacity', 'ShadowOpacityDescription', 'Shadow opacity.', this._slider('subtitle-shadow-opacity', PlayerSettings.get('subtitleDropShadowOpacity') ?? 100, 0, 100, 5), 'subtitle-shadow-opacity-container', showShadowOpacity)}

                <!-- Section 3: Advanced ASS Settings -->
                <h3 class="setting-section-title" data-i18n="AdvancedAssSettings">${i18n.t('AdvancedAssSettings')}</h3>
                ${this._item('EnableAssStyleModifications', 'Enable ASS Style Overrides', 'EnableAssStyleModificationsDescription', 'Allow overriding embedded ASS styles.', this._toggle('toggle-enable-ass-style-mods', enableAssMods, 'enableAssStyleModifications'))}

                <div id="ass-style-mods-subsettings" style="display: ${enableAssMods ? '' : 'none'}">
                    ${this._item('OverrideAssFonts', 'Override ASS Fonts', 'OverrideAssFontsDescription', 'Override font family.', this._toggle('toggle-subtitle-override-ass-fonts', overrideAssFonts, 'subtitleOverrideAssFonts'))}
                    ${this._item('AssFontFamily', 'ASS Font Family', 'FontFamilyAssDescription', 'Font override for ASS.', this._drop('subtitle-font-ass-select', assFontOptions, PlayerSettings.get('subtitleFontAss')), 'subtitle-font-ass-container', overrideAssFonts)}
                    ${this._sliderItem('FontScaleAss', 'Font Scale', 'FontScaleAssDescription', 'Scale ASS text.', this._slider('subtitle-font-scale', PlayerSettings.get('subtitleFontScale') ?? 1, 0.5, 3, 0.1, 'x'))}
                    ${this._sliderItem('VerticalPositionAss', 'Vertical Offset', 'VerticalPositionAssDescription', 'Offset from bottom.', this._slider('subtitle-bottom-offset', PlayerSettings.get('subtitleBottomOffset') ?? 0, -100, 750, 5, 'px'))}
                    ${this._item('OverrideOutlineShadow', 'Override Outline & Shadow', 'OverrideOutlineShadowDescription', 'Enable custom outline/shadow.', this._toggle('subtitle-override-ass-toggle', overrideOutlineShadow, 'subtitleOverrideAssOutlineShadow'))}
                    ${this._sliderItem('OutlineThicknessAss', 'Outline Thickness', 'OutlineThicknessAssDescription', 'Outline thickness in px.', this._slider('subtitle-outline-thickness', PlayerSettings.get('subtitleOutlineThickness') ?? 0.4, 0, 5, 0.1, ''), 'subtitle-outline-thickness-container', overrideOutlineShadow)}
                    ${this._sliderItem('ShadowThicknessAss', 'Shadow Thickness', 'ShadowThicknessAssDescription', 'Shadow thickness in px.', this._slider('subtitle-shadow-thickness', PlayerSettings.get('subtitleShadowThickness') ?? 0.3, 0, 5, 0.1, ''), 'subtitle-shadow-thickness-container', overrideOutlineShadow)}
                    ${this._sliderItem('VerticalSpacingAss', 'Line Height', 'VerticalSpacingAssDescription', 'Line height in px.', this._slider('subtitle-line-height', PlayerSettings.get('subtitleLineHeight') ?? 0, -50, 50, 1, 'px'))}
                    ${this._sliderItem('HorizontalSpacingAss', 'Letter Spacing', 'HorizontalSpacingAssDescription', 'Letter spacing in px.', this._slider('subtitle-letter-spacing', PlayerSettings.get('subtitleLetterSpacing') ?? 0, -20, 40, 0.5, 'px'))}
                </div>
            </div>`;
    }

    /**
     * Binds toggle and interactive event listeners for the Subtitles tab.
     * @param {HTMLElement} root Root settings container element
     */
    mount(root) {
        const container = root || this.page?.el || this.page?.element || document;
        if (!container) return;
        this.destroy();
        const $ = (selector) => container.querySelector(selector);

        // Subtitle OSD Dodging Toggle (Smart Shift)
        const osdDodgingBtn = $('#subtitle-osd-dodging-toggle');
        this._addListener(osdDodgingBtn, 'click', () => {
            const next = !(PlayerSettings.get('subtitleOsdDodging') !== false);
            PlayerSettings.set('subtitleOsdDodging', next);
            osdDodgingBtn?.classList.toggle('active', next);
        });

        // Remember Tracks for Session Toggle
        const rememberTracksBtn = $('#subtitle-remember-tracks-toggle');
        this._addListener(rememberTracksBtn, 'click', () => {
            const next = !(PlayerSettings.get('rememberTracksForSession') !== false);
            PlayerSettings.set('rememberTracksForSession', next);
            rememberTracksBtn?.classList.toggle('active', next);
            log.info(`Remember Tracks For Session set to: ${next}`);
        });

        // Prefer External Subtitles Toggle
        const preferExternalBtn = $('#subtitle-prefer-external-toggle');
        this._addListener(preferExternalBtn, 'click', () => {
            const next = !PlayerSettings.get('preferExternalSubtitles');
            PlayerSettings.set('preferExternalSubtitles', next);
            preferExternalBtn?.classList.toggle('active', next);
            log.info(`Prefer External Subtitles set to: ${next}`);
        });

        // Force Text Subtitles Toggle
        const forceTextBtn = $('#subtitle-force-text-toggle');
        this._addListener(forceTextBtn, 'click', () => {
            const next = !PlayerSettings.get('disableAssStyling');
            PlayerSettings.set('disableAssStyling', next);
            forceTextBtn?.classList.toggle('active', next);
            log.info(`Force Text Mode set to: ${next}`);
        });

        // Override Subtitle Colors Toggle
        const overrideColorsBtn = $('#subtitle-override-colors-toggle');
        this._addListener(overrideColorsBtn, 'click', () => {
            const next = !(PlayerSettings.get('subtitleOverrideColors') === true);
            PlayerSettings.set('subtitleOverrideColors', next);
            overrideColorsBtn?.classList.toggle('active', next);
            log.info(`Override Subtitle Colors set to: ${next}`);
        });

        // Drop ASS Animations Toggle
        const assDropAnimBtn = $('#toggle-subtitle-ass-drop-animations');
        this._addListener(assDropAnimBtn, 'click', () => {
            const next = !(PlayerSettings.get('subtitleAssDropAnimations') === true);
            PlayerSettings.set('subtitleAssDropAnimations', next);
            assDropAnimBtn?.classList.toggle('active', next);
        });

        // Master Switch: Enable ASS Style Modifications
        const assStyleModsBtn = $('#toggle-enable-ass-style-mods');
        this._addListener(assStyleModsBtn, 'click', () => {
            const next = !(PlayerSettings.get('enableAssStyleModifications') === true);
            PlayerSettings.set('enableAssStyleModifications', next);
            assStyleModsBtn?.classList.toggle('active', next);
            const subs = $('#ass-style-mods-subsettings');
            if (subs) subs.style.display = next ? '' : 'none';
            focusManager.invalidateCache();
        });

        // Override ASS Fonts Toggle
        const assFontOverrideBtn = $('#toggle-subtitle-override-ass-fonts');
        this._addListener(assFontOverrideBtn, 'click', () => {
            const next = !(PlayerSettings.get('subtitleOverrideAssFonts') === true);
            PlayerSettings.set('subtitleOverrideAssFonts', next);
            assFontOverrideBtn?.classList.toggle('active', next);
            const fontBox = $('#subtitle-font-ass-container');
            if (fontBox) fontBox.style.display = next ? '' : 'none';
            focusManager.invalidateCache();
        });

        // Override ASS Outline and Shadow Toggle
        const assOverrideBtn = $('#subtitle-override-ass-toggle');
        this._addListener(assOverrideBtn, 'click', () => {
            const next = !(PlayerSettings.get('subtitleOverrideAssOutlineShadow') !== false);
            PlayerSettings.set('subtitleOverrideAssOutlineShadow', next);
            assOverrideBtn?.classList.toggle('active', next);
            const outlineBox = $('#subtitle-outline-thickness-container');
            const shadowBox = $('#subtitle-shadow-thickness-container');
            if (outlineBox) outlineBox.style.display = next ? '' : 'none';
            if (shadowBox) shadowBox.style.display = next ? '' : 'none';
            focusManager.invalidateCache();
        });
    }

    /**
     * Cleans up all attached event listeners to avoid memory leaks.
     */
    destroy() {
        // Detach all tracked event handlers safely
        for (const { element, event, handler } of this._listeners) {
            try {
                element.removeEventListener(event, handler);
            } catch (err) {
                log.warn('Failed to remove listener', err);
            }
        }
        this._listeners = [];
    }
}

export default SubtitlesTab;
