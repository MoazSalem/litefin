/**
 * ============================================================================
 * Litefin Tizen - Emulator Page
 * ============================================================================
 * Full-screen standalone emulator host designed following Apple's Human
 * Interface Guidelines (HIG). Renders JellyEmu's backend session seamlessly,
 * provides hardware-accelerated iframe containment, traps TV remote back events,
 * and displays an Apple TV-style frosted-glass pause/exit HUD with spring
 * animations before allowing the user to return to Litefin.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/ApiClient.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('EmulatorPage');

class EmulatorPage extends Page {
    constructor() {
        super();
        this.title = 'Game';

        // Track active session elements and dialog states
        this._iframe = null;
        this._isPauseMenuVisible = false;
        this._previousActiveElement = null;
        this._focusedButtonIndex = 0;
    }

    /**
     * Renders the base DOM hierarchy.
     * Standalone full-screen container matching Apple Human Interface Guidelines:
     * ultra-smooth transitions, and translucent glass floating HUD.
     */
    render() {
        return `
            <div class="emulator-page" id="emulator-container">
                <!-- Hardware accelerated game frame -->
                <iframe
                    id="emulator-frame"
                    class="emulator-iframe"
                    tabindex="0"
                    allow="autoplay; fullscreen; gamepad *; xr-spatial-tracking; microphone"
                ></iframe>

                <!-- Apple TV Inspired Frosted Glass Pause / Exit Dialog -->
                <div class="emulator-pause-overlay hidden" id="emulator-pause-overlay" aria-hidden="true">
                    <div class="emulator-pause-card" role="dialog" aria-modal="true">
                        <div class="emulator-pause-badge">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M7 16q.425 0 .713-.288T8 15v-2h2q.425 0 .713-.288T11 12t-.288-.712T10 11H8V9q0-.425-.288-.712T7 8t-.712.288T6 9v2H4q-.425 0-.712.288T3 12t.288.713T4 13h2v2q0 .425.288.713T7 16m10-4q.625 0 1.063-.437T18.5 10.5t-.437-1.062T17 9t-1.062.438T15.5 10.5t.438 1.063T17 12m-2.5 3q.625 0 1.063-.437t.437-1.063t-.437-1.062T14.5 12t-1.062.438t-.438 1.062t.438 1.063t1.062.437M6.8 21q-.7 0-1.312-.35t-.988-.95l-2.4-4.8q-.525-1.05-.187-2.188T2.95 11l2.05-6.15q.35-1.05 1.225-1.7T7.3 2.5h9.4q1.15 0 2.025.65t1.225 1.7L22 11q.7 1.15.363 2.288t-.988 1.962l-2.4 4.8q-.375.6-.987.95t-1.313.35q-.775 0-1.425-.4t-.975-1.1L13.7 17h-3.4l-.575 1.75q-.325.7-.975 1.1T7.3 20.25z"/>
                            </svg>
                            <span>${i18n.t('PlayGame') || 'Game Paused'}</span>
                        </div>

                        <h2 class="emulator-pause-title" id="emulator-pause-title">
                            ${i18n.t('EmulatorExitPrompt') || 'Exit Game'}
                        </h2>
                        
                        <p class="emulator-pause-desc">
                            ${i18n.t('EmulatorExitConfirm') || 'Make sure your in-game save state has been written before exiting.'}
                        </p>

                        <div class="emulator-pause-actions" id="emulator-pause-actions">
                            <button
                                class="btn btn-primary emulator-hud-btn"
                                id="btn-emulator-resume"
                                tabindex="0"
                            >
                                <span>${i18n.t('ResumeGame') || 'Resume Playing'}</span>
                            </button>
                            <button
                                class="btn btn-secondary emulator-hud-btn"
                                id="btn-emulator-exit"
                                tabindex="0"
                            >
                                <span>${i18n.t('ExitGame') || 'Exit to Litefin'}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Ensures Jellyfin credentials exist in standard localStorage format
     * so that JellyEmu ejs.html and ejs.save.js can authenticate requests.
     * @private
     */
    _syncJellyfinCredentials() {
        try {
            const userId = api.userId;
            const accessToken = api.accessToken;
            const serverUrl = api.serverUrl;
            if (userId && accessToken) {
                const creds = {
                    Servers: [
                        {
                            UserId: userId,
                            AccessToken: accessToken,
                            ManualAddress: serverUrl || ''
                        }
                    ]
                };
                localStorage.setItem('jellyfin_credentials', JSON.stringify(creds));
            }
        } catch (e) {
            log.warn('Could not sync jellyfin_credentials to localStorage:', e);
        }
    }

    /**
     * Initializes the emulator playback container.
     */
    async onInit() {
        const itemId = this.params?.id;
        if (!itemId) {
            log.error('No Item ID provided to EmulatorPage, navigating back');
            router.back();
            return;
        }

        this._itemId = itemId;
        this._iframe = this.$('#emulator-frame');

        // Pre-sync credentials for the iframe session
        this._syncJellyfinCredentials();

        // Construct authenticated JellyEmu playback URL
        const serverUrl = api.serverUrl;
        const userId = api.userId;
        const playPath = `/jellyemu/play/${encodeURIComponent(itemId)}${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`;
        const fullPlayUrl = serverUrl ? `${serverUrl}${playPath}` : playPath;

        log.info(`Loading JellyEmu game session: ${fullPlayUrl}`);

        // Wire modal action buttons
        const resumeBtn = this.$('#btn-emulator-resume');
        const exitBtn = this.$('#btn-emulator-exit');

        if (resumeBtn) {
            resumeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._hidePauseMenu();
            });
        }

        if (exitBtn) {
            exitBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._exitToDetails();
            });
        }

        // Register focus section for modal using the Page base class helper
        const pauseActionsEl = this.$('#emulator-pause-actions');
        if (pauseActionsEl) {
            this.registerFocusSection('emulator-pause-dialog', pauseActionsEl, {
                selector: '.emulator-hud-btn',
                defaultFocusSelector: '#btn-emulator-resume',
                orientation: 'vertical',
                onEnter: () => this.$('#btn-emulator-resume')
            });
        }

        // Listen for JellyEmu iframe messaging (e.g. exit button within game)
        this._onMessage = (event) => {
            if (event.data === 'close-jellyemu' || event.data?.type === 'jellyemu-session-end') {
                log.info('Received close signal from JellyEmu iframe:', event.data);
                this._exitToDetails();
            }
        };
        window.addEventListener('message', this._onMessage);

        // Set source and transfer focus to iframe
        if (this._iframe) {
            this._iframe.src = fullPlayUrl;
            this._iframe.onload = () => {
                log.info('Emulator session loaded in iframe.');
                this.markReady();
                this._focusIframe();
            };
        }

        // Hide splash if ready
        setTimeout(() => this.markReady(), 200);
    }

    /**
     * Focuses the iframe canvas so keyboard and connected gamepads immediately control the game.
     * @private
     */
    _focusIframe() {
        try {
            if (this._iframe && !this._isPauseMenuVisible) {
                this._iframe.focus();
            }
        } catch (e) {
            log.warn('Could not focus iframe directly (cross-origin constraint):', e);
        }
    }

    /**
     * Traps the TV Remote Back key.
     * Instead of killing the application or losing uncommitted save states immediately,
     * it reveals the sleek Apple TV-style pause modal.
     *
     * @returns {boolean} True if handled, preventing Router default navigation.
     */
    onBack() {
        if (this._isPauseMenuVisible) {
            // Second back press while pause menu is already visible dismisses the pause menu
            this._hidePauseMenu();
            return true;
        }

        // First back press opens the pause HUD
        this._showPauseMenu();
        return true;
    }

    /**
     * Displays the Apple TV-style translucent frosted HUD.
     * @private
     */
    _showPauseMenu() {
        this._isPauseMenuVisible = true;
        const overlay = this.$('#emulator-pause-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            requestAnimationFrame(() => {
                overlay.classList.add('visible');
            });
        }

        // Switch focus to the Resume button
        focusManager.setActiveSection('emulator-pause-dialog');
        const resumeBtn = this.$('#btn-emulator-resume');
        if (resumeBtn) {
            focusManager.focusElement(resumeBtn);
        }
    }

    /**
     * Hides the pause menu and returns input focus to the emulator session.
     * @private
     */
    _hidePauseMenu() {
        this._isPauseMenuVisible = false;
        const overlay = this.$('#emulator-pause-overlay');
        if (overlay) {
            overlay.classList.remove('visible');
            setTimeout(() => {
                if (!this._isPauseMenuVisible) {
                    overlay.classList.add('hidden');
                }
            }, 250);
        }

        this._focusIframe();
    }

    /**
     * Cleans up the emulator session and navigates back to the originating Details page.
     * @private
     */
    _exitToDetails() {
        log.info('Exiting emulator session and returning to details page.');
        if (this._iframe) {
            // Null out source to immediately terminate audio contexts and web workers
            this._iframe.src = 'about:blank';
        }

        focusManager.unregister('emulator-pause-dialog');

        if (this._itemId) {
            router.navigate(`/details/${this._itemId}`, { replace: true, isBack: true });
        } else {
            router.back();
        }
    }

    /**
     * Cleans up listeners and DOM elements on unmount.
     */
    onDestroy() {
        if (this._onMessage) {
            window.removeEventListener('message', this._onMessage);
            this._onMessage = null;
        }
        focusManager.unregister('emulator-pause-dialog');
        if (this._iframe) {
            this._iframe.src = 'about:blank';
            this._iframe = null;
        }
        super.onDestroy();
    }
}

export default EmulatorPage;
