/**
 * ============================================================================
 * Litefin Tizen - Home Screen Sections
 * ============================================================================
 *
 * Loads the sections configured in the Home Screen Sections server plugin
 * (IAmParadox27/jellyfin-plugin-home-sections) and turns them into Home row
 * descriptors. The API calls and the Seerr availability check are injected by
 * HomePage, so this module stays testable without the app runtime.
 *
 * Endpoints (all need an authenticated user, admin rights are not required):
 *   GET /HomeScreen/Meta                     → { Enabled, ... } (404 = not installed)
 *   GET /HomeScreen/Sections?UserId&Language → every section at once when no page is given
 *   GET /HomeScreen/Section/{type}?UserId&AdditionalData&Language → QueryResult<BaseItemDto>
 * ============================================================================
 */

import {
    HSS_SECTIONS_STORAGE_KEY,
    assignSlotIds,
    filterSections,
    mapSectionItems,
    viewModeToLayout
} from './HomeScreenSectionsMapper.js';

/** Id of the bundled plugin entry shown in Settings → Plugins. */
export const HSS_PLUGIN_ID = 'home-screen-sections';

/**
 * Whether the user enabled the Home Screen Sections plugin in Settings → Plugins.
 *
 * Reads the preference PluginManager persists (`plugin:enabled:<id>`) instead of
 * asking PluginManager: plugins only initialize after the splash screen, so on a
 * cold boot `pluginManager.isEnabled()` is still false while Home builds its rows.
 * Whether the server plugin exists is handled by the provider (404 → no rows).
 *
 * @param {{ getItem: Function }} storage
 * @returns {boolean}
 */
export function isHomeScreenSectionsEnabled(storage) {
    return storage.getItem(`plugin:enabled:${HSS_PLUGIN_ID}`) === 'true';
}

/**
 * @param {Object} deps
 * @param {(endpoint: string, params?: Object) => Promise<any>} deps.getJson - Authenticated GET
 * @param {string} deps.serverUrl - Base URL used to resolve relative plugin image URLs
 * @param {string} deps.userId
 * @param {string} deps.language - UI language passed on so the plugin translates titles
 * @param {() => Promise<boolean>} deps.isSeerrAvailable - Whether Seerr is usable in Litefin
 * @param {(msg: string, err?: any) => void} [deps.onError] - Unexpected failures
 * @param {(msg: string, err?: any) => void} [deps.onDebug] - Expected failures (e.g. a section without data)
 */
export function createHomeScreenSectionsProvider({
    getJson,
    serverUrl,
    userId,
    language,
    isSeerrAvailable,
    onError = () => {},
    onDebug = () => {}
}) {
    let sectionsPromise = null;

    const seerrAvailable = async () => {
        try {
            return !!(await isSeerrAvailable());
        } catch (err) {
            onDebug('Home Screen Sections: Seerr availability check failed', err);
            return false;
        }
    };

    const fetchSections = async () => {
        let meta = null;
        try {
            meta = await getJson('/HomeScreen/Meta');
        } catch (err) {
            // 404 means the server plugin is not installed: no rows, no error
            if (err && err.status === 404) {
                onDebug('Home Screen Sections: server plugin not installed');
                return [];
            }
            throw err;
        }
        if (!meta || meta.Enabled === false) return [];

        const [response, seerr] = await Promise.all([
            getJson('/HomeScreen/Sections', { UserId: userId, Language: language }),
            seerrAvailable()
        ]);
        return assignSlotIds(filterSections(response && response.Items, { seerrAvailable: seerr }));
    };

    /**
     * Loads the section list once per provider. A failure resets the cached
     * promise so the next Home load can try again.
     * @returns {Promise<Array<Object>>} Records from assignSlotIds()
     */
    const loadSections = () => {
        if (!sectionsPromise) {
            sectionsPromise = fetchSections().catch((err) => {
                sectionsPromise = null;
                onError('Home Screen Sections: loading sections failed', err);
                return [];
            });
        }
        return sectionsPromise;
    };

    /**
     * Builds one Home row descriptor per section. Each fetchFn catches its own
     * errors and resolves to null, so a broken section (for example Discover
     * without Jellyseerr configured on the server) just leaves its row out.
     *
     * @param {Array<Object>} sections - Records from loadSections()
     * @param {number} homeRowLimit
     * @returns {Array<Object>} Row descriptors
     */
    const buildDescriptors = (sections, homeRowLimit) => {
        if (!Array.isArray(sections)) return [];
        return sections.map((section) => {
            const { layout, cardType } = viewModeToLayout(section.viewMode);
            return {
                id: section.id,
                title: section.title,
                priority: 2,
                layout,
                cardType,
                contextType: 'hss',
                fetchFn: async () => {
                    try {
                        const res = await getJson(`/HomeScreen/Section/${encodeURIComponent(section.section)}`, {
                            UserId: userId,
                            AdditionalData: section.additionalData,
                            Language: language
                        });
                        const items = mapSectionItems(section, res && res.Items, { serverUrl, limit: homeRowLimit });
                        return items.length > 0 ? items : null;
                    } catch (err) {
                        onDebug(`Home Screen Sections: section ${section.id} failed`, err);
                        return null;
                    }
                }
            };
        });
    };

    return { loadSections, buildDescriptors };
}

/**
 * Stores the section list ({ id, title } per row) for the Home layout editor,
 * which has to list the rows without calling the server.
 * @param {{ setItem: Function }} storage
 * @param {Array<Object>} sections
 */
export function saveSectionList(storage, sections) {
    try {
        const list = (sections || []).map((s) => ({ id: s.id, title: s.title }));
        storage.setItem(HSS_SECTIONS_STORAGE_KEY, JSON.stringify(list));
    } catch (_) {}
}

/**
 * @param {{ getItem: Function }} storage
 * @returns {Array<{id: string, title: string}>}
 */
export function readSectionList(storage) {
    try {
        const list = JSON.parse(storage.getItem(HSS_SECTIONS_STORAGE_KEY) || '[]');
        return Array.isArray(list) ? list.filter((s) => s && s.id) : [];
    } catch (_) {
        return [];
    }
}
