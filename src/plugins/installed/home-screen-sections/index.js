/**
 * ============================================================================
 * Litefin Tizen - Home Screen Sections Plugin
 * ============================================================================
 * Settings → Plugins entry for the Home Screen Sections server plugin
 * (IAmParadox27/jellyfin-plugin-home-sections). Enabling it adds the rows
 * configured on the server to the Home screen.
 *
 * The rows themselves are built by HomePage via utils/HomeScreenSections.js.
 * HomePage reads the persisted `plugin:enabled:home-screen-sections` preference
 * directly, because plugins only initialize after the splash screen and Home
 * builds its rows before that on a cold boot.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import { HSS_PLUGIN_ID, readSectionList, saveSectionList } from '../../../utils/HomeScreenSections.js';
import { createAppHomeScreenSectionsProvider } from '../../../utils/HomeScreenSectionsRuntime.js';

export default {
    id: HSS_PLUGIN_ID,
    name: 'Home Screen Sections',
    version: '1.0.0',
    serverDependency: 'home-screen-sections',
    defaultEnabled: false,

    /** Localized description shown in Settings → Plugins. */
    get description() {
        return i18n.t('HomeScreenSectionsDescription');
    },

    async init(api) {
        // When the plugin was just switched on, Home has not loaded the sections
        // yet. Load them in the background so the Home layout editor lists the
        // rows right away. On later boots Home keeps the list up to date.
        if (readSectionList(storage).length > 0) return;
        createAppHomeScreenSectionsProvider()
            .loadSections()
            .then((sections) => saveSectionList(storage, sections))
            .catch((err) => api.log.warn('Could not preload Home Screen Sections', err));
    },

    destroy() {}
};
