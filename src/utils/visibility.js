/**
 * ============================================================================
 * Litefin Tizen - Visibility Helpers
 * ============================================================================
 * Shared logic for determining visibility of UI elements based on user
 * preferences and item state.
 * ============================================================================
 */

import { storage } from './StorageService.js';

/**
 * Determines if community/critic scores should be visible for a given item.
 * 
 * @param {Object} item - The Jellyfin media item.
 * @returns {boolean}
 */
export function shouldShowScore(item) {
    // Mode: 'all', 'mystery', 'watched'
    const mode = storage.getItem('pref:scoreVisibility') || 'all';

    if (mode === 'mystery') {
        return false;
    }

    if (mode === 'watched') {
        // UserData is typically present on items from library/home queries
        const played = item.UserData && item.UserData.Played;
        return !!played;
    }

    // Default to 'all'
    return true;
}
