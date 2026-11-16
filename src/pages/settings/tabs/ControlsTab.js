/**
 * ============================================================================
 * Litefin Tizen - Controls Tab Controller
 * ============================================================================
 * Manages physical remote button mappings (Red, Green, Yellow, Blue keys),
 * mouse pointer emulation cursor, hover trickplay previews, scroll navigation,
 * application exit confirmation dialogs, and library focus heuristics.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';

import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('ControlsTab');

/**
 * Valid action targets that the user can map to physical remote colored keys.
 */
export const REMOTE_BUTTON_OPTIONS = [
    { value: 'none', label: 'OptionNone' },
    { value: 'home', label: 'OptionHome' },
    { value: 'playPause', label: 'OptionPlayPause' },
    { value: 'screensaver', label: 'OptionScreensaver' },
    { value: 'sleepTimer', label: 'OptionSleepTimer' },
    { value: 'playerSubtitles', label: 'OptionPlayerSubtitles' },
    { value: 'playerAudio', label: 'OptionPlayerAudio' },
    { value: 'playerSettings', label: 'OptionPlayerSettings' },
    { value: 'playerSubtitleOffset', label: 'OptionPlayerSubtitleOffset' },
    { value: 'playerQueue', label: 'OptionPlayerQueue' },
    { value: 'playerChapters', label: 'OptionPlayerChapters' },
    { value: 'playerPlaybackInfo', label: 'OptionPlayerPlaybackInfo' },
    { value: 'playerShowOsd', label: 'OptionPlayerShowOsd' },
    { value: 'playerToggleOsdLayout', label: 'OptionPlayerToggleOsdLayout' },
    { value: 'playerPreviousChapter', label: 'OptionPlayerPreviousChapter' },
    { value: 'playerNextChapter', label: 'OptionPlayerNextChapter' },
    { value: 'sendWol', label: 'OptionSendWakeOnLan' },
    { value: 'randomItem', label: 'OptionRandomItem' }
];

/**
 * Controller for the Settings Controls and Remote Mapping tab.
 */
export class ControlsTab {
    /**
     * Creates an instance of ControlsTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Retain parent page context for dropdown rendering and spatial navigation
        this.page = pageContext;

        // Track active event listeners for deterministic cleanup
        this._listeners = [];
    }

    /**
     * Helper to resolve localized remote button action options.
     * @returns {Array<Object>} Localized dropdown option configurations
     */
    getRemoteButtonOptions() {
        return REMOTE_BUTTON_OPTIONS.map((opt) => ({
            value: opt.value,
            label: i18n.t(opt.label) || opt.value
        }));
    }

    /**
     * Generates HTML markup for the Controls tab.
     * Includes app behavior preferences, playback gesture toggles,
     * and physical remote colored key dropdowns.
     * @returns {string} Serialized HTML template
     */
    render() {
        // Read app exit and resume selection preferences
        const confirmExit = storage.getItem('pref:confirmExit') === 'true';
        const showProfilesOnResume = storage.getItem('pref:showProfilesOnResume') === 'true';
        const scrollNavEnabled = storage.getItem('pref:hoverScrollNavigation') === 'true';

        // Read library focus preference
        const focusFirstItemEnabled = storage.getItem('pref:focusFirstItemLibrary') !== 'false';

        // Read current physical remote button assignments
        const redAction = storage.getItem('pref:remoteRedAction') || 'none';
        const greenAction = storage.getItem('pref:remoteGreenAction') || 'none';
        const yellowAction = storage.getItem('pref:remoteYellowAction') || 'none';
        const blueAction = storage.getItem('pref:remoteBlueAction') || 'none';

        const remoteOptions = this.getRemoteButtonOptions();

        // Helper to render dropdown via parent page facade
        const renderDropdown = (id, options, current) => {
            if (this.page && typeof this.page._renderDropdown === 'function') {
                return this.page._renderDropdown(id, options, current);
            }
            return '';
        };

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Controls">${i18n.t('Controls') || 'Controls'}</h2>
                <p class="content-subtitle" data-i18n="ControlsTabDescription">
                    ${i18n.t('ControlsTabDescription') || 'Map physical remote buttons, mouse cursor behavior, and navigation gestures.'}
                </p>

                <h3 class="setting-section-title" data-i18n="AppBehavior">${i18n.t('AppBehavior')}</h3>

                <!-- Confirm App Exit Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ConfirmAppExitLabel">${i18n.t('ConfirmAppExitLabel') || 'Confirm on Exit'}</span>
                        <span class="setting-description" data-i18n="ConfirmAppExitDescription">${i18n.t('ConfirmAppExitDescription') || 'Show a confirmation prompt before closing the application.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${confirmExit ? 'active' : ''}" id="toggle-confirm-exit" tabindex="0"></button>
                    </div>
                </div>

                <!-- Show Profiles on Resume Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ShowProfilesOnResume">${i18n.t('ShowProfilesOnResume')}</span>
                        <span class="setting-description" data-i18n="ShowProfilesOnResumeDescription">${i18n.t('ShowProfilesOnResumeDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${showProfilesOnResume ? 'active' : ''}" id="toggle-profiles-on-resume" tabindex="0"></button>
                    </div>
                </div>

                <!-- Wheel / Magic Remote Scroll Navigation Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HoverScrollNavigation">${i18n.t('HoverScrollNavigation') || 'Scroll Navigation'}</span>
                        <span class="setting-description" data-i18n="HoverScrollNavigationDescription">${i18n.t('HoverScrollNavigationDescription') || 'Traverse vertical lists and rows using the scroll wheel or magic remote wheel.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${scrollNavEnabled ? 'active' : ''}" id="toggle-hover-scroll-nav" tabindex="0"></button>
                    </div>
                </div>

                <!-- Smart Library Initial Focus Management Target -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelFocusFirstItemInLibrary">${i18n.t('LabelFocusFirstItemInLibrary') || 'Focus first item in Library'}</span>
                        <span class="setting-description" data-i18n="FocusFirstItemInLibraryDescription">${i18n.t('FocusFirstItemInLibraryDescription') || 'Automatically focus the first item when entering a library instead of the navigation tabs.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${focusFirstItemEnabled ? 'active' : ''}" id="toggle-focus-first-item-library" tabindex="0"></button>
                    </div>
                </div>

                <!-- Physical Hardware Remote Keymap Assignments -->
                <h3 class="setting-section-title" style="margin-top: 40px;" data-i18n="HeaderRemoteButtons">${i18n.t('HeaderRemoteButtons') || 'Remote Button Mapping'}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelRemoteRed">${i18n.t('LabelRemoteRed') || 'Red Button Action'}</span>
                        <span class="setting-description" data-i18n="RemoteRedActionDescription">${i18n.t('RemoteRedActionDescription') || 'Action to perform when the Red button on the remote is pressed.'}</span>
                    </div>
                    <div class="setting-control">
                        ${renderDropdown('remote-red-select', remoteOptions, redAction)}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                         <span class="setting-name" data-i18n="LabelRemoteGreen">${i18n.t('LabelRemoteGreen') || 'Green Button Action'}</span>
                        <span class="setting-description" data-i18n="RemoteGreenActionDescription">${i18n.t('RemoteGreenActionDescription') || 'Action to perform when the Green button on the remote is pressed.'}</span>
                    </div>
                    <div class="setting-control">
                        ${renderDropdown('remote-green-select', remoteOptions, greenAction)}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                         <span class="setting-name" data-i18n="LabelRemoteYellow">${i18n.t('LabelRemoteYellow') || 'Yellow Button Action'}</span>
                        <span class="setting-description" data-i18n="RemoteYellowActionDescription">${i18n.t('RemoteYellowActionDescription') || 'Action to perform when the Yellow button on the remote is pressed.'}</span>
                    </div>
                    <div class="setting-control">
                        ${renderDropdown('remote-yellow-select', remoteOptions, yellowAction)}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                         <span class="setting-name" data-i18n="LabelRemoteBlue">${i18n.t('LabelRemoteBlue') || 'Blue Button Action'}</span>
                        <span class="setting-description" data-i18n="RemoteBlueActionDescription">${i18n.t('RemoteBlueActionDescription') || 'Action to perform when the Blue button on the remote is pressed.'}</span>
                    </div>
                    <div class="setting-control">
                        ${renderDropdown('remote-blue-select', remoteOptions, blueAction)}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Helper to attach and track an event listener for cleanup.
     * @private
     */
    _addListener(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this._listeners.push({ element, event, handler });
    }

    /**
     * Binds interactive events for Controls tab switches.
     * @param {HTMLElement} [container] Root settings DOM element
     */
    mount(container) {
        // Clear previous listeners to avoid duplicates
        this._unbindListeners();

        const root =
            container || (this.page && typeof this.page.$ === 'function' ? this.page.element : null) || document;

        // Toggle Confirm App Exit
        const confirmExitToggle = root.querySelector('#toggle-confirm-exit');
        if (confirmExitToggle) {
            this._addListener(confirmExitToggle, 'click', () => {
                const isCurrentlyActive = storage.getItem('pref:confirmExit') === 'true';
                const nextState = !isCurrentlyActive;
                storage.setItem('pref:confirmExit', String(nextState));
                confirmExitToggle.classList.toggle('active', nextState);
                log.info(`Confirm app exit preference set to: ${nextState}`);
            });
        }

        // Toggle Show Profiles on Resume is wired centrally by SettingsPage controller

        // Toggle Hover / Wheel Scroll Navigation
        const hoverScrollNavToggle = root.querySelector('#toggle-hover-scroll-nav');
        if (hoverScrollNavToggle) {
            this._addListener(hoverScrollNavToggle, 'click', () => {
                const isCurrentlyActive = storage.getItem('pref:hoverScrollNavigation') === 'true';
                const nextState = !isCurrentlyActive;
                storage.setItem('pref:hoverScrollNavigation', String(nextState));
                hoverScrollNavToggle.classList.toggle('active', nextState);
                log.info(`Hover scroll navigation set to: ${nextState}`);
            });
        }

        // Toggle Initial Focus First Item in Library
        const focusFirstItemBtn = root.querySelector('#toggle-focus-first-item-library');
        if (focusFirstItemBtn) {
            this._addListener(focusFirstItemBtn, 'click', () => {
                const isEnabled = storage.getItem('pref:focusFirstItemLibrary') !== 'false';
                const nextState = !isEnabled;
                storage.setItem('pref:focusFirstItemLibrary', nextState.toString());
                focusFirstItemBtn.classList.toggle('active', nextState);
                log.info(`Focus First Item in Library set to: ${nextState}`);
            });
        }
    }

    /**
     * Unbinds registered DOM event listeners.
     * @private
     */
    _unbindListeners() {
        for (let i = 0; i < this._listeners.length; i++) {
            const { element, event, handler } = this._listeners[i];
            if (element && typeof element.removeEventListener === 'function') {
                element.removeEventListener(event, handler);
            }
        }
        this._listeners = [];
    }

    /**
     * Teardown lifecycle hook called when unmounting or switching tabs.
     */
    destroy() {
        this._unbindListeners();
        this.page = null;
    }
}

export default ControlsTab;
