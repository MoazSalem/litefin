/**
 * src/plugins/installed/local-intros/index.js
 * ============================================================================
 * Litefin Plugin — Local Intros
 * ============================================================================
 * Supports the Jellyfin Local Intros plugin by fetching and prepending
 * pre-roll videos to the playback queue.
 *
 * This plugin hooks into the 'prepareItemPlayback' lifecycle stage to
 * check the server for eligible pre-rolls whenever a movie or episode
 * is about to start.
 * ============================================================================
 */

import './local-intros.css';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('LocalIntros');

export default {
    id: 'local-intros',
    serverDependency: 'local-intros',
    version: '1.0.0',
    description: 'Plays local intros before movies and episodes.',
    defaultEnabled: false,

    /**
     * @param {import('../../PluginAPI.js').default} api
     */
    async init(api) {
        log.info('Local Intros plugin initialized');
        this.api = api;
    },

    /**
     * Hook called before a new item starts playing.
     * This is where we inject intros into the queue.
     * @param {Object} item - The Jellyfin media item
     * @param {import('../../PluginAPI.js').default} api
     * @param {Object} context - Playback initiation context
     */
    async prepareItemPlayback(item, api, context = {}) {
        // Skip intro if the user is resuming playback from midway
        if (context.resumePosition && context.resumePosition > 0) {
            log.info('Skipping local intros on resume playback');
            return;
        }

        // Only trigger for Movies and Episodes
        if (item.Type !== 'Movie' && item.Type !== 'Episode') {
            return;
        }

        // Avoid infinite loop if we are already playing an intro
        if (item.isIntro) {
            return;
        }

        // Avoid infinite loop if we already injected intros for this item
        if (item._localIntrosInjected) {
            return;
        }

        try {
            // Set flag to prevent future re-injections when queue advances back to this item
            item._localIntrosInjected = true;

            log.info(`Checking for intros for: ${item.Name} (${item.Id})`);
            const introsResult = await api.getIntros(item.Id);

            if (introsResult && introsResult.Items && introsResult.Items.length > 0) {
                log.info(`Found ${introsResult.Items.length} intro(s) for item`);

                // Fetch full item details for each intro (PlayQueue needs full objects)
                const introItems = await Promise.all(introsResult.Items.map((intro) => api.getItem(intro.Id)));

                // Mark them as intros so we don't report progress to server
                introItems.forEach((i) => {
                    i.isIntro = true;
                    // Ensure they have a proper name for the OSD if missing
                    if (!i.Name) i.Name = api.t('LocalIntro');
                });

                // Inject the intro right at the current active queue position
                // so the player seamlessly transitions to it, leaving the rest of the queue intact.
                api.playQueue.injectPreRoll(introItems);
            }
        } catch (err) {
            log.error('Failed to prepare intros:', err);
        }
    },

    /**
     * Hook called when playback starts.
     * If playing an intro, we add the "Skip Intro" button to the OSD.
     * @param {Object} item - The currently playing item
     * @param {import('../../PluginAPI.js').default} api
     */
    onPlayerStart(item, api) {
        if (item.isIntro) {
            log.info('Playback started for intro item — adding skip widget');
            api.addOSDWidget(this._createSkipWidget(api));
        }
    },

    /**
     * Create the "Skip Intro" OSD button.
     * @param {import('../../PluginAPI.js').default} api
     * @returns {Object} Widget descriptor
     * @private
     */
    _createSkipWidget(api) {
        const label = api.t('SkipIntro');

        return {
            id: 'skip-button',

            /**
             * Renders a premium button that matches the Skip Intro plugin style.
             */
            render() {
                const container = document.createElement('div');
                container.className = 'plugin-widget local-intros-widget';
                container.innerHTML = `
                    <button class="osd-btn local-intros-btn" tabindex="0" aria-label="${label}">
                        <span class="local-intros-label">${label}</span>
                        <span class="local-intros-arrow">▶</span>
                    </button>
                `;
                return container;
            },

            // Always show while the intro item is active
            shouldShow() {
                return true;
            },

            /**
             * Jump to the next item in the queue.
             */
            onSelect() {
                log.info('User requested skip of pre-roll intro');
                api.playNext();

                // Snap focus away immediately so the button disappears from
                // the UI before the player fully transitions
                if (document.activeElement?.classList.contains('local-intros-btn')) {
                    document.activeElement.blur();
                }
            }
        };
    }
};
