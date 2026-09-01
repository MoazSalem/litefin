/**
 * ============================================================================
 * Litefin Tizen - SidebarLayoutManager
 * ============================================================================
 * Manages the user's sidebar customization preferences: item order, item
 * visibility, and the default focus target.
 *
 * The data is persisted in localStorage under `pref:sidebarLayout` as JSON.
 *
 * Mirrors the HomeLayoutManager pattern so the Settings UI can reuse the
 * same layout-row component and interaction logic.
 * ============================================================================
 */

import { storage } from './StorageService.js';
import { logger } from './Logger.js';
import { layoutManager } from '../ui/LayoutManager.js';

const log = logger.create('SidebarLayoutManager');

/**
 * The canonical ordered list of static sidebar items for Classic layout.
 * Order: user, home, discover, favorites, search, random, syncplay, livetv, settings, librariesContainer
 */
const CLASSIC_STATIC_ITEMS = [
    /* User Profile */
    { id: 'user', label: 'User Profile' },
    /* Core navigation items */
    { id: 'home', label: 'Home' },
    { id: 'discover', label: 'SeerrDiscover' },
    { id: 'favorites', label: 'Favorites' },
    { id: 'search', label: 'Search' },
    { id: 'random', label: 'Random' },
    { id: 'syncplay', label: 'SyncPlay' },
    { id: 'livetv', label: 'Live TV', hidden: true },
    { id: 'settings', label: 'Settings' },
    { id: 'librariesContainer', label: 'Libraries' }
];

/**
 * The canonical ordered list of static sidebar items for Modern layout.
 * Order: home, discover, favorites, search, random, syncplay, livetv, librariesContainer, settings
 * Note: 'user' is pinned in the bottom footer and excluded from the re-orderable list.
 */
const MODERN_STATIC_ITEMS = [
    { id: 'home', label: 'Home' },
    { id: 'discover', label: 'SeerrDiscover' },
    { id: 'favorites', label: 'Favorites' },
    { id: 'search', label: 'Search' },
    { id: 'random', label: 'Random' },
    { id: 'syncplay', label: 'SyncPlay' },
    { id: 'livetv', label: 'Live TV', hidden: true },
    { id: 'librariesContainer', label: 'Libraries' },
    { id: 'settings', label: 'Settings' }
];

/**
 * The storage key used to persist sidebar layout data.
 */
const STORAGE_KEY = 'pref:sidebarLayout';

class SidebarLayoutManager {
    /**
     * Determines whether an item is locked (cannot be hidden) for current layout mode.
     * In Modern mode, only 'home' and 'settings' are locked (allowing 'librariesContainer' to be hidden).
     * In Classic mode, 'home', 'settings', 'user', and 'librariesContainer' remain locked.
     * @param {string} id
     * @returns {boolean}
     */
    isItemLocked(id) {
        const isModern = !layoutManager.isClassicSidebarLayout();
        if (isModern) {
            return id === 'home' || id === 'settings';
        }
        return ['home', 'settings', 'user', 'librariesContainer'].includes(id);
    }

    /**
     * Returns the layout-specific storage key based on current layout mode.
     * @returns {string}
     */
    getStorageKey() {
        const isModern = !layoutManager.isClassicSidebarLayout();
        return isModern ? 'pref:sidebarLayout_modern' : 'pref:sidebarLayout_classic';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Persistence helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Reads the full saved config from storage for current layout mode.
     * @returns {{ items: Array<{id: string, hidden: boolean, order: number}>, libraryItems: Array<{id: string, hidden: boolean, order: number}>, defaultFocus: string }|null}
     */
    getSavedConfig() {
        const key = this.getStorageKey();
        let raw = storage.getItem(key);
        // Fallback for legacy key if the specific classic one doesn't exist yet
        if (!raw && layoutManager.isClassicSidebarLayout()) {
            raw = storage.getItem(STORAGE_KEY);
        }
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            log.error('Failed to parse saved sidebar layout', e);
            return null;
        }
    }

    /**
     * Persists a new config. Re-stamps `order` values from array indices before saving.
     */
    saveConfig(config) {
        if (config.items) {
            config.items.forEach((item, index) => (item.order = index));
        }
        if (config.libraryItems) {
            config.libraryItems.forEach((item, index) => (item.order = index));
        }
        const key = this.getStorageKey();
        storage.setItem(key, JSON.stringify(config));
        log.info(`Sidebar layout saved for key: ${key}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public getters
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the ID of the item that should receive focus when the user
     * navigates into the sidebar. Falls back to 'home' if nothing is saved.
     * @returns {string}
     */
    getDefaultFocus() {
        const config = this.getSavedConfig();
        return config && config.defaultFocus ? config.defaultFocus : 'home';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Layout application (used by Sidebar.js)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Takes the full set of live sidebar items and returns them correctly interleaved
     * based on the separate layout configs.
     * @param {Array<{id: string, el: HTMLElement}>} liveItems
     */
    applyLayout(liveItems) {
        const config = this.getSavedConfig();

        const staticItems = liveItems.filter((i) => !i.id.startsWith('lib-') && i.id !== 'section-header');
        const libraryItems = liveItems.filter((i) => i.id.startsWith('lib-'));
        const headerItem = liveItems.find((i) => i.id === 'section-header');

        // Introduce the proxy virtual group block into the static items if it doesn't physically exist
        // so that the _applyOrder pass can locate and position it.
        if (!staticItems.find((i) => i.id === 'librariesContainer')) {
            staticItems.push({ id: 'librariesContainer', el: null, virtual: true });
        }

        // Build a fallback config from static items so the initial unsaved layout matches the canonical order
        const staticList = this.getStaticItems();
        const fallbackConfig = staticList.map((item, index) => ({
            id: item.id,
            hidden: item.hidden || false,
            order: index
        }));
        const orderedStatic = this._applyOrder(staticItems, config && config.items ? config.items : fallbackConfig);
        const orderedLibs = this._applyOrder(libraryItems, config ? config.libraryItems : null);

        const result = [];
        const hideHeader = storage.getItem('pref:hideSidebarLibraryHeader') === 'true';
        orderedStatic.forEach((item) => {
            if (item.id === 'librariesContainer') {
                // If it's a physical element (e.g. Modern layout #sidebar-libraries), preserve its position in the list
                if (!item.virtual && item.el) {
                    result.push(item);
                }
                if (headerItem && orderedLibs.length > 0 && !hideHeader) {
                    result.push({ ...headerItem, hidden: false });
                }
                // Even if "librariesContainer" was somehow marked hidden, we respect its children's own hide states
                orderedLibs.forEach((lib) => result.push(lib));
            } else if (!item.virtual) {
                result.push(item);
            }
        });

        return result;
    }

    /**
     * Internal helper to apply a saved config subset to a live array subset.
     */
    _applyOrder(liveSubset, savedConfigList) {
        if (!savedConfigList || savedConfigList.length === 0) {
            return liveSubset.map((item) => ({ ...item, hidden: false }));
        }

        const savedMap = new Map(savedConfigList.map((item) => [item.id, item]));
        const positioned = [];
        const newItems = [];

        for (const liveItem of liveSubset) {
            const saved = savedMap.get(liveItem.id);
            if (saved) {
                const forceVisible = this.isItemLocked(liveItem.id);
                positioned.push({
                    ...liveItem,
                    hidden: forceVisible ? false : saved.hidden || false,
                    _order: saved.order
                });
            } else {
                newItems.push({ ...liveItem, hidden: false });
            }
        }

        positioned.sort((a, b) => a._order - b._order);
        return [...positioned.map(({ _order, ...rest }) => rest), ...newItems];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Settings UI helper (used by SettingsPage.js)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Builds the full ordered list used by the Settings UI.
     * Merges the saved layout with the live item set so:
     *   - Saved positions and hidden states are respected.
     *   - Items that were deleted from the server (libraries removed) are
     *     silently dropped.
     *   - Newly added items appear at the end with default visible state.
     *
     * @param {Array<{id: string, label: string}>} liveItems
     *   Flat list of all current sidebar items (static + loaded libraries).
     * @returns {Array<{id: string, label: string, hidden: boolean, locked: boolean, order: number}>}
     */
    buildSettingsLayout(liveItems) {
        const isModern = !layoutManager.isClassicSidebarLayout();
        const filteredLiveItems = isModern ? liveItems.filter((i) => i.id !== 'user') : liveItems;

        const config = this.getSavedConfig();
        const savedItems = config ? config.items || [] : [];
        const savedMap = new Map(savedItems.map((item) => [item.id, item]));

        const result = [];
        let nextOrder = 0;

        /*
         * First pass: iterate the saved order and include items that are
         * still live. This preserves the user's custom sort.
         */
        for (const saved of savedItems) {
            if (isModern && saved.id === 'user') continue;
            const live = filteredLiveItems.find((i) => i.id === saved.id);
            if (live) {
                const locked = this.isItemLocked(saved.id);
                result.push({
                    id: live.id,
                    label: live.label, // Use fresh label in case it was renamed
                    hidden: locked ? false : saved.hidden || false,
                    locked: locked,
                    order: nextOrder++
                });
            }
        }

        /*
         * Second pass: append live items that aren't in the saved layout yet.
         * This handles newly added libraries without requiring a manual refresh.
         */
        for (const live of filteredLiveItems) {
            if (isModern && live.id === 'user') continue;
            if (!savedMap.has(live.id)) {
                const locked = this.isItemLocked(live.id);
                result.push({
                    id: live.id,
                    label: live.label,
                    hidden: live.hidden || false,
                    locked: locked,
                    order: nextOrder++
                });
            }
        }

        return result;
    }

    /**
     * Builds the ordered list for individual libraries used by Settings UI.
     */
    buildLibrarySettingsLayout(liveLibraries) {
        const config = this.getSavedConfig();
        const savedItems = config ? config.libraryItems || [] : [];
        const savedMap = new Map(savedItems.map((item) => [item.id, item]));

        const result = [];
        let nextOrder = 0;

        for (const saved of savedItems) {
            const live = liveLibraries.find((i) => i.id === saved.id);
            if (live) {
                result.push({
                    id: live.id,
                    label: live.label,
                    hidden: saved.hidden || false,
                    locked: false,
                    order: nextOrder++
                });
            }
        }

        for (const live of liveLibraries) {
            if (!savedMap.has(live.id)) {
                result.push({
                    id: live.id,
                    label: live.label,
                    hidden: false,
                    locked: false,
                    order: nextOrder++
                });
            }
        }

        return result;
    }

    /**
     * Returns the default static items list based on current layout mode.
     * Used by the Settings UI to build the full live item set before merging.
     * @returns {Array<{id: string, label: string}>}
     */
    getStaticItems() {
        const isModern = !layoutManager.isClassicSidebarLayout();
        return isModern ? MODERN_STATIC_ITEMS : CLASSIC_STATIC_ITEMS;
    }
}

export const sidebarLayoutManager = new SidebarLayoutManager();
