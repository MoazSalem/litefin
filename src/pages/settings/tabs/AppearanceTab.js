/**
 * ============================================================================
 * Litefin Tizen - Appearance Tab Controller
 * ============================================================================
 * Handles UI display preferences, themes, accent colors, icons, interface scaling,
 * typography, screensaver modes, player OSD customizations, and WOL settings:
 * 1. Display Scaling, Languages, Font Selections, and Icon Styling
 * 2. Visual Theme Modes, Accent Palettes, Button Shapes, and Focus Borders
 * 3. Player OSD Typography, Track Menu Opacity, and Control Aesthetics
 * 4. Screensaver Rules, Dimming Levels, and System Wake-on-LAN Triggers
 * ============================================================================
 */

import { i18n } from '../../../utils/i18n.js';
import { storage } from '../../../utils/StorageService.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { languageManager } from '../../../utils/LanguageManager.js';
import { platformInfo } from '../../../utils/PlatformInfo.js';
import { androidAdapter } from '../../../android/AndroidAdapter.js';
import { webosAdapter } from '../../../webos/WebOSAdapter.js';
import { imageService } from '../../../utils/ImageService.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { getSupportedStyles } from '../../../utils/Icons.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { logger } from '../../../utils/Logger.js';
import { getThemeColors } from '../modals/ThemeColorModal.js';

const log = logger.create('AppearanceTab');

/**
 * Controller managing display and theme appearance customizations.
 */
export class AppearanceTab {
    /**
     * Initializes a new instance of AppearanceTab.
     * @param {Object} page Host SettingsPage controller
     */
    constructor(page) {
        this.page = page;
        this._listeners = [];
    }

    /**
     * Helper to render standardized setting item container.
     * @private
     */
    _item(title, desc, controlHtml, opt = {}) {
        const idStr = opt.id ? ` id="${opt.id}"` : '';
        const styleStr = opt.style ? ` style="${opt.style}"` : '';
        const clsStr = opt.cls ? ` ${opt.cls}` : '';
        return `
            <div class="setting-item${clsStr}"${idStr}${styleStr}>
                <div class="setting-label">
                    <span class="setting-name">${title}</span>
                    <span class="setting-description">${desc}</span>
                </div>
                <div class="setting-control">${controlHtml}</div>
            </div>`;
    }

    /**
     * Helper to render dropdown controls via host page.
     * @private
     */
    _drop(id, options, currentVal, disabled = false) {
        return this.page ? this.page._renderDropdown(id, options, currentVal, disabled) : '';
    }

    /**
     * Helper to render slider controls via host page.
     * @private
     */
    _slider(id, currentVal, min, max, step) {
        return this.page ? this.page._renderSlider(id, currentVal, min, max, step) : '';
    }

    /**
     * Helper to render a storage-backed toggle switch button.
     * @private
     */
    _toggle(id, storageKey, defVal = false, extraAttrs = '') {
        const currentVal = storage.getItem(storageKey);
        const active = currentVal === null ? defVal : currentVal === 'true';
        return `<button class="toggle-switch ${active ? 'active' : ''}" id="${id}" data-storage="${storageKey}" data-default="${defVal}" tabindex="0" ${extraAttrs}></button>`;
    }

    /**
     * Helper to render a PlayerSettings-backed toggle switch button.
     * @private
     */
    _playerToggle(id, settingKey, defVal = false) {
        const val = PlayerSettings.get(settingKey);
        const active = val !== undefined ? Boolean(val) : defVal;
        return `<button class="toggle-switch ${active ? 'active' : ''}" id="${id}" data-setting="${settingKey}" tabindex="0"></button>`;
    }

    /**
     * Attaches an event listener tracked for automatic lifecycle cleanup.
     * @private
     */
    _listen(el, event, handler) {
        if (!el) return;
        el.addEventListener(event, handler);
        this._listeners.push({ element: el, event, handler });
    }

    /**
     * Compiles the complete serialized HTML markup for the Appearance / Display tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        // Resolve display languages and favorite language state
        const uiLanguages = this.page ? this.page.uiLanguages : [];
        const favLabel = languageManager.hasFavorites()
            ? i18n.t('LanguagesSelected', [languageManager.getFavorites().length])
            : i18n.t('AllLanguages') || 'All Languages';

        // Resolve current theme color swatch and label
        const currentColorHex = (layoutManager.getThemeColor() || '#00a4dc').toLowerCase();
        const colors = getThemeColors();
        const activeColor = colors.find((c) => c.hex.toLowerCase() === currentColorHex) || {
            name: 'Jellyfin Blue',
            hex: currentColorHex
        };

        // Resolve current loader style name
        const currentLoader = layoutManager.getLoaderStyle() || 'dots';
        const loaderNames = {
            dots: i18n.t('LoaderStyleDots') || 'Pulsing Dots',
            ring: i18n.t('LoaderStyleRing') || 'Rotating Ring',
            'dual-ring': i18n.t('LoaderStyleDualRing') || 'Dual Ring',
            orbit: i18n.t('LoaderStyleOrbit') || 'Orbital Bead',
            satellite: i18n.t('LoaderStyleSatellite') || 'Satellite Ring',
            'triple-ring': i18n.t('LoaderStyleTripleRing') || 'Triple Gyro',
            'dotted-ring': i18n.t('LoaderStyleDottedRing') || 'Dotted Eclipse',
            'eclipse-sweep': i18n.t('LoaderStyleEclipseSweep') || 'Crescent Sweep',
            'sonar-ring': i18n.t('LoaderStyleSonarRing') || 'Sonar Aperture',
            'push-pulse': i18n.t('LoaderStylePushPulse') || 'Push Pulse',
            'horizontal-dots': i18n.t('LoaderStyleHorizontalDots') || 'Fading Trio',
            'pulsing-grid': i18n.t('LoaderStylePulsingGrid') || 'Morphing Grid'
        };
        const activeLoaderName = loaderNames[currentLoader] || 'Pulsing Dots';

        // Resolve icon variant options based on active icon set capabilities
        const supports = getSupportedStyles();
        let iconVariantOptions = [{ value: 'dynamic', label: 'Dynamic (Outlined/Filled)' }, { value: 'outlined', label: 'Always Outlined' }, { value: 'filled', label: 'Always Filled' }];
        if (supports === 'filled') iconVariantOptions = [{ value: 'filled', label: 'Always Filled' }];
        else if (supports === 'outlined') iconVariantOptions = [{ value: 'outlined', label: 'Always Outlined' }];
        const activeIconVariant = supports === 'both' ? storage.getItem('pref:iconVariant') || 'dynamic' : supports;

        // Current theme mode and screensaver type states
        const themeMode = layoutManager.getThemeMode();
        const ssType = storage.getItem('pref:screensaverType') || 'backdrop';
        const isWebOS = platformInfo.isWebOS || webosAdapter.isWebOS;
        const wolActive = storage.getItem('pref:enableWolOnStartup') === 'true' || storage.getItem('pref:enableWolOnTimeout') === 'true' || storage.getItem('pref:enableWolOnServerScan') === 'true' || storage.getItem('pref:enableWolExtendedWait') === 'true';

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Display">${i18n.t('Display')}</h2>
                <p class="content-subtitle" data-i18n="DisplayTabDescription">${i18n.t('DisplayTabDescription') || 'Customize themes, accent colors, icons, interface scaling, and display behavior.'}</p>

                ${this._item(
                    i18n.t('LabelPreferredDisplayLanguage'),
                    i18n.t('AppLanguageDescription'),
                    this._drop('app-language-select', uiLanguages, storage.getItem('app_language') || 'en-us')
                )}

                ${this._item(
                    i18n.t('FavoriteLanguages') || 'Favorite Languages',
                    i18n.t('FavoriteLanguagesDescription') || 'Limit language dropdowns and media tracks across the app to your favorite languages.',
                    `<button class="setting-action-btn select-btn" id="btn-manage-favorite-languages" tabindex="0" data-focusable="true"><span class="btn-label" id="favorite-languages-count-label">${favLabel}</span></button>`
                )}

                ${this._item(
                    i18n.t('DisplayScale') || 'Display Scale',
                    i18n.t('DisplayScaleDescription') || 'Adjust overall interface scaling. "Auto" dynamically fits the layout to 1080p canvas proportions.',
                    this._drop('display-scale-select', [{ value: 'auto', label: i18n.t('DisplayScaleAuto') || 'Auto (Fit 1080p)' }, { value: '0.67', label: '67%' }, { value: '0.75', label: '75%' }, { value: '0.8', label: '80%' }, { value: '0.85', label: '85%' }, { value: '0.9', label: '90%' }, { value: '0.95', label: '95%' }, { value: '1', label: '100% (Native / TV)' }, { value: '1.05', label: '105%' }, { value: '1.1', label: '110%' }, { value: '1.15', label: '115%' }, { value: '1.2', label: '120%' }], layoutManager.getDisplayScale().toString())
                )}

                ${platformInfo.isAndroid ? this._item(
                    i18n.t('MobileFullscreen') || 'Fullscreen Mode',
                    i18n.t('MobileFullscreenDescription') || 'Hide status and navigation bars on mobile devices for an edge-to-edge layout.',
                    `<button class="toggle-switch ${androidAdapter.isMobileFullscreenEnabled() ? 'active' : ''}" id="toggle-mobile-fullscreen" tabindex="0" aria-label="${i18n.t('MobileFullscreen') || 'Fullscreen Mode'}"></button>`,
                    { id: 'mobile-fullscreen-setting-item' }
                ) : ''}

                ${this._item(
                    i18n.t('TextScale') || 'Text scale',
                    i18n.t('TextScaleDescription') || 'Adjust the size of all text and UI elements proportionally',
                    this._drop('text-scale-select', [{ value: '0.8', label: '80%' }, { value: '0.85', label: '85%' }, { value: '0.9', label: '90%' }, { value: '0.95', label: '95%' }, { value: '1', label: 'Normal (100%)' }, { value: '1.05', label: '105%' }, { value: '1.1', label: '110%' }, { value: '1.15', label: '115%' }, { value: '1.2', label: '120%' }, { value: '1.25', label: '125%' }, { value: '1.3', label: '130%' }, { value: '1.35', label: '135%' }, { value: '1.4', label: '140%' }], layoutManager.getTextScale().toString())
                )}

                ${this._item(
                    i18n.t('LayoutDirection'),
                    i18n.t('LayoutDirectionDescription'),
                    this._drop('layout-direction-select', [{ value: 'auto', label: i18n.t('DirectionAuto', ['Auto']) }, { value: 'ltr', label: i18n.t('DirectionLTR', ['Left-to-Right']) }, { value: 'rtl', label: i18n.t('DirectionRTL', ['Right-to-Left']) }], storage.getItem('layout_direction') || 'auto')
                )}

                ${this._item(
                    i18n.t('AppFont'),
                    i18n.t('AppFontDescription'),
                    this._drop('ui-font-select', [{ value: 'poppins', label: i18n.t('ModernPoppins') }, { value: 'system', label: i18n.t(platformInfo.isWebOS ? 'DefaultWebOSSans' : 'DefaultTizenSans') }, { value: 'fallback-font', label: i18n.t('JellyfinFallbackFont') || 'Jellyfin Fallback Font' }, { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') }, { value: 'roboto', label: i18n.t('FontRoboto') }, { value: 'google', label: i18n.t('FontGoogleSans') }, { value: 'typewriter', label: i18n.t('Typewriter') }, { value: 'print', label: i18n.t('Print') }, { value: 'console', label: i18n.t('Console') }, { value: 'cursive', label: i18n.t('Cursive') }, { value: 'casual', label: i18n.t('Casual') }, { value: 'smallcaps', label: i18n.t('SmallCaps') }, { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' }, { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' }, { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' }, { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' }, { value: 'inter', label: i18n.t('FontInter') || 'Inter' }, { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' }, { value: 'baloo', label: i18n.t('FontBaloo') || 'Baloo Bhaijaan 2' }, { value: 'poiret-one', label: i18n.t('FontPoiretOne') || 'Poiret One' }, { value: 'zen-kaku-gothic-new', label: i18n.t('FontZenKakuGothicNew') || 'Zen Kaku Gothic New' }, { value: 'opendyslexic', label: i18n.t('FontOpenDyslexic') || 'OpenDyslexic' }, { value: 'atkinson', label: i18n.t('FontAtkinson') || 'Atkinson Hyperlegible' }, { value: 'manrope', label: i18n.t('FontManrope') || 'Manrope' }], layoutManager.getUiFont())
                )}

                ${this._item(
                    i18n.t('JellyfinFallbackFontSelection') || 'Jellyfin Fallback Font File',
                    i18n.t('JellyfinFallbackFontSelectionDescription') || 'Select which font file on the server to use as the fallback font',
                    this._drop('jellyfin-fallback-font-select', [], storage.getItem('pref:jellyfinFallbackFont') || '')
                )}

                ${this._item('Icon Style', 'Choose a visual style theme for icons across the app.', this._drop('icon-style-select', [{ value: 'default', label: 'Default' }, { value: 'material3', label: 'Material 3' }], storage.getItem('pref:iconStyle') || 'default'))}
                ${this._item('Icon Variant Preference', 'Select whether icons should be outlined, filled, or change dynamically based on focus state.', this._drop('icon-variant-select', iconVariantOptions, activeIconVariant, false))}

                <h3 class="setting-section-title" data-i18n="ImageRelated">${i18n.t('ImageRelated')}</h3>
                ${this._item(i18n.t('ImageQuality'), i18n.t('ImageQualityDescription'), this._drop('image-quality-select', [{ value: 'low', label: i18n.t('Low') }, { value: 'medium-low', label: i18n.t('MediumLow') || 'Medium Low' }, { value: 'medium', label: i18n.t('Medium') }, { value: 'medium-high', label: i18n.t('MediumHigh') || 'Medium High' }, { value: 'high', label: i18n.t('High') }, { value: 'very-high', label: i18n.t('VeryHigh') || 'Very High' }, { value: 'ultra', label: i18n.t('Ultra') }, { value: 'original', label: i18n.t('Original') }], imageService.getPreset() || 'medium'))}
                ${this._item(i18n.t('DetailsImageQuality') || 'Details Image Quality', i18n.t('DetailsImageQualityDescription') || 'Set the image quality specifically for the item details page.', this._drop('details-image-quality-select', [{ value: 'default', label: i18n.t('Default') || 'Default' }, { value: 'low', label: i18n.t('Low') || 'Low' }, { value: 'medium-low', label: i18n.t('MediumLow') || 'Medium Low' }, { value: 'medium', label: i18n.t('Medium') || 'Medium' }, { value: 'medium-high', label: i18n.t('MediumHigh') || 'Medium High' }, { value: 'high', label: i18n.t('High') || 'High' }, { value: 'very-high', label: i18n.t('VeryHigh') || 'Very High' }, { value: 'ultra', label: i18n.t('Ultra') }, { value: 'original', label: i18n.t('Original') }], imageService.getDetailsPreset() || 'very-high'))}

                <h3 class="setting-section-title" data-i18n="Time">${i18n.t('Time') || 'Time'}</h3>
                ${this._item(i18n.t('LabelTimeFormat') || 'Time Format', i18n.t('TimeFormatDescription') || 'Choose how the clock and playback end times are displayed.', this._drop('time-format-select', [{ value: '12h', label: i18n.t('TimeFormat12h') || '12-hour' }, { value: '24h', label: i18n.t('TimeFormat24h') || '24-hour' }, { value: 'none', label: i18n.t('TimeFormatNone') || 'Hidden' }], PlayerSettings.get('timeFormat') || '12h'))}
                ${this._item(i18n.t('LabelTimeSource') || 'Time Source', i18n.t('TimeSourceDescription') || 'Choose where the clock gets the current time (Browser, Device OS, or Jellyfin Server).', this._drop('time-source-select', [{ value: 'browser', label: i18n.t('TimeSourceBrowser') || 'Browser' }, { value: 'os', label: i18n.t('TimeSourceOS') || 'Device OS' }, { value: 'server', label: i18n.t('TimeSourceServer') || 'Jellyfin Server' }], PlayerSettings.get('timeSource') || 'browser'))}
                ${this._item(i18n.t('LabelTimezone') || 'Timezone Offset', i18n.t('TimezoneDescription') || 'Select your local timezone offset when using Jellyfin Server time sync.', this._drop('time-timezone-select', [{ value: 'auto', label: i18n.t('TimezoneAuto') || 'Automatic (Device Timezone)' }, { value: '-720', label: 'UTC-12:00 (Baker Island)' }, { value: '-660', label: 'UTC-11:00 (Samoa, Niue)' }, { value: '-600', label: 'UTC-10:00 (Hawaii, Tahiti)' }, { value: '-570', label: 'UTC-09:30 (Marquesas Islands)' }, { value: '-540', label: 'UTC-09:00 (Alaska)' }, { value: '-480', label: 'UTC-08:00 (Pacific Time - US/Canada)' }, { value: '-420', label: 'UTC-07:00 (Mountain Time - US/Canada)' }, { value: '-360', label: 'UTC-06:00 (Central Time - US/Canada, Mexico)' }, { value: '-300', label: 'UTC-05:00 (Eastern Time - US/Canada, Bogota)' }, { value: '-240', label: 'UTC-04:00 (Atlantic Time, Santiago, Caracas)' }, { value: '-210', label: 'UTC-03:30 (Newfoundland)' }, { value: '-180', label: 'UTC-03:00 (Buenos Aires, Sao Paulo)' }, { value: '-120', label: 'UTC-02:00 (South Georgia, Mid-Atlantic)' }, { value: '-60', label: 'UTC-01:00 (Azores, Cape Verde)' }, { value: '0', label: 'UTC+00:00 (London, Dublin, Lisbon, Casablanca, UTC)' }, { value: '60', label: 'UTC+01:00 (Berlin, Paris, Rome, Madrid, Warsaw)' }, { value: '120', label: 'UTC+02:00 (Cairo, Athens, Jerusalem, Helsinki, Kyiv)' }, { value: '180', label: 'UTC+03:00 (Riyadh, Moscow, Istanbul, Nairobi, Baghdad)' }, { value: '210', label: 'UTC+03:30 (Tehran)' }, { value: '240', label: 'UTC+04:00 (Dubai, Baku, Tbilisi, Yerevan)' }, { value: '270', label: 'UTC+04:30 (Kabul)' }, { value: '300', label: 'UTC+05:00 (Karachi, Tashkent, Yekaterinburg)' }, { value: '330', label: 'UTC+05:30 (India Standard Time - New Delhi, Mumbai)' }, { value: '345', label: 'UTC+05:45 (Kathmandu)' }, { value: '360', label: 'UTC+06:00 (Dhaka, Almaty, Astana)' }, { value: '390', label: 'UTC+06:30 (Yangon, Cocos Islands)' }, { value: '420', label: 'UTC+07:00 (Bangkok, Jakarta, Hanoi)' }, { value: '480', label: 'UTC+08:00 (Singapore, Beijing, Hong Kong, Perth)' }, { value: '525', label: 'UTC+08:45 (Eucla)' }, { value: '540', label: 'UTC+09:00 (Tokyo, Seoul)' }, { value: '570', label: 'UTC+09:30 (Adelaide, Darwin)' }, { value: '600', label: 'UTC+10:00 (Sydney, Melbourne, Brisbane, Vladivostok)' }, { value: '630', label: 'UTC+10:30 (Lord Howe Island)' }, { value: '660', label: 'UTC+11:00 (Solomon Islands, Noumea)' }, { value: '720', label: 'UTC+12:00 (Auckland, Fiji, Kamchatka)' }, { value: '765', label: 'UTC+12:45 (Chatham Islands)' }, { value: '780', label: 'UTC+13:00 (Tonga, Samoa, Phoenix Islands)' }, { value: '840', label: 'UTC+14:00 (Line Islands, Kiritimati)' }], PlayerSettings.get('timeZoneOffset') || 'auto'), { id: 'time-timezone-item', style: (PlayerSettings.get('timeSource') || 'browser') === 'server' ? '' : 'display: none;' })}

                <h3 class="setting-section-title" data-i18n="Screensaver">${i18n.t('Screensaver') || 'Screensaver'}</h3>
                ${this._item(i18n.t('ScreensaverDelay') || 'Display time', i18n.t('ScreensaverDelayDescription') || 'When to display the screensaver while idle', this._drop('screensaver-delay-select', [{ value: 0, label: i18n.t('Never') || 'Never' }, { value: 60, label: i18n.t('1Minute') || '1 Minute' }, { value: 300, label: i18n.t('5Minutes') || '5 Minutes' }, { value: 600, label: i18n.t('10Minutes') || '10 Minutes' }, { value: 1800, label: i18n.t('30Minutes') || '30 Minutes' }], storage.getItem('pref:screensaverDelay') || 0))}
                ${this._item(i18n.t('ScreensaverType') || 'Screensaver style', i18n.t('ScreensaverTypeDescription') || 'Visual style of the screensaver', this._drop('screensaver-type-select', [{ value: 'backdrop', label: i18n.t('Backdrop') || 'Backdrop' }, { value: 'logo', label: i18n.t('Logo') || 'Logo' }, { value: 'black', label: i18n.t('ScreensaverBlack') || 'Black' }], ssType))}
                ${this._item(i18n.t('BackdropDimmer') || 'Backdrop dim level', i18n.t('BackdropDimmerDescription') || 'How dark the backdrop screensaver should be', this._drop('backdrop-dimmer-select', [{ value: '0', label: i18n.t('Off') || 'Off' }, { value: '0.1', label: '10%' }, { value: '0.2', label: '20%' }, { value: '0.3', label: '30%' }, { value: '0.4', label: '40%' }, { value: '0.5', label: '50%' }, { value: '0.6', label: '60%' }, { value: '0.7', label: '70%' }, { value: '0.8', label: '80%' }, { value: '0.9', label: '90%' }], storage.getItem('pref:backdropDimmer') || '0.3'), { id: 'screensaver-dim-item', cls: ssType !== 'backdrop' ? 'hidden' : '' })}
                ${this._item(i18n.t('BackdropHideText') || 'Hide title and catchphrase', i18n.t('BackdropHideTextDescription') || 'Do not show any text over the backdrop screensaver images', this._toggle('toggle-backdrop-hide-text', 'pref:backdropHideText', false), { id: 'screensaver-hide-text-item', cls: ssType !== 'backdrop' ? 'hidden' : '' })}
                ${this._item(i18n.t('BackdropIncludeMusic') || 'Include music library', i18n.t('BackdropIncludeMusicDescription') || 'Show backdrops from music artists in the screensaver', this._toggle('toggle-backdrop-include-music', 'pref:backdropIncludeMusic', false), { id: 'screensaver-include-music-item', cls: ssType !== 'backdrop' ? 'hidden' : '' })}
                ${isWebOS ? this._item(i18n.t('PreventScreensaverOnPlayback') || 'Prevent screensaver during playback', i18n.t('PreventScreensaverOnPlaybackDescription') || 'Keep display awake and suppress system screensaver while video is actively playing', `<button class="toggle-switch ${storage.getItem('pref:suppressScreensaverOnPlayback') === 'true' ? 'active' : ''}" id="toggle-suppress-screensaver-playback" tabindex="0"></button>`, { id: 'screensaver-playback-suppression-item' }) : ''}

                <h3 class="setting-section-title" data-i18n="ColorTheme">${i18n.t('ColorTheme')}</h3>
                ${this._item(i18n.t('ThemeMode') || 'Theme Mode', i18n.t('ThemeModeDescription') || 'Choose the base visual style of the application.', this._drop('theme-mode-select', [{ value: 'black', label: i18n.t('ThemeBlack') || 'Black (OLED)' }, { value: 'ambient', label: i18n.t('ThemeAmbient') || 'Ambient Glow' }, { value: 'ember', label: i18n.t('ThemeEmber') || 'Ember' }, { value: 'sunset', label: i18n.t('ThemeSunset') || 'Sunset' }, { value: 'nocturne', label: i18n.t('ThemeNocturne') || 'Nocturne' }, { value: 'abyss', label: i18n.t('ThemeAbyss') || 'Abyss' }, { value: 'cyberpunk', label: i18n.t('ThemeCyberpunk') || 'Cyberpunk' }, { value: 'tinted', label: i18n.t('ThemeTinted') || 'Tinted' }, { value: 'tinted-light', label: i18n.t('ThemeTintedLight') || 'Light Tinted' }, { value: 'classic-dark', label: i18n.t('ThemeDarkClassic') || 'Dark Classic' }, { value: 'frost', label: i18n.t('ThemeFrost') || 'Frost' }, { value: 'paper', label: i18n.t('ThemePaper') || 'Paper' }, { value: 'classic-light', label: i18n.t('ThemeLightClassic') || 'Light Classic' }], themeMode))}
                ${this._item(i18n.t('ThemeColor') || 'Theme Color', i18n.t('ThemeColorDescription') || 'Choose your primary accent color.', `<button class="setting-action-btn theme-color-select-btn" id="btn-theme-color-picker" tabindex="0" data-focusable="true" title="${activeColor.name}"><span class="theme-color-swatch-badge" style="background-color: ${activeColor.hex};"></span><span class="btn-label" id="theme-color-btn-label">${escapeHtml(activeColor.name)}</span></button>`)}
                ${this._item(i18n.t('LighterBackground') || 'Lighter Background', i18n.t('LighterBackgroundDescription') || 'Swap primary with alternate background for a lighter shade.', `<button class="toggle-switch ${layoutManager.getLighterBackground() ? 'active' : ''}" id="toggle-lighter-background" tabindex="0"></button>`, { id: 'lighter-background-item', cls: !['tinted', 'tinted-light', 'classic-dark', 'classic-light'].includes(themeMode) ? 'hidden' : '' })}
                ${this._item(i18n.t('OverrideThemeColor') || 'Override Theme Color', i18n.t('OverrideThemeColorDescription') || "Replace the theme color with this theme's unique signature color.", `<button class="toggle-switch ${layoutManager.getSignatureAccent() ? 'active' : ''}" id="toggle-signature-accent" tabindex="0"></button>`, { id: 'signature-accent-item', cls: !['ember', 'sunset', 'frost', 'paper', 'nocturne', 'abyss', 'cyberpunk'].includes(themeMode) ? 'hidden' : '' })}
                ${this._item(i18n.t('LabelLoaderStyle') || 'Loading Indicator Style', i18n.t('LoaderStyleDescription') || 'Choose visual animation style for loading spinners and indicators.', `<button class="setting-action-btn loader-style-select-btn" id="btn-loader-style-picker" tabindex="0" data-focusable="true" title="${escapeHtml(activeLoaderName)}"><span class="btn-label" id="loader-style-btn-label">${escapeHtml(activeLoaderName)}</span></button>`)}
                ${this._item(i18n.t('ButtonStyle') || 'Button Style', i18n.t('ButtonStyleDescription') || 'Customize the look of primary buttons.', this._drop('button-style-select', [{ value: 'theme-default', label: i18n.t('BtnStyleThemeDefault') || 'Theme Accent (Default)' }, { value: 'theme-inverted', label: i18n.t('BtnStyleThemeInverted') || 'Theme Inverted' }, { value: 'monochrome-bw', label: i18n.t('BtnStyleMonoBW') || 'White & Black' }, { value: 'monochrome-wb', label: i18n.t('BtnStyleMonoWB') || 'Black & White' }, { value: 'white-accent', label: i18n.t('BtnStyleWhiteAccent') || 'White & Accent' }, { value: 'black-accent', label: i18n.t('BtnStyleBlackAccent') || 'Black & Accent' }, { value: 'accent-white', label: i18n.t('BtnStyleAccentWhite') || 'Accent & White' }, { value: 'accent-black', label: i18n.t('BtnStyleAccentBlack') || 'Accent & Black' }], layoutManager.getButtonStyle()))}
                ${this._item(i18n.t('HideUnfocusedBorders') || 'Hide Unfocused Borders', i18n.t('HideUnfocusedBordersDescription') || 'Hide borders on buttons when they are not focused.', `<button class="toggle-switch ${layoutManager.getHideUnfocusedBorders() ? 'active' : ''}" id="toggle-hide-unfocused-borders" tabindex="0"></button>`)}
                ${this._item(i18n.t('FocusBorderStyle') || 'Focus Border Style', i18n.t('FocusBorderStyleDescription') || 'Customize the border color style when buttons are focused.', this._drop('focus-border-style-select', [{ value: 'hidden', label: i18n.t('FocusBorderHidden') || 'Hidden' }, { value: 'follow-theme', label: i18n.t('FocusBorderFollowTheme') || 'Follow Theme' }, { value: 'inverted', label: i18n.t('FocusBorderInverted') || 'Inverted' }, { value: 'white', label: i18n.t('FocusBorderWhite') || 'White' }, { value: 'black', label: i18n.t('FocusBorderBlack') || 'Black' }], layoutManager.getFocusBorderStyle()))}
                ${this._item(i18n.t('HoverBorderStyle') || 'Hover Border Style', i18n.t('HoverBorderStyleDescription') || 'Customize the border color style when buttons are hovered.', this._drop('hover-border-style-select', [{ value: 'white', label: i18n.t('HoverBorderWhite') || 'White' }, { value: 'follow-theme', label: i18n.t('HoverBorderFollowTheme') || 'Follow Theme' }, { value: 'inverted', label: i18n.t('HoverBorderInverted') || 'Inverted' }, { value: 'black', label: i18n.t('HoverBorderBlack') || 'Black' }, { value: 'hidden', label: i18n.t('HoverBorderHidden') || 'Hidden' }], layoutManager.getHoverBorderStyle()))}
                ${this._item(i18n.t('RoundedCorners'), i18n.t('RoundedCornersDescription'), `<button class="toggle-switch ${layoutManager.getRoundedCorners() ? 'active' : ''}" id="toggle-rounded-corners" tabindex="0"></button>`)}

                <h3 class="setting-section-title" data-i18n="PlayerOsd">${i18n.t('PlayerOsd') || 'Player Osd'}</h3>
                ${this._item(i18n.t('OsdHdrDarkerWhite') || 'OSD HDR Darker White', i18n.t('OsdHdrDarkerWhiteDescription') || 'Override white OSD elements with softer grey inside HDR content.', this._playerToggle('osd-hdr-darker-white-toggle', 'osdHdrDarkerWhite', true))}
                ${this._item(i18n.t('LabelShowLogoInOsd') || 'Show Logo in OSD', i18n.t('ShowLogoInOsdDescription') || 'Display show or movie logo instead of text title in the player interface.', this._playerToggle('toggle-osd-show-logo', 'osdShowLogo', false))}
                ${this._item(i18n.t('LabelOsdLogoSize') || 'OSD Logo Size', i18n.t('OsdLogoSizeDescription') || 'Choose the display size of the show or movie logo in the playback overlay.', this._drop('osd-logo-size-select', [{ value: 'small', label: i18n.t('Small') || 'Small' }, { value: 'medium', label: i18n.t('Medium') || 'Medium' }, { value: 'large', label: i18n.t('Large') || 'Large' }, { value: 'extralarge', label: i18n.t('ExtraLarge') || 'Extra Large' }, { value: 'xxl', label: i18n.t('DoubleExtraLarge') || 'XXL' }], PlayerSettings.get('osdLogoSize') || 'medium'), { id: 'osd-logo-size-container', style: PlayerSettings.get('osdShowLogo') ? '' : 'display: none;' })}
                ${this._item(i18n.t('LabelHideYearInOsd') || 'Hide Year in OSD', i18n.t('HideYearInOsdDescription') || 'Hides the production year from the playback overlay title.', this._playerToggle('toggle-osd-hide-year', 'osdHideYear', false))}
                ${this._item(i18n.t('LabelHideShowNameInOsd') || 'Hide Show Name', i18n.t('HideShowNameInOsdDescription') || 'Hides the show name (or logo) for episodes in the playback overlay.', this._playerToggle('toggle-osd-hide-show-name', 'osdHideShowName', false))}
                ${this._item(i18n.t('LabelOsdTimeDisplay') || 'Time Display Mode', i18n.t('OsdTimeDisplayDescription') || 'Choose whether to show total duration or remaining time on seek bar.', this._drop('osd-time-display-select', [{ value: 'total', label: i18n.t('OsdTimeTotal') || 'Total Duration' }, { value: 'remaining', label: i18n.t('OsdTimeRemaining') || 'Remaining Time' }], PlayerSettings.get('osdTimeDisplayMode') || 'total'))}
                ${this._item(i18n.t('LabelOsdTrackMenuBgOpacity') || 'OSD Track Menu Opacity', i18n.t('OsdTrackMenuBgOpacityDescription') || 'Adjust background opacity of audio and subtitle selection overlay menus.', this._slider('osd-track-menu-bg-opacity', PlayerSettings.get('osdTrackMenuBgOpacity') ?? 85, 0, 100, 5))}
                ${this._item(i18n.t('OsdButtonStyle') || 'OSD Button Style', i18n.t('OsdButtonStyleDescription') || 'Choose a button color theme specifically for player control buttons.', this._drop('osd-button-style-select', [{ value: 'follow-global', label: i18n.t('OsdStyleFollowGlobal') || 'Follow Global' }, { value: 'theme-default', label: i18n.t('BtnStyleThemeDefault') || 'Theme Default' }, { value: 'theme-inverted', label: i18n.t('BtnStyleThemeInverted') || 'Theme Inverted' }, { value: 'monochrome-bw', label: i18n.t('BtnStyleMonoBW') || 'White & Black' }, { value: 'monochrome-wb', label: i18n.t('BtnStyleMonoWB') || 'Black & White' }, { value: 'white-accent', label: i18n.t('BtnStyleWhiteAccent') || 'White & Accent' }, { value: 'black-accent', label: i18n.t('BtnStyleBlackAccent') || 'Black & Accent' }, { value: 'accent-white', label: i18n.t('BtnStyleAccentWhite') || 'Accent & White' }, { value: 'accent-black', label: i18n.t('BtnStyleAccentBlack') || 'Accent & Black' }], layoutManager.getOsdButtonStyle()))}
                ${this._item(i18n.t('OsdFocusBorderStyle') || 'OSD Focus Border Style', i18n.t('OsdFocusBorderStyleDescription') || 'Choose focus border highlight style for player control buttons.', this._drop('osd-focus-border-style-select', [{ value: 'follow-global', label: i18n.t('OsdStyleFollowGlobal') || 'Follow Global' }, { value: 'hidden', label: i18n.t('FocusBorderHidden') || 'Hidden' }, { value: 'follow-theme', label: i18n.t('FocusBorderFollowTheme') || 'Follow Theme' }, { value: 'inverted', label: i18n.t('FocusBorderInverted') || 'Inverted' }, { value: 'white', label: i18n.t('FocusBorderWhite') || 'White' }, { value: 'black', label: i18n.t('FocusBorderBlack') || 'Black' }], layoutManager.getOsdFocusBorderStyle()))}
                ${this._item(i18n.t('OsdButtonShape') || 'OSD Button Shape', i18n.t('OsdButtonShapeDescription') || 'Choose a custom shape for the player control buttons.', this._drop('osd-button-shape-select', [{ value: 'circle', label: i18n.t('OsdShapeCircle') || 'Circle' }, { value: 'rounded-square', label: i18n.t('OsdShapeRoundedSquare') || 'Rounded Square' }, { value: 'squircle', label: i18n.t('OsdShapeSquircle') || 'Squircle' }, { value: 'organic-leaf', label: i18n.t('OsdShapeLeaf') || 'Leaf Shape' }, { value: 'hexagon', label: i18n.t('OsdShapeHexagon') || 'Hexagon' }, { value: 'outline', label: i18n.t('OsdShapeOutline') || 'Outline' }, { value: 'icon-only', label: i18n.t('OsdShapeIconOnly') || 'Icon Only' }], layoutManager.getOsdButtonShape()))}
                ${this._item(i18n.t('OsdUnfocusedButtonStyle') || 'OSD Unfocused Button Style', i18n.t('OsdUnfocusedButtonStyleDescription') || 'Choose the style of player control buttons when not focused.', this._drop('osd-unfocused-button-style-select', [{ value: 'icon-only', label: i18n.t('OsdUnfocusedStyleIconOnly') || 'Icon Only' }, { value: 'outline', label: i18n.t('OsdUnfocusedStyleOutline') || 'Outline' }, { value: 'semi-transparent', label: i18n.t('OsdUnfocusedStyleSemiTransparent') || 'Semi-Transparent' }], layoutManager.getOsdUnfocusedButtonStyle()))}
                ${this._item(i18n.t('OsdSeekBarThumbColor') || 'OSD Seek Bar Thumb Color', i18n.t('OsdSeekBarThumbColorDescription') || 'Choose the color for the seek bar thumb.', this._drop('osd-seekbar-thumb-color-select', [{ value: 'white', label: i18n.t('OsdThumbWhite') || 'White' }, { value: 'black', label: i18n.t('OsdThumbBlack') || 'Black' }, { value: 'theme-accent', label: i18n.t('OsdThumbAccent') || 'Theme Accent' }, { value: 'theme-inverted', label: i18n.t('OsdThumbInverted') || 'Theme Inverted' }], layoutManager.getOsdSeekBarThumbColor()))}
                ${this._item(i18n.t('OsdSeekBarProgressColor') || 'OSD Seek Bar Progress Color', i18n.t('OsdSeekBarProgressColorDescription') || 'Choose the color for the seek bar progress fill.', this._drop('osd-seekbar-progress-color-select', [{ value: 'theme-accent', label: i18n.t('OsdThumbAccent') || 'Theme Accent' }, { value: 'white', label: i18n.t('OsdThumbWhite') || 'White' }, { value: 'black', label: i18n.t('OsdThumbBlack') || 'Black' }, { value: 'theme-inverted', label: i18n.t('OsdThumbInverted') || 'Theme Inverted' }], layoutManager.getOsdSeekBarProgressColor()))}

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelNextUpDialogStyle">${i18n.t('LabelNextUpDialogStyle') || 'Up Next Style'}</span><span class="setting-description" data-i18n="NextUpDialogStyleDescription">${i18n.t('NextUpDialogStyleDescription') || 'Choose the layout style of the next episode dialog.'}</span></div><div class="setting-control">${this._drop('next-up-dialog-style-select', [{ value: 'normal', label: i18n.t('OptionStyleNormal') || 'Normal' }, { value: 'no_image', label: i18n.t('OptionStyleNoImage') || 'No Image' }, { value: 'compact', label: i18n.t('OptionStyleCompact') || 'Compact' }, { value: 'button', label: i18n.t('OptionStyleButton') || 'Button' }], PlayerSettings.get('nextUpDialogStyle') || 'normal')}</div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelNextUpDialogScale">${i18n.t('LabelNextUpDialogScale') || 'Up Next Scale'}</span><span class="setting-description" data-i18n="NextUpDialogScaleDescription">${i18n.t('NextUpDialogScaleDescription') || 'Adjust overall scaling factor of the next episode dialog.'}</span></div><div class="setting-control">${this._drop('next-up-dialog-scale-select', [{ value: 0.5, label: i18n.t('ExtraSmall') || 'Extra Small' }, { value: 0.75, label: i18n.t('Small') || 'Small' }, { value: 1.0, label: i18n.t('Medium') || 'Medium' }, { value: 1.25, label: i18n.t('Large') || 'Large' }, { value: 1.5, label: i18n.t('ExtraLarge') || 'Extra Large' }], PlayerSettings.get('nextUpDialogScale') || 1.0)}</div></div>

                <h3 class="setting-section-title" data-i18n="Extra">${i18n.t('Extra')}</h3>
                ${this._item(i18n.t('LabelPlayThemeSongs') || 'Play Theme Songs', i18n.t('PlayThemeSongsDescription') || 'Play theme songs in the background when viewing details pages.', this._toggle('toggle-play-theme-songs', 'pref:playThemeSongs', false))}
                ${this._item(i18n.t('LabelPlayThemeSongsOnce') || 'Play Theme Songs Once', i18n.t('PlayThemeSongsOnceDescription') || 'Play background theme songs only once instead of looping continuously.', this._toggle('toggle-play-theme-songs-once', 'pref:playThemeSongsOnce', true), { id: 'theme-song-once-item', style: storage.getItem('pref:playThemeSongs') === 'true' ? '' : 'display: none;' })}
                ${this._item(i18n.t('ThemeSongVolume') || 'Theme Song Volume', i18n.t('ThemeSongVolumeDescription') || 'Set the volume level for background theme songs.', this._drop('theme-song-volume-select', [{ value: '0.1', label: '10%' }, { value: '0.2', label: '20%' }, { value: '0.3', label: '30%' }, { value: '0.4', label: '40%' }, { value: '0.5', label: '50%' }, { value: '0.6', label: '60%' }, { value: '0.7', label: '70%' }, { value: '0.8', label: '80%' }, { value: '0.9', label: '90%' }, { value: '1.0', label: '100%' }], storage.getItem('pref:themeSongVolume') || '0.3'), { id: 'theme-song-volume-item', style: storage.getItem('pref:playThemeSongs') === 'true' ? '' : 'display: none;' })}

                <h3 class="setting-section-title" data-i18n="WakeOnLanTitle">${i18n.t('WakeOnLanTitle')}</h3>
                ${this._item(i18n.t('WakeOnLanStartup'), i18n.t('WakeOnLanStartupDescription'), this._toggle('toggle-wol-on-startup', 'pref:enableWolOnStartup', false))}
                ${this._item(i18n.t('WakeOnLanTimeout'), i18n.t('WakeOnLanTimeoutDescription'), this._toggle('toggle-wol-on-timeout', 'pref:enableWolOnTimeout', false))}
                ${this._item(i18n.t('WakeOnLanServerScan'), i18n.t('WakeOnLanServerScanDescription'), this._toggle('toggle-wol-on-scan', 'pref:enableWolOnServerScan', false))}
                ${this._item(i18n.t('WakeOnLanExtendedWait'), i18n.t('WakeOnLanExtendedWaitDescription'), this._toggle('toggle-wol-extended-wait', 'pref:enableWolExtendedWait', false))}

                <div class="setting-item" id="wol-mac-container" style="display: ${wolActive ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="WolMacAddress">${i18n.t('WolMacAddress')}</span>
                        <span class="setting-description" data-i18n="WolMacAddressDescription">${i18n.t('WolMacAddressDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <input id="input-wol-mac-address" type="text" class="focusable" tabindex="0" data-focusable="true" 
                               placeholder="00:11:22:33:44:55" 
                               value="${storage.getItem('pref:wolMacAddress') || ''}"
                               style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; padding: 10px 14px; border-radius: 6px; font-size: 1rem; width: 250px; text-align: center;"/>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Binds DOM event listeners for the Appearance tab controls.
     * @param {HTMLElement} root The settings content container
     */
    mount(root) {
        const container = root || this.page?.el || this.page?.element || document;
        if (!container) return;
        this.destroy();
        log.debug('Mounting AppearanceTab event listeners');

        // Wire generic data-storage toggle switches
        const storageToggles = container.querySelectorAll('.toggle-switch[data-storage]');
        storageToggles.forEach((btn) => {
            this._listen(btn, 'click', () => {
                const storageKey = btn.dataset.storage;
                const defVal = btn.dataset.default === 'true';
                const currentVal = storage.getItem(storageKey);
                const isEnabled = currentVal === null ? defVal : currentVal === 'true';
                const nextVal = !isEnabled;
                storage.setItem(storageKey, String(nextVal));
                storage.flush();
                btn.classList.toggle('active', nextVal);
                log.info(`Appearance storage setting changed: ${storageKey} = ${nextVal}`);

                // Synchronize dependent UI rows on WOL or theme song changes
                if (storageKey.startsWith('pref:enableWol')) {
                    const wolActive = ['Startup', 'Timeout', 'ServerScan', 'ExtendedWait'].some(
                        (k) => storage.getItem(`pref:enableWolOn${k}`) === 'true' || storage.getItem('pref:enableWolExtendedWait') === 'true'
                    );
                    const macContainer = container.querySelector('#wol-mac-container');
                    if (macContainer) macContainer.style.display = wolActive ? '' : 'none';
                    focusManager.invalidateCache('settings-content');
                } else if (storageKey === 'pref:playThemeSongs') {
                    const songOnce = container.querySelector('#theme-song-once-item');
                    const songVol = container.querySelector('#theme-song-volume-item');
                    if (songOnce) songOnce.style.display = nextVal ? '' : 'none';
                    if (songVol) songVol.style.display = nextVal ? '' : 'none';
                    focusManager.invalidateCache('settings-content');
                }
            });
        });

        // Wire generic data-setting toggle switches (PlayerSettings)
        const playerToggles = container.querySelectorAll('.toggle-switch[data-setting]');
        playerToggles.forEach((btn) => {
            this._listen(btn, 'click', () => {
                const settingKey = btn.dataset.setting;
                const nextVal = !PlayerSettings.get(settingKey);
                PlayerSettings.set(settingKey, nextVal);
                storage.flush();
                btn.classList.toggle('active', nextVal);
                log.info(`Appearance player setting changed: ${settingKey} = ${nextVal}`);

                if (settingKey === 'osdShowLogo') {
                    const logoContainer = container.querySelector('#osd-logo-size-container');
                    if (logoContainer) logoContainer.style.display = nextVal ? '' : 'none';
                    focusManager.invalidateCache('settings-content');
                }
            });
        });

        // LayoutManager theme and styling switches
        [
            ['#toggle-lighter-background', () => layoutManager.getLighterBackground(), (v) => layoutManager.setLighterBackground(v)],
            ['#toggle-signature-accent', () => layoutManager.getSignatureAccent(), (v) => layoutManager.setSignatureAccent(v)],
            ['#toggle-hide-unfocused-borders', () => layoutManager.getHideUnfocusedBorders(), (v) => layoutManager.setHideUnfocusedBorders(v)],
            ['#toggle-rounded-corners', () => layoutManager.getRoundedCorners(), (v) => layoutManager.setRoundedCorners(v)]
        ].forEach(([sel, getter, setter]) => {
            const btn = container.querySelector(sel);
            if (btn) {
                this._listen(btn, 'click', () => {
                    const next = !getter();
                    setter(next);
                    btn.classList.toggle('active', next);
                });
            }
        });
    }

    /**
     * Updates visibility of lighter background option based on active theme.
     */
    updateLighterBackgroundVisibility() {
        this.page?._updateLighterBackgroundVisibility?.();
    }

    /**
     * Updates visibility of signature accent option based on active theme.
     */
    updateSignatureAccentVisibility() {
        this.page?._updateSignatureAccentVisibility?.();
    }

    /**
     * Cleans up all attached event listeners to prevent memory leaks.
     */
    destroy() {
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

export default AppearanceTab;
