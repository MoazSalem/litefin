/**
 * ============================================================================
 * Litefin Tizen - Settings Dropdown Async Options Resolver
 * ============================================================================
 * Handles asynchronous population of dynamic options for specialized dropdowns
 * such as Watch Provider country regions, boxset collections for trending rows,
 * and server-hosted fallback fonts.
 * ============================================================================
 */

import { api } from '../../../api/index.js';
import { toast } from '../../../ui/Toast.js';
import { i18n } from '../../../utils/i18n.js';
import { watchProviderRegionName } from '../../../utils/WatchProviders.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('SettingsDropdownAsyncOptions');

export const SERVER_FONT_SELECTS = [
    'ui-font-select',
    'subtitle-font-select',
    'subtitle-font-ass-select',
    'jellyfin-fallback-font-select'
];

/**
 * Resolves asynchronous option lists for dropdown selectors upon user interaction.
 *
 * @param {Object} page Host SettingsPage instance
 * @param {string} id Selector control identifier
 * @param {HTMLElement} btn Target dropdown trigger button element
 * @param {Array<Object>} options Currently parsed or cached options
 * @param {string} currentValue Currently selected value
 * @returns {Promise<Array<Object>>} Resolved array of option objects
 */
export async function resolveAsyncDropdownOptions(page, id, btn, options, currentValue) {
    // 1. Streaming Availability / Watch Provider Localization Countries
    if (id === 'watch-provider-region-select') {
        btn.classList.add('disabled');
        try {
            // Query server for supported ISO country codes
            const countries = await api.get('/Localization/Countries');
            const loaded = countries
                .filter((c) => c && /^[A-Z]{2}$/.test(c.TwoLetterISORegionName))
                .map((c) => ({
                    value: c.TwoLetterISORegionName,
                    label: watchProviderRegionName(c.TwoLetterISORegionName, i18n.currentLang)
                }))
                .sort((a, b) => a.label.localeCompare(b.label));

            // Guard against empty server responses
            if (!loaded.length) throw new Error('No countries returned');

            // Cache serialized options on button dataset
            btn.dataset.options = JSON.stringify(loaded);
            return loaded;
        } catch (err) {
            log.warn('Unable to load streaming availability countries', err);
            toast.error(i18n.t('WatchProvidersCountriesError'));
            return options;
        } finally {
            btn.classList.remove('disabled');
        }
    }

    // 2. Trending Movies / Series Custom BoxSet & Playlist Collections
    if (id === 'trending-movies-collection-select' || id === 'trending-series-collection-select') {
        btn.classList.add('disabled');
        try {
            // Query library items of type BoxSet or Playlist
            const collectionsRes = await api.getItems({
                IncludeItemTypes: 'BoxSet,Playlist',
                Recursive: true,
                EnableTotalRecordCount: false
            });
            const collections = collectionsRes?.Items || [];

            // Prepend system options (Disabled, Auto, Community Rating)
            const loaded = [
                { value: 'none', label: i18n.t('Disabled') || 'Disabled' },
                { value: 'auto', label: i18n.t('Auto') || 'Auto' },
                { value: 'top-rated', label: i18n.t('CommunityRating') || 'Community Rating' },
                ...collections.map((c) => ({ value: c.Id, label: c.Name }))
            ];

            btn.dataset.options = JSON.stringify(loaded);
            return loaded;
        } catch (err) {
            log.warn('Failed to load collections for trending selector:', err);
            return options;
        } finally {
            btn.classList.remove('disabled');
        }
    }

    // 3. Server Fallback & Custom Typography Fonts
    if (SERVER_FONT_SELECTS.includes(id)) {
        btn.classList.add('disabled');
        try {
            // Ensure fallback font list has been queried and populated
            if (typeof page._loadFallbackFontOptions === 'function') {
                await page._loadFallbackFontOptions();
            }
            if (typeof page._getFontDropdownOptions === 'function') {
                const loaded = page._getFontDropdownOptions(id, options, currentValue);
                btn.dataset.options = JSON.stringify(loaded);
                return loaded;
            }
        } catch (err) {
            log.warn('Failed to load fallback fonts list on click:', err);
        } finally {
            btn.classList.remove('disabled');
        }
    }

    return options;
}
