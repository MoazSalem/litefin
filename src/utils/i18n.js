/**
 * ============================================================================
 * Litefin Tizen - Translation Manager (i18n)
 * Zero-dependency, low-memory dictionary mapper designed for Tizen TV hardware.
 * ============================================================================
 */

import { logger } from './Logger.js';

const log = logger.create('i18n');

class I18nManager {
    constructor() {
        this.dictionary = {};
        this.fallbackDictionary = {};
        this.currentLang = 'en-us';
        this.fallbackLang = 'en-us';
    }

    /**
     * Initializes the language manager.
     * @param {string} langCode - Language ('en', 'es', etc.)
     */
    async init(langCode = 'en') {
        this.currentLang = langCode;

        // Resolve path relative to the current location (handles file:// in Tizen)
        const basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
        const url = `${basePath}locales/${this.currentLang}.json`;

        log.info(`[i18n] Initializing with lang: ${this.currentLang}, url: ${url}`);

        try {
            // Lazy load the JSON mapping
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                this.dictionary = data;
                log.info(
                    `[i18n] Successfully loaded ${Object.keys(this.dictionary).length} keys for ${this.currentLang}`
                );
            } else {
                log.error(`[i18n] Failed to load locale file: ${response.status} ${response.statusText}`);
                throw new Error(`Failed to load ${this.currentLang}.json: ${response.status}`);
            }
        } catch (error) {
            log.error(`[i18n] Init failed, falling back to empty dict`, {
                url,
                lang: this.currentLang,
                error: error.message,
                stack: error.stack
            });
            // Fallback ensures t() just returns keys instead of crashing
            this.dictionary = {};
        }

        // Load fallback dictionary if necessary
        if (this.currentLang !== this.fallbackLang) {
            try {
                const fallbackUrl = `${basePath}locales/${this.fallbackLang}.json`;
                const fallbackResponse = await fetch(fallbackUrl);
                if (fallbackResponse.ok) {
                    this.fallbackDictionary = await fallbackResponse.json();
                    log.info(
                        `[i18n] Successfully loaded ${Object.keys(this.fallbackDictionary).length} keys for fallback (${this.fallbackLang})`
                    );
                } else {
                    log.error(`[i18n] Failed to load fallback locale file`);
                }
            } catch (error) {
                log.error(`[i18n] Failed to load fallback dictionary`, error);
                this.fallbackDictionary = {};
            }
        } else {
            // If language is already the fallback, point fallback to main dict to avoid double loading
            this.fallbackDictionary = this.dictionary;
        }
    }

    /**
     * Retrieves a translated string.
     * @param {string} key - Dictionary key
     * @param {string[]} [args] - Format arguments to replace {0}, {1} etc.
     * @returns {string} Translated string
     */
    t(key, args = []) {
        if (!key) return '';
        let str = this.dictionary[key];

        // Fallback to en-us.json if key missing
        if (str === undefined) {
            str = this.fallbackDictionary[key];
        }

        // Fallback to key itself if translation is missing (helps debugging)
        if (str === undefined) {
            return key;
        }

        // Apply string interpolation if args exist
        if (args.length > 0) {
            for (let i = 0; i < args.length; i++) {
                // Relies on simple string replacement for {0}, {1}, etc.
                str = str.replace(new RegExp(`\\{${i}\\}`, 'g'), args[i]);
            }
        }

        return str;
    }

    /**
     * High-speed DOM hydration.
     * Finds all elements with `data-i18n` and replaces their textContent or value.
     * Extremely fast since it bypasses JS template engine rebuilds.
     * @param {HTMLElement} root - The root container to scan
     */
    translateDOM(root) {
        if (!root) return;

        const elements = root.querySelectorAll('[data-i18n]');
        // Fast traditional loop for old webkits
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const key = el.getAttribute('data-i18n');
            const translation = this.t(key);

            // Check if it's an input/textarea placeholder vs normal text
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.placeholder = translation;
            } else {
                el.textContent = translation;
            }
        }
    }

    /**
     * Formats a Date object into a localized 12-hour time string with AM/PM.
     * @param {Date} date - The date to format
     * @returns {string} Formatted time string (e.g., "12:30 PM" or "12:30 م")
     */
    formatLocalTime(date) {
        if (!date || !(date instanceof Date)) return '';

        let hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? this.t('TimePM') : this.t('TimeAM');

        hours = hours % 12;
        hours = hours ? hours : 12; // The hour '0' should be '12'

        const minutesStr = minutes < 10 ? '0' + minutes : minutes;

        // Space before AM/PM for LTR, but maybe no space or different for Arabic?
        // Usually, in Arabic clocks, the AM/PM indicator "ص/م" follows the time.
        // We'll use a space for now as it's standard for 12-hour displays.
        return `${hours}:${minutesStr} ${ampm}`;
    }
}

// Singleton export
export const i18n = new I18nManager();
export default i18n;
