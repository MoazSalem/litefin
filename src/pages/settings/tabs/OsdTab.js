/**
 * ============================================================================
 * Litefin Tizen - OSD Tab Controller
 * ============================================================================
 * Consolidates player On-Screen Display preferences previously split across
 * the Display and Layout tabs:
 * 1. OSD layout alignment, buttons location, and stealth mode
 * 2. Overlay title (logo, year, show name) and time display rules
 * 3. Control button styling (shape, focus border, colors) and visibility
 * 4. Up Next dialog style and scaling
 * ============================================================================
 */

import { i18n } from '../../../utils/i18n.js';
import { storage } from '../../../utils/StorageService.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('OsdTab');

/**
 * Controller managing all player OSD customization settings.
 */
export class OsdTab {
    /**
     * Initializes a new instance of OsdTab.
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

    /** Helper to render dropdown controls via host page. @private */
    _drop(id, options, currentVal, disabled = false) {
        return this.page ? this.page._renderDropdown(id, options, currentVal, disabled) : '';
    }

    /** Helper to render slider controls via host page. @private */
    _slider(id, currentVal, min, max, step) {
        return this.page ? this.page._renderSlider(id, currentVal, min, max, step) : '';
    }

    /** Helper to render a PlayerSettings-backed toggle switch button. @private */
    _playerToggle(id, settingKey, defVal = false) {
        const val = PlayerSettings.get(settingKey);
        const active = val !== undefined ? Boolean(val) : defVal;
        return `<button class="toggle-switch ${active ? 'active' : ''}" id="${id}" data-setting="${settingKey}" tabindex="0"></button>`;
    }

    /** Track and attach event listener on target element. @private */
    _listen(el, event, handler) {
        if (!el) return;
        el.addEventListener(event, handler);
        this._listeners.push({ element: el, event, handler });
    }

    /**
     * Renders the complete HTML markup for the OSD tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="PlayerOsd">${i18n.t('PlayerOsd') || 'Player OSD'}</h2>
                <p class="content-subtitle" data-i18n="SettingsDescOsd">${i18n.t('SettingsDescOsd') || 'Configure player overlay layout, buttons, and styling.'}</p>

                ${this._item(
                    i18n.t('OsdLayout') || 'OSD Layout',
                    i18n.t('OsdLayoutDescription') ||
                        'Choose the layout alignment of player playback and menu control buttons.',
                    this._drop(
                        'osd-layout-select',
                        [
                            { value: 'left', label: i18n.t('OsdLayoutLeft') || 'Left Aligned (Default)' },
                            { value: 'centered', label: i18n.t('OsdLayoutCentered') || 'Centered' },
                            {
                                value: 'hidden',
                                label: i18n.t('OsdLayoutHidden') || 'Stealth / Anti-Spoiler (Hold Down to Reveal)'
                            }
                        ],
                        PlayerSettings.get('osdLayout') || 'left'
                    )
                )}
                ${this._item(
                    i18n.t('OsdButtonsLocation') || 'OSD Buttons Location',
                    i18n.t('OsdButtonsLocationDescription') ||
                        'Choose the location of playback control buttons relative to the seek bar.',
                    this._drop(
                        'osd-buttons-location-select',
                        [
                            { value: 'above', label: i18n.t('OsdButtonsAbove') || 'Above Seek Bar' },
                            { value: 'below', label: i18n.t('OsdButtonsBelow') || 'Below Seek Bar' }
                        ],
                        PlayerSettings.get('osdButtonsLocation') || 'above'
                    )
                )}
                ${this._item(
                    i18n.t('LabelOsdGradientOpacity') || 'OSD Background Gradient Opacity',
                    i18n.t('OsdGradientOpacityDescription') ||
                        'Adjust the opacity of the top and bottom dark gradient overlays.',
                    this._slider('osd-gradient-opacity', PlayerSettings.get('osdGradientOpacity') ?? 75, 0, 100, 5)
                )}
                ${this._item(
                    i18n.t('LabelOsdHideFavorite') || 'Hide Favorite Button',
                    i18n.t('OsdHideFavoriteDescription') || 'Hide the favorite heart button from the playback overlay.',
                    this._playerToggle('toggle-osd-hide-favorite', 'osdHideFavorite', false)
                )}
                ${this._item(
                    i18n.t('LabelOsdHideInfo') || 'Hide Info Button',
                    i18n.t('OsdHideInfoDescription') || 'Hide the playback details button from the playback overlay.',
                    this._playerToggle('toggle-osd-hide-info', 'osdHideInfo', false)
                )}
                ${this._item(
                    i18n.t('LabelOsdHideBackButton') || 'Hide Back Button',
                    i18n.t('OsdHideBackButtonDescription') || 'Hide the back arrow button from the player header.',
                    this._playerToggle('toggle-osd-hide-back-button', 'osdHideBackButton', false)
                )}
                ${this._item(
                    i18n.t('LabelOsdCombineSkipButtons') || 'Combine Navigation Buttons',
                    i18n.t('OsdCombineSkipButtonsDescription') || 'Combine seek, chapter, and file skip buttons.',
                    this._playerToggle('toggle-osd-combine-skip-buttons', 'osdCombineSkipButtons', false)
                )}
                ${this._item(
                    i18n.t('OsdFocusRestoreMode') || 'OSD Focus Restore',
                    i18n.t('OsdFocusRestoreModeDescription') ||
                        'Where the remote cursor lands when the player controls reappear after being auto-hidden.',
                    this._drop(
                        'osd-focus-mode-select',
                        [
                            { value: 'always', label: i18n.t('OsdFocusAlways') || 'Always return to Play/Pause' },
                            { value: 'timeout', label: i18n.t('OsdFocusTimeout') || 'Return to Play/Pause after 10 s' },
                            { value: 'remember', label: i18n.t('OsdFocusRemember') || 'Remember last position' },
                            { value: 'seekbar', label: i18n.t('OsdFocusSeekbar') || 'Always return to Seekbar' }
                        ],
                        PlayerSettings.get('osdFocusRestoreMode') || 'always'
                    )
                )}
                ${this._item(
                    i18n.t('OkShowOsdOnly') || 'OK Shows OSD Only',
                    i18n.t('OkShowOsdOnlyDescription') ||
                        'When the player controls are hidden, pressing OK will only show them instead of also running the focused action.',
                    this._playerToggle('toggle-ok-show-osd-only', 'okShowOsdOnly', false)
                )}
                ${this._item(
                    i18n.t('OsdColorButtonsReveal') || 'Colored Buttons Reveal OSD',
                    i18n.t('OsdColorButtonsRevealDescription') ||
                        'Allow pressing colored remote buttons to instantly reveal controls in stealth mode instead of holding Down.',
                    this._playerToggle('toggle-osd-color-buttons-reveal', 'osdColorButtonsReveal', true)
                )}
                ${this._item(
                    i18n.t('LabelOsdHideUnfocusedProgress') || 'Hide Progress and Time on Seekbar',
                    i18n.t('OsdHideUnfocusedProgressDescription') ||
                        'Hides the progress bar, times, and ends-at time when the seekbar is not focused.',
                    this._playerToggle('toggle-osd-hide-unfocused-progress', 'osdHideUnfocusedProgress', false)
                )}
                ${this._item(
                    i18n.t('LabelOsdHideEndsAt') || 'Hide Ends At',
                    i18n.t('OsdHideEndsAtDescription') || "Hide the 'Ends at' time from the player OSD.",
                    this._playerToggle('toggle-osd-hide-ends-at', 'osdHideEndsAt', false)
                )}
                ${this._item(
                    i18n.t('EnablePlayerCursor') || 'Enable Player Cursor',
                    i18n.t('EnablePlayerCursorDescription') ||
                        'Allow cursor/mouse interaction within the player (clicking to pause, waking the OSD on move).',
                    this._playerToggle('toggle-magic-cursor', 'enableMagicCursor', true)
                )}
                ${this._item(
                    i18n.t('EnableScreenLock') || 'Playback Screen Lock',
                    i18n.t('EnableScreenLockDescription') ||
                        'Enable a screen and input lock button in the player overlay.',
                    this._playerToggle('toggle-enable-screen-lock', 'enableScreenLock', false)
                )}
                ${this._item(
                    i18n.t('EnableHoverTrickplay') || 'Hover Trickplay',
                    i18n.t('EnableHoverTrickplayDescription') ||
                        'Show timestamp and trickplay images when hovering over the seekbar with the mouse.',
                    this._playerToggle('toggle-hover-trickplay', 'enableHoverTrickplay', false)
                )}

                <h3 class="setting-section-title" data-i18n="PlayerOsd">${i18n.t('PlayerOsd') || 'Player OSD'}</h3>
                ${this._item(
                    i18n.t('OsdHdrDarkerWhite') || 'OSD HDR Darker White',
                    i18n.t('OsdHdrDarkerWhiteDescription') ||
                        'Override white OSD elements with softer grey inside HDR content.',
                    this._playerToggle('osd-hdr-darker-white-toggle', 'osdHdrDarkerWhite', true)
                )}
                ${this._item(
                    i18n.t('LabelShowLogoInOsd') || 'Show Logo in OSD',
                    i18n.t('ShowLogoInOsdDescription') ||
                        'Display show or movie logo instead of text title in the player interface.',
                    this._playerToggle('toggle-osd-show-logo', 'osdShowLogo', false)
                )}
                ${this._item(
                    i18n.t('LabelOsdLogoSize') || 'OSD Logo Size',
                    i18n.t('OsdLogoSizeDescription') ||
                        'Choose the display size of the show or movie logo in the playback overlay.',
                    this._drop(
                        'osd-logo-size-select',
                        [
                            { value: 'small', label: i18n.t('Small') || 'Small' },
                            { value: 'medium', label: i18n.t('Medium') || 'Medium' },
                            { value: 'large', label: i18n.t('Large') || 'Large' },
                            { value: 'extralarge', label: i18n.t('ExtraLarge') || 'Extra Large' },
                            { value: 'xxl', label: i18n.t('DoubleExtraLarge') || 'XXL' }
                        ],
                        PlayerSettings.get('osdLogoSize') || 'medium'
                    ),
                    { id: 'osd-logo-size-container', style: PlayerSettings.get('osdShowLogo') ? '' : 'display: none;' }
                )}
                ${this._item(
                    i18n.t('LabelHideYearInOsd') || 'Hide Year in OSD',
                    i18n.t('HideYearInOsdDescription') || 'Hides the production year from the playback overlay title.',
                    this._playerToggle('toggle-osd-hide-year', 'osdHideYear', false)
                )}
                ${this._item(
                    i18n.t('LabelHideShowNameInOsd') || 'Hide Show Name',
                    i18n.t('HideShowNameInOsdDescription') ||
                        'Hides the show name (or logo) for episodes in the playback overlay.',
                    this._playerToggle('toggle-osd-hide-show-name', 'osdHideShowName', false)
                )}
                ${this._item(
                    i18n.t('LabelOsdTimeDisplay') || 'Time Display Mode',
                    i18n.t('OsdTimeDisplayDescription') ||
                        'Choose whether to show total duration or remaining time on seek bar.',
                    this._drop(
                        'osd-time-display-select',
                        [
                            { value: 'total', label: i18n.t('OsdTimeTotal') || 'Total Duration' },
                            { value: 'remaining', label: i18n.t('OsdTimeRemaining') || 'Remaining Time' }
                        ],
                        PlayerSettings.get('osdTimeDisplayMode') || 'total'
                    )
                )}
                ${this._item(
                    i18n.t('LabelOsdTrackMenuBgOpacity') || 'OSD Track Menu Opacity',
                    i18n.t('OsdTrackMenuBgOpacityDescription') ||
                        'Adjust background opacity of audio and subtitle selection overlay menus.',
                    this._slider(
                        'osd-track-menu-bg-opacity',
                        PlayerSettings.get('osdTrackMenuBgOpacity') ?? 85,
                        0,
                        100,
                        5
                    )
                )}

                <h3 class="setting-section-title" data-i18n="OsdButtonStyle">${i18n.t('OsdButtonStyle') || 'OSD Button Style'}</h3>
                ${this._item(
                    i18n.t('OsdButtonStyle') || 'OSD Button Style',
                    i18n.t('OsdButtonStyleDescription') ||
                        'Choose a button color theme specifically for player control buttons.',
                    this._drop(
                        'osd-button-style-select',
                        [
                            { value: 'follow-global', label: i18n.t('OsdStyleFollowGlobal') || 'Follow Global' },
                            { value: 'theme-default', label: i18n.t('BtnStyleThemeDefault') || 'Theme Default' },
                            { value: 'theme-inverted', label: i18n.t('BtnStyleThemeInverted') || 'Theme Inverted' },
                            { value: 'monochrome-bw', label: i18n.t('BtnStyleMonoBW') || 'White & Black' },
                            { value: 'monochrome-wb', label: i18n.t('BtnStyleMonoWB') || 'Black & White' },
                            { value: 'white-accent', label: i18n.t('BtnStyleWhiteAccent') || 'White & Accent' },
                            { value: 'black-accent', label: i18n.t('BtnStyleBlackAccent') || 'Black & Accent' },
                            { value: 'accent-white', label: i18n.t('BtnStyleAccentWhite') || 'Accent & White' },
                            { value: 'accent-black', label: i18n.t('BtnStyleAccentBlack') || 'Accent & Black' }
                        ],
                        layoutManager.getOsdButtonStyle()
                    )
                )}
                ${this._item(
                    i18n.t('OsdFocusBorderStyle') || 'OSD Focus Border Style',
                    i18n.t('OsdFocusBorderStyleDescription') ||
                        'Choose focus border highlight style for player control buttons.',
                    this._drop(
                        'osd-focus-border-style-select',
                        [
                            { value: 'follow-global', label: i18n.t('OsdStyleFollowGlobal') || 'Follow Global' },
                            { value: 'hidden', label: i18n.t('FocusBorderHidden') || 'Hidden' },
                            { value: 'follow-theme', label: i18n.t('FocusBorderFollowTheme') || 'Follow Theme' },
                            { value: 'inverted', label: i18n.t('FocusBorderInverted') || 'Inverted' },
                            { value: 'white', label: i18n.t('FocusBorderWhite') || 'White' },
                            { value: 'black', label: i18n.t('FocusBorderBlack') || 'Black' }
                        ],
                        layoutManager.getOsdFocusBorderStyle()
                    )
                )}
                ${this._item(
                    i18n.t('OsdButtonShape') || 'OSD Button Shape',
                    i18n.t('OsdButtonShapeDescription') || 'Choose a custom shape for the player control buttons.',
                    this._drop(
                        'osd-button-shape-select',
                        [
                            { value: 'circle', label: i18n.t('OsdShapeCircle') || 'Circle' },
                            { value: 'rounded-square', label: i18n.t('OsdShapeRoundedSquare') || 'Rounded Square' },
                            { value: 'squircle', label: i18n.t('OsdShapeSquircle') || 'Squircle' },
                            { value: 'organic-leaf', label: i18n.t('OsdShapeLeaf') || 'Leaf Shape' },
                            { value: 'hexagon', label: i18n.t('OsdShapeHexagon') || 'Hexagon' },
                            { value: 'outline', label: i18n.t('OsdShapeOutline') || 'Outline' },
                            { value: 'icon-only', label: i18n.t('OsdShapeIconOnly') || 'Icon Only' }
                        ],
                        layoutManager.getOsdButtonShape()
                    )
                )}
                ${this._item(
                    i18n.t('OsdUnfocusedButtonStyle') || 'OSD Unfocused Button Style',
                    i18n.t('OsdUnfocusedButtonStyleDescription') ||
                        'Choose the style of player control buttons when not focused.',
                    this._drop(
                        'osd-unfocused-button-style-select',
                        [
                            { value: 'icon-only', label: i18n.t('OsdUnfocusedStyleIconOnly') || 'Icon Only' },
                            { value: 'outline', label: i18n.t('OsdUnfocusedStyleOutline') || 'Outline' },
                            {
                                value: 'semi-transparent',
                                label: i18n.t('OsdUnfocusedStyleSemiTransparent') || 'Semi-Transparent'
                            }
                        ],
                        layoutManager.getOsdUnfocusedButtonStyle()
                    )
                )}
                ${this._item(
                    i18n.t('OsdSeekBarThumbColor') || 'OSD Seek Bar Thumb Color',
                    i18n.t('OsdSeekBarThumbColorDescription') || 'Choose the color for the seek bar thumb.',
                    this._drop(
                        'osd-seekbar-thumb-color-select',
                        [
                            { value: 'white', label: i18n.t('OsdThumbWhite') || 'White' },
                            { value: 'black', label: i18n.t('OsdThumbBlack') || 'Black' },
                            { value: 'theme-accent', label: i18n.t('OsdThumbAccent') || 'Theme Accent' },
                            { value: 'theme-inverted', label: i18n.t('OsdThumbInverted') || 'Theme Inverted' }
                        ],
                        layoutManager.getOsdSeekBarThumbColor()
                    )
                )}
                ${this._item(
                    i18n.t('OsdSeekBarProgressColor') || 'OSD Seek Bar Progress Color',
                    i18n.t('OsdSeekBarProgressColorDescription') || 'Choose the color for the seek bar progress fill.',
                    this._drop(
                        'osd-seekbar-progress-color-select',
                        [
                            { value: 'theme-accent', label: i18n.t('OsdThumbAccent') || 'Theme Accent' },
                            { value: 'white', label: i18n.t('OsdThumbWhite') || 'White' },
                            { value: 'black', label: i18n.t('OsdThumbBlack') || 'Black' },
                            { value: 'theme-inverted', label: i18n.t('OsdThumbInverted') || 'Theme Inverted' }
                        ],
                        layoutManager.getOsdSeekBarProgressColor()
                    )
                )}

                <h3 class="setting-section-title" data-i18n="UpNext">${i18n.t('UpNext') || 'Up Next'}</h3>
                ${this._item(
                    i18n.t('LabelNextUpDialogStyle') || 'Up Next Style',
                    i18n.t('NextUpDialogStyleDescription') || 'Choose the layout style of the next episode dialog.',
                    this._drop(
                        'next-up-dialog-style-select',
                        [
                            { value: 'normal', label: i18n.t('OptionStyleNormal') || 'Normal' },
                            { value: 'no_image', label: i18n.t('OptionStyleNoImage') || 'No Image' },
                            { value: 'compact', label: i18n.t('OptionStyleCompact') || 'Compact' },
                            { value: 'button', label: i18n.t('OptionStyleButton') || 'Button' }
                        ],
                        PlayerSettings.get('nextUpDialogStyle') || 'normal'
                    )
                )}
                ${this._item(
                    i18n.t('LabelNextUpDialogScale') || 'Up Next Scale',
                    i18n.t('NextUpDialogScaleDescription') ||
                        'Adjust overall scaling factor of the next episode dialog.',
                    this._drop(
                        'next-up-dialog-scale-select',
                        [
                            { value: 0.5, label: i18n.t('ExtraSmall') || 'Extra Small' },
                            { value: 0.75, label: i18n.t('Small') || 'Small' },
                            { value: 1.0, label: i18n.t('Medium') || 'Medium' },
                            { value: 1.25, label: i18n.t('Large') || 'Large' },
                            { value: 1.5, label: i18n.t('ExtraLarge') || 'Extra Large' }
                        ],
                        PlayerSettings.get('nextUpDialogScale') || 1.0
                    )
                )}
            </div>
        `;
    }

    /**
     * Binds DOM event listeners for the OSD tab controls.
     * @param {HTMLElement} root The settings content container
     */
    mount(root) {
        const container = root || this.page?.el || this.page?.element || document;
        if (!container) return;
        this.destroy();

        // Wire generic data-setting toggle switches (PlayerSettings)
        const playerToggles = container.querySelectorAll('.toggle-switch[data-setting]');
        playerToggles.forEach((btn) => {
            this._listen(btn, 'click', () => {
                const settingKey = btn.dataset.setting;
                const nextVal = !PlayerSettings.get(settingKey);
                PlayerSettings.set(settingKey, nextVal);
                storage.flush();
                btn.classList.toggle('active', nextVal);
                log.info(`OSD player setting changed: ${settingKey} = ${nextVal}`);

                // Synchronize the logo size row with the Show Logo in OSD toggle
                if (settingKey === 'osdShowLogo') {
                    const logoContainer = container.querySelector('#osd-logo-size-container');
                    if (logoContainer) logoContainer.style.display = nextVal ? '' : 'none';
                    focusManager.invalidateCache('settings-content');
                }
            });
        });
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

export default OsdTab;
