/**
 * ============================================================================
 * Litefin Tizen - Settings Font & Culture Options Provider
 * ============================================================================
 * Centralized provider for localized culture metadata and dynamic font options.
 * Queries Jellyfin server for typography assets and internationalization cultures,
 * maintains in-memory caches, and merges server-provided fonts with bundled presets.
 * ============================================================================
 */

import { api } from '../../../api/index.js';
import FontLoader from '../../../utils/FontLoader.js';
import { getFallbackFontId, getFallbackFontName } from '../../../utils/FallbackFonts.js';
import { languageManager } from '../../../utils/LanguageManager.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('SettingsFontOptions');

/**
 * Control IDs for dropdown selectors that support dynamic server-provided fonts.
 */
export const SERVER_FONT_SELECTS = [
    'ui-font-select',
    'subtitle-font-select',
    'subtitle-font-ass-select',
    'jellyfin-fallback-font-select'
];

// Persistent cache for localized culture options across page lifecycles
let cachedCultures = null;

/**
 * Returns currently cached culture metadata, or null if uninitialized.
 * @returns {Array<Object>|null} Cached culture array
 */
export function getCachedCultures() {
    return cachedCultures;
}

/**
 * Sets or updates the in-memory culture cache.
 * @param {Array<Object>} cultures Normalized culture objects
 */
export function setCachedCultures(cultures) {
    cachedCultures = cultures;
}

/**
 * Fetches culture dictionaries from the Jellyfin server, registers mappings in
 * LanguageManager for O(1) lookups, formats Bidirectional display labels, and caches results.
 *
 * @returns {Promise<Array<Object>>} Normalized and alphabetically sorted culture options
 */
export async function loadCultureOptions() {
    if (cachedCultures) {
        return cachedCultures;
    }

    try {
        // Query server for supported internationalization cultures
        const cultures = await api.getCultures();
        if (cultures && Array.isArray(cultures)) {
            // Register culture codes with language manager for quick translation lookups
            languageManager.registerCultures(cultures);

            // Filter out regional dialects to retain only singular canonical languages
            const singularCultures = languageManager.filterSingularCultures(cultures);

            // Map each entry to standard dropdown option format with BiDi support
            cachedCultures = singularCultures
                .map((c) => ({
                    value: c.ThreeLetterISOLanguageName || c.Name,
                    label: i18n.ensureBiDi(c.DisplayName),
                    ThreeLetterISOLanguageName: c.ThreeLetterISOLanguageName,
                    TwoLetterISOLanguageName: c.TwoLetterISOLanguageName,
                    DisplayName: c.DisplayName
                }))
                .sort((a, b) => a.label.localeCompare(b.label));

            return cachedCultures;
        }
    } catch (error) {
        log.error('Failed to fetch server cultures:', error);
    }

    return [{ value: 'Default', label: i18n.t('Default') }];
}

/**
 * Merges server-hosted fallback fonts with bundled static font options.
 * Guarantees that saved custom fonts remain visible even prior to server response.
 *
 * @param {Array<Object>} fallbackFonts Server fallback font records
 * @param {string} id Select dropdown control ID
 * @param {Array<Object>} options Bundled static dropdown options
 * @param {string} currentValue Currently configured font identifier
 * @returns {Array<Object>} Combined and properly sequenced font option objects
 */
export function getFontDropdownOptions(fallbackFonts, id, options, currentValue) {
    const isFileSelect = id === 'jellyfin-fallback-font-select';
    if (!SERVER_FONT_SELECTS.includes(id)) {
        return options;
    }

    // Map discovered server font objects to standard option structures
    const fontOptions = (fallbackFonts || []).map((font) => ({
        value: isFileSelect ? font.Name : getFallbackFontId(font.Name),
        label: font.Name
    }));

    // Retain saved custom or offline font value in options list
    const savedName = isFileSelect ? currentValue : getFallbackFontName(currentValue);
    if (savedName && !fontOptions.some((option) => option.label === savedName)) {
        fontOptions.push({ value: currentValue, label: savedName });
    }

    // Filter out previously injected server fonts from bundled option set
    const bundledOptions = isFileSelect ? [] : options.filter((option) => !getFallbackFontName(option.value));
    const fallbackIndex = bundledOptions.findIndex((option) => option.value === 'fallback-font');

    // Splice server fonts immediately after the fallback separator if present
    if (fallbackIndex >= 0) {
        bundledOptions.splice(fallbackIndex + 1, 0, ...fontOptions);
        return bundledOptions;
    }

    return [...bundledOptions, ...fontOptions];
}

/**
 * Queries server fallback fonts and synchronizes rendered select button labels in DOM.
 *
 * @param {Object} page Host SettingsPage instance
 * @returns {Promise<Array<Object>>} Resolved font records
 */
export async function loadFallbackFontOptions(page) {
    try {
        // Query server for font assets through FontLoader utility
        const fonts = await FontLoader.getFallbackFonts();
        if (page) {
            page._fallbackFonts = fonts;

            // Update any mounted dropdown buttons with fresh font list
            const buttons = page.$$ ? page.$$('.select-btn') : [];
            buttons.forEach((btn) => {
                const id = btn.dataset.id;
                if (!SERVER_FONT_SELECTS.includes(id)) return;

                let currentOptions = [];
                try {
                    currentOptions = JSON.parse(btn.dataset.options);
                } catch (_) {}

                const updated = getFontDropdownOptions(fonts, id, currentOptions, btn.dataset.value);
                btn.dataset.options = JSON.stringify(updated);

                // Update visual label for currently selected option
                const selected = updated.find((option) => String(option.value) === String(btn.dataset.value));
                const label = btn.querySelector('.btn-label');
                if (selected && label) {
                    label.innerText = i18n.ensureBiDi(selected.label);
                }
            });
        }
        return fonts;
    } catch (err) {
        log.warn('Failed to load fallback font options from server:', err);
        return [];
    }
}
