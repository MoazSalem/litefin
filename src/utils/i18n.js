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
     * Fetches a local JSON file using XMLHttpRequest.
     *
     * WHY NOT fetch():
     * WebOS (all versions) blocks fetch() for file:// URLs due to its WebView
     * security model, even for files within the same app package. XHR does NOT
     * have this restriction and is the safe cross-platform way to load local
     * assets on both Tizen AND WebOS.
     *
     * @param {string} url - The URL to load
     * @returns {Promise<Object>} Parsed JSON data
     */
    _loadJson(url) {
        return new Promise(function (resolve, reject) {
            const xhr = new XMLHttpRequest();

            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;

                /*
                 * On file:// protocol, a successful local XHR returns status 0
                 * (not 200) because there is no HTTP server. We treat status 0
                 * or 200 as success to cover both packaged-app and dev-server
                 * scenarios.
                 */
                if (xhr.status === 200 || xhr.status === 0) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(new Error('JSON parse error: ' + e.message));
                    }
                } else {
                    reject(new Error('XHR failed with status ' + xhr.status));
                }
            };

            xhr.onerror = function () {
                reject(new Error('XHR network error loading: ' + url));
            };

            // Synchronous=false: async XHR, won't block the TV's single UI thread
            xhr.open('GET', url, true);
            xhr.send();
        });
    }

    /**
     * Resolves the base URL for locale files.
     *
     * Uses window.location.href (not pathname) so the resulting URL is always
     * an absolute URL (e.g. file:///media/.../index.html → file:///media/.../locales/).
     * Using a relative URL built from an absolute base avoids the XHR treating
     * the path as relative to a non-existent HTTP root on WebOS.
     *
     * @param {string} lang - BCP-47 language tag
     * @returns {string} Absolute URL to the locale JSON file
     */
    _localeUrl(lang) {
        /*
         * WHY origin + pathname instead of href:
         *
         * On a hash-router web dev server the full href looks like:
         *   http://192.168.1.24:8081/#/settings
         *
         * Calling lastIndexOf('/') on that hits the slash INSIDE '#/' and the
         * base becomes 'http://192.168.1.24:8081/#/' — making the locale URL a
         * fragment (#/locales/...) rather than a real HTTP path, which causes
         * an immediate XHR 404 / network error.
         *
         * window.location.origin + window.location.pathname gives:
         *   http://192.168.1.24:8081/index.html
         * which we then strip to:
         *   http://192.168.1.24:8081/
         *
         * For packaged Tizen/WebOS file:// apps pathname is the full path to
         * index.html — the same lastIndexOf('/') trick works identically.
         */
        const pageUrl = window.location.origin + window.location.pathname;
        const base = pageUrl.substring(0, pageUrl.lastIndexOf('/') + 1);
        return base + 'locales/' + lang + '.json';
    }

    /**
     * Initializes the language manager.
     * @param {string} langCode - Language ('en-us', 'es', etc.)
     */
    async init(langCode = 'en') {
        this.currentLang = langCode;
        this.isRTL = langCode === 'ar' || langCode === 'he' || langCode === 'fa';

        const url = this._localeUrl(this.currentLang);
        log.info(`[i18n] Initializing with lang: ${this.currentLang}, url: ${url}`);

        try {
            // Use XHR instead of fetch() — works on both Tizen and WebOS file:// contexts
            const data = await this._loadJson(url);
            this.dictionary = data;
            log.info(`[i18n] Successfully loaded ${Object.keys(this.dictionary).length} keys for ${this.currentLang}`);
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
                const fallbackUrl = this._localeUrl(this.fallbackLang);
                const data = await this._loadJson(fallbackUrl);
                this.fallbackDictionary = data;
                log.info(
                    `[i18n] Successfully loaded ${Object.keys(this.fallbackDictionary).length} keys for fallback (${this.fallbackLang})`
                );
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

        // Apply regular interpolation
        if (args.length > 0) {
            for (let i = 0; i < args.length; i++) {
                str = str.replace(new RegExp(`\\{${i}\\}`, 'g'), args[i]);
            }
        }

        // Apply BiDi/Parentheses fix for RTL (Tizen/BiDi mirroring bug)
        return this.ensureBiDi(str);
    }

    /**
     * Ensures correct BiDi rendering for strings containing parentheses in RTL mode.
     * Uses LRE (Left-to-Right Embedding) and LRM hints to force correct mirroring.
     * @param {string} str - String to fix
     * @returns {string} Fixed string
     */
    ensureBiDi(str) {
        if (!this.isRTL || !str) return str;

        // If it contains parentheses, we need to be extra careful with BiDi mirroring on TV browsers.
        if (str.includes('(') || str.includes(')')) {
            // 1. Wrap each parenthesis with LRM (\u200E) to hint its directionality to the engine.
            const punctuated = str.replace(/\(/g, '\u200E(').replace(/\)/g, ')\u200E');

            // 2. Wrap the entire string in LRE (\u202A) and PDF (\u202C) to isolate the LTR run.
            return `\u202A${punctuated}\u202C`;
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
