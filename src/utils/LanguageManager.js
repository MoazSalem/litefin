/**
 * ============================================================================
 * Litefin Tizen - Language Manager
 * ============================================================================
 * Centralized utility for managing favorite languages and language matching
 * across the application. Provides bidirectional mapping between ISO 639-1
 * (2-letter), ISO 639-2 (3-letter), locale strings, and display names.
 *
 * Allows users to filter long language lists (UI language, preferred audio/sub,
 * subtitle search, and in-player track selection) to their preferred languages.
 * ============================================================================
 */

import { storage } from './StorageService.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from './Logger.js';

// Initialize logger for LanguageManager
const log = logger.create('LanguageManager');

// Storage key used for persisting favorite languages
const FAVORITES_STORAGE_KEY = 'pref:favoriteLanguages';

/**
 * Common language dictionary for standard ISO 639-1 (2-letter) to ISO 639-2 (3-letter)
 * and display name mappings. Covers top world languages and standard Jellyfin cultures.
 */
const COMMON_LANGUAGES = [
    { code: 'eng', twoLetter: 'en', name: 'English', nativeName: 'English' },
    { code: 'spa', twoLetter: 'es', name: 'Spanish', nativeName: 'Español' },
    { code: 'fra', twoLetter: 'fr', name: 'French', nativeName: 'Français', altCodes: ['fre'] },
    { code: 'deu', twoLetter: 'de', name: 'German', nativeName: 'Deutsch', altCodes: ['ger'] },
    { code: 'ita', twoLetter: 'it', name: 'Italian', nativeName: 'Italiano' },
    { code: 'por', twoLetter: 'pt', name: 'Portuguese', nativeName: 'Português' },
    { code: 'ara', twoLetter: 'ar', name: 'Arabic', nativeName: 'العربية' },
    { code: 'jpn', twoLetter: 'ja', name: 'Japanese', nativeName: '日本語' },
    { code: 'zho', twoLetter: 'zh', name: 'Chinese', nativeName: '中文', altCodes: ['chi'] },
    { code: 'kor', twoLetter: 'ko', name: 'Korean', nativeName: '한국어' },
    { code: 'rus', twoLetter: 'ru', name: 'Russian', nativeName: 'Русский' },
    { code: 'hin', twoLetter: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
    { code: 'nld', twoLetter: 'nl', name: 'Dutch', nativeName: 'Nederlands', altCodes: ['dut'] },
    { code: 'pol', twoLetter: 'pl', name: 'Polish', nativeName: 'Polski' },
    { code: 'tur', twoLetter: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
    { code: 'swe', twoLetter: 'sv', name: 'Swedish', nativeName: 'Svenska' },
    { code: 'nor', twoLetter: 'no', name: 'Norwegian', nativeName: 'Norsk', altCodes: ['nob', 'nno'] },
    { code: 'dan', twoLetter: 'da', name: 'Danish', nativeName: 'Dansk' },
    { code: 'fin', twoLetter: 'fi', name: 'Finnish', nativeName: 'Suomi' },
    { code: 'ell', twoLetter: 'el', name: 'Greek', nativeName: 'Ελληνικά', altCodes: ['gre'] },
    { code: 'ces', twoLetter: 'cs', name: 'Czech', nativeName: 'Čeština', altCodes: ['cze'] },
    { code: 'hun', twoLetter: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
    { code: 'ron', twoLetter: 'ro', name: 'Romanian', nativeName: 'Română', altCodes: ['rum'] },
    { code: 'ukr', twoLetter: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
    { code: 'heb', twoLetter: 'he', name: 'Hebrew', nativeName: 'עברית' },
    { code: 'tha', twoLetter: 'th', name: 'Thai', nativeName: 'ไทย' },
    { code: 'vie', twoLetter: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
    { code: 'ind', twoLetter: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
    { code: 'msa', twoLetter: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', altCodes: ['may'] },
    { code: 'fil', twoLetter: 'tl', name: 'Filipino / Tagalog', nativeName: 'Tagalog' },
    { code: 'fas', twoLetter: 'fa', name: 'Persian', nativeName: 'فارسی', altCodes: ['per'] },
    { code: 'urd', twoLetter: 'ur', name: 'Urdu', nativeName: 'اردو' },
    { code: 'ben', twoLetter: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
    { code: 'tam', twoLetter: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
    { code: 'tel', twoLetter: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
    { code: 'cat', twoLetter: 'ca', name: 'Catalan', nativeName: 'Català' },
    { code: 'hrv', twoLetter: 'hr', name: 'Croatian', nativeName: 'Hrvatski', altCodes: ['scr'] },
    { code: 'srp', twoLetter: 'sr', name: 'Serbian', nativeName: 'Српски', altCodes: ['scc'] },
    { code: 'slv', twoLetter: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
    { code: 'slk', twoLetter: 'sk', name: 'Slovak', nativeName: 'Slovenčina', altCodes: ['slo'] },
    { code: 'bul', twoLetter: 'bg', name: 'Bulgarian', nativeName: 'Български' },
    { code: 'sqi', twoLetter: 'sq', name: 'Albanian', nativeName: 'Shqip', altCodes: ['alb'] },
    { code: 'afr', twoLetter: 'af', name: 'Afrikaans', nativeName: 'Afrikaans' },
    { code: 'aka', twoLetter: 'ak', name: 'Akan', nativeName: 'Akan' },
    { code: 'eus', twoLetter: 'eu', name: 'Basque', nativeName: 'Euskara', altCodes: ['baq'] },
    { code: 'isl', twoLetter: 'is', name: 'Icelandic', nativeName: 'Íslenska', altCodes: ['ice'] },
    { code: 'gle', twoLetter: 'ga', name: 'Irish', nativeName: 'Gaeilge' },
    { code: 'glg', twoLetter: 'gl', name: 'Galician', nativeName: 'Galego' },
    { code: 'est', twoLetter: 'et', name: 'Estonian', nativeName: 'Eesti' },
    { code: 'lav', twoLetter: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
    { code: 'lit', twoLetter: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
    { code: 'bos', twoLetter: 'bs', name: 'Bosnian', nativeName: 'Bosanski' },
    { code: 'mkd', twoLetter: 'mk', name: 'Macedonian', nativeName: 'Македонски', altCodes: ['mac'] },
    { code: 'bel', twoLetter: 'be', name: 'Belarusian', nativeName: 'Беларуская' },
    { code: 'hye', twoLetter: 'hy', name: 'Armenian', nativeName: 'Հայերեն', altCodes: ['arm'] },
    { code: 'aze', twoLetter: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycan' },
    { code: 'kat', twoLetter: 'ka', name: 'Georgian', nativeName: 'ქართული', altCodes: ['geo'] },
    { code: 'kaz', twoLetter: 'kk', name: 'Kazakh', nativeName: 'Қазақша' },
    { code: 'uzb', twoLetter: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha' },
    { code: 'mon', twoLetter: 'mn', name: 'Mongolian', nativeName: 'Монгол' },
    { code: 'nep', twoLetter: 'ne', name: 'Nepali', nativeName: 'नेपाली' },
    { code: 'mar', twoLetter: 'mr', name: 'Marathi', nativeName: 'मराठी' },
    { code: 'guj', twoLetter: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી' },
    { code: 'pan', twoLetter: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
    { code: 'kan', twoLetter: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
    { code: 'mal', twoLetter: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
    { code: 'sin', twoLetter: 'si', name: 'Sinhala', nativeName: 'සිංහල' },
    { code: 'mya', twoLetter: 'my', name: 'Burmese', nativeName: 'ဗမာစာ', altCodes: ['bur'] },
    { code: 'khm', twoLetter: 'km', name: 'Khmer', nativeName: 'ខ្មែរ' },
    { code: 'lao', twoLetter: 'lo', name: 'Lao', nativeName: 'ລາວ' },
    { code: 'amh', twoLetter: 'am', name: 'Amharic', nativeName: 'አማርኛ' },
    { code: 'som', twoLetter: 'so', name: 'Somali', nativeName: 'Soomaaliga' },
    { code: 'swa', twoLetter: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
    { code: 'zul', twoLetter: 'zu', name: 'Zulu', nativeName: 'isiZulu' },
    { code: 'xho', twoLetter: 'xh', name: 'Xhosa', nativeName: 'isiXhosa' },
    { code: 'yor', twoLetter: 'yo', name: 'Yoruba', nativeName: 'Yorùbá' },
    { code: 'hau', twoLetter: 'ha', name: 'Hausa', nativeName: 'Hausa' },
    { code: 'ibo', twoLetter: 'ig', name: 'Igbo', nativeName: 'Asụsụ Igbo' },
    { code: 'cym', twoLetter: 'cy', name: 'Welsh', nativeName: 'Cymraeg', altCodes: ['wel'] },
    { code: 'bre', twoLetter: 'br', name: 'Breton', nativeName: 'Brezhoneg' },
    { code: 'epo', twoLetter: 'eo', name: 'Esperanto', nativeName: 'Esperanto' },
    { code: 'lat', twoLetter: 'la', name: 'Latin', nativeName: 'Latina' },
    { code: 'mlt', twoLetter: 'mt', name: 'Maltese', nativeName: 'Malti' }
];

class LanguageManager {
    constructor() {
        // Build internal lookup caches for rapid code expansion
        this._codeToLangMap = new Map();
        this._nameToLangMap = new Map();
        this._initLookupMaps();
    }

    /**
     * Pre-populate lookup maps for O(1) matching across 2-letter, 3-letter, and aliases.
     */
    _initLookupMaps() {
        // Iterate through all defined common languages
        COMMON_LANGUAGES.forEach((lang) => {
            this._indexLanguage(lang);
        });
    }

    /**
     * Helper to index a language definition into internal lookup maps.
     * @param {Object} lang - Language descriptor
     */
    _indexLanguage(lang) {
        if (!lang) return;

        // Index primary 3-letter ISO code
        if (lang.code) {
            this._codeToLangMap.set(lang.code.toLowerCase(), lang);
        }
        // Index primary 2-letter ISO code
        if (lang.twoLetter) {
            this._codeToLangMap.set(lang.twoLetter.toLowerCase(), lang);
        }
        // Index alternative 3-letter codes
        if (lang.altCodes && Array.isArray(lang.altCodes)) {
            lang.altCodes.forEach((alt) => {
                if (alt) this._codeToLangMap.set(alt.toLowerCase(), lang);
            });
        }
        // Index English display name
        if (lang.name) {
            this._nameToLangMap.set(lang.name.toLowerCase(), lang);
        }
        // Index native display name
        if (lang.nativeName) {
            this._nameToLangMap.set(lang.nativeName.toLowerCase(), lang);
        }
    }

    /**
     * Dynamically register external Jellyfin culture definitions into lookup maps.
     * @param {Array<Object>} cultures - Array of culture objects from Jellyfin API
     */
    registerCultures(cultures) {
        if (!cultures || !Array.isArray(cultures)) return;

        cultures.forEach((c) => {
            if (!c) return;
            const three = (c.ThreeLetterISOLanguageName || c.value || '').toLowerCase();
            const two = (c.TwoLetterISOLanguageName || '').toLowerCase();
            const name = (c.DisplayName || c.label || '').replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();

            if (!three && !two && !name) return;

            const altCodes = [];
            if (Array.isArray(c.ThreeLetterISOLanguageNames)) {
                c.ThreeLetterISOLanguageNames.forEach((alt) => {
                    if (alt && alt.toLowerCase() !== three) altCodes.push(alt.toLowerCase());
                });
            }

            // Check if existing definition already present
            const existing = (three ? this._codeToLangMap.get(three) : null) || (two ? this._codeToLangMap.get(two) : null);
            if (existing) {
                if (two && !existing.twoLetter) existing.twoLetter = two;
                if (name && !existing.name) existing.name = name;
                if (altCodes.length > 0) {
                    existing.altCodes = Array.from(new Set([...(existing.altCodes || []), ...altCodes]));
                }
                this._indexLanguage(existing);
            } else {
                const newLang = {
                    code: three || two,
                    twoLetter: two,
                    name: name || three || two,
                    nativeName: name || three || two,
                    altCodes: altCodes
                };
                this._indexLanguage(newLang);
            }
        });
    }

    /**
     * Retrieve the list of popular languages for quick-pick UI chips.
     * @returns {Array<Object>} List of popular language objects
     */
    getPopularLanguages() {
        return COMMON_LANGUAGES.slice(0, 12);
    }

    /**
     * Retrieve the complete list of common languages known to the manager.
     * @returns {Array<Object>} Full array of standard language definitions
     */
    getAllStandardLanguages() {
        return [...COMMON_LANGUAGES];
    }

    /**
     * Retrieve the user's saved favorite languages from persistent storage.
     * @returns {Array<Object>} Array of favorite language objects { code, name, twoLetter }
     */
    getFavorites() {
        try {
            // Read raw JSON from local storage
            const raw = storage.getItem(FAVORITES_STORAGE_KEY);
            if (!raw) return [];

            // Parse stored JSON array
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed;
            }
            return [];
        } catch (err) {
            // Fall back gracefully on corrupted storage
            log.warn('Failed to parse favorite languages from storage:', err);
            return [];
        }
    }

    /**
     * Check if the user has at least one favorite language configured.
     * @returns {boolean} True if any favorites are selected
     */
    hasFavorites() {
        return this.getFavorites().length > 0;
    }

    /**
     * Get a Set of all normalized lowercase matching tokens for active favorites.
     * Includes 2-letter, 3-letter, aliases, and lowercase names.
     * @returns {Set<string>} Set of normalized tokens
     */
    getFavoriteTokens() {
        const favorites = this.getFavorites();
        const tokens = new Set();

        // Expand each saved favorite into all its related matching tokens
        favorites.forEach((fav) => {
            const code = (fav.code || '').toLowerCase();
            const twoLetter = (fav.twoLetter || '').toLowerCase();
            const name = (fav.name || '').toLowerCase();
            const nativeName = (fav.nativeName || '').toLowerCase();

            // Add direct fields
            if (code) tokens.add(code);
            if (twoLetter) tokens.add(twoLetter);
            if (name) tokens.add(name);
            if (nativeName) tokens.add(nativeName);

            // Lookup canonical definition to grab any alternative codes
            const canonical = this._codeToLangMap.get(code) || this._codeToLangMap.get(twoLetter) || this._nameToLangMap.get(name);
            if (canonical) {
                if (canonical.code) tokens.add(canonical.code.toLowerCase());
                if (canonical.twoLetter) tokens.add(canonical.twoLetter.toLowerCase());
                if (canonical.name) tokens.add(canonical.name.toLowerCase());
                if (canonical.nativeName) tokens.add(canonical.nativeName.toLowerCase());
                if (canonical.altCodes) {
                    canonical.altCodes.forEach((alt) => tokens.add(alt.toLowerCase()));
                }
            }
        });

        return tokens;
    }

    /**
     * Save the entire array of favorite languages to persistent storage.
     * Emits 'favoriteLanguages:changed' on the global eventBus.
     * @param {Array<Object>} favoritesList - New array of favorite objects
     */
    setFavorites(favoritesList) {
        // Ensure input is a valid array
        const listToSave = Array.isArray(favoritesList) ? favoritesList : [];

        // Save serialized JSON string
        storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(listToSave));
        log.info(`Updated favorite languages count: ${listToSave.length}`);

        // Broadcast change event across application modules
        eventBus.emit('favoriteLanguages:changed', listToSave);
    }

    /**
     * Add a language to favorites if not already present.
     * @param {Object|string} lang - Language object or code string
     */
    addFavorite(lang) {
        const normalized = this.normalizeLanguage(lang);
        if (!normalized || !normalized.code) return;

        const current = this.getFavorites();
        // Check if already present by code or twoLetter
        const exists = current.some((f) => f.code === normalized.code || (f.twoLetter && f.twoLetter === normalized.twoLetter));

        if (!exists) {
            current.push(normalized);
            this.setFavorites(current);
        }
    }

    /**
     * Remove a language from favorites.
     * @param {Object|string} lang - Language object or code string
     */
    removeFavorite(lang) {
        const normalized = this.normalizeLanguage(lang);
        if (!normalized || !normalized.code) return;

        const current = this.getFavorites();
        // Filter out matching items by code or twoLetter
        const filtered = current.filter((f) => {
            if (f.code && f.code === normalized.code) return false;
            if (f.twoLetter && normalized.twoLetter && f.twoLetter === normalized.twoLetter) return false;
            return true;
        });

        if (filtered.length !== current.length) {
            this.setFavorites(filtered);
        }
    }

    /**
     * Toggle a language in/out of favorites.
     * @param {Object|string} lang - Language object or code string
     * @returns {boolean} True if now favorited, false if removed
     */
    toggleFavorite(lang) {
        const normalized = this.normalizeLanguage(lang);
        if (!normalized || !normalized.code) return false;

        if (this.isFavorite(normalized)) {
            this.removeFavorite(normalized);
            return false;
        } else {
            this.addFavorite(normalized);
            return true;
        }
    }

    /**
     * Clear all favorite languages from storage.
     */
    clearFavorites() {
        this.setFavorites([]);
    }

    /**
     * Normalize an input language (culture object, locale string, code, or track)
     * into a standard { code, twoLetter, name, nativeName } structure.
     * @param {any} input - Raw language input
     * @returns {Object|null} Normalized language object
     */
    normalizeLanguage(input) {
        if (!input) return null;

        // If already a normalized object with code
        if (typeof input === 'object' && input.code && input.name) {
            return {
                code: input.code.toLowerCase(),
                twoLetter: (input.twoLetter || '').toLowerCase(),
                name: input.name,
                nativeName: input.nativeName || input.name
            };
        }

        // If Jellyfin culture object (ThreeLetterISOLanguageName / DisplayName)
        if (typeof input === 'object' && input.ThreeLetterISOLanguageName) {
            const three = input.ThreeLetterISOLanguageName.toLowerCase();
            const two = (input.TwoLetterISOLanguageName || '').toLowerCase();
            const canonical = this._codeToLangMap.get(three) || this._codeToLangMap.get(two);

            return {
                code: three,
                twoLetter: two || (canonical ? canonical.twoLetter : ''),
                name: canonical ? canonical.name : input.DisplayName || three,
                nativeName: input.DisplayName || (canonical ? canonical.nativeName : three)
            };
        }

        // If simple string code (e.g. 'eng', 'en', 'en-us', 'es-419')
        if (typeof input === 'string') {
            const clean = input.trim().toLowerCase();
            // Handle locale composite codes like 'en-us' or 'pt-br'
            const baseCode = clean.split(/[-_]/)[0];

            // Look up directly in cache
            const directMatch = this._codeToLangMap.get(clean) || this._codeToLangMap.get(baseCode) || this._nameToLangMap.get(clean);

            if (directMatch) {
                return {
                    code: directMatch.code,
                    twoLetter: directMatch.twoLetter,
                    name: directMatch.name,
                    nativeName: directMatch.nativeName
                };
            }

            // Fallback object for unmapped codes
            return {
                code: clean,
                twoLetter: baseCode.length === 2 ? baseCode : '',
                name: input,
                nativeName: input
            };
        }

        // If dropdown option object { value: 'eng', label: 'English' }
        if (typeof input === 'object' && input.value !== undefined) {
            const norm = this.normalizeLanguage(input.value);
            if (norm) {
                if (input.label && norm.name === input.value) {
                    norm.name = input.label;
                    norm.nativeName = input.label;
                }
                return norm;
            }
            return {
                code: String(input.value).toLowerCase(),
                twoLetter: '',
                name: input.label || String(input.value),
                nativeName: input.label || String(input.value)
            };
        }

        return null;
    }

    /**
     * Check if a given language, code, culture object, or track matches any saved favorite.
     * @param {any} item - Language code, name, culture object, or media track
     * @returns {boolean} True if matches an active favorite language
     */
    isFavorite(item) {
        // Return false immediately for empty or null inputs
        if (!item) return false;

        // Retrieve current set of favorite matching tokens
        const tokens = this.getFavoriteTokens();
        if (tokens.size === 0) return false;

        // 0. If item is a media stream track object with Language or DisplayTitle fields
        if (typeof item === 'object' && (item.Language !== undefined || item.DisplayTitle !== undefined || item.Title !== undefined)) {
            return this.isFavoriteTrack(item);
        }

        // 1. Normalize the item first for comprehensive canonical matching
        const norm = this.normalizeLanguage(item);
        if (norm) {
            const code = (norm.code || '').toLowerCase();
            const twoLetter = (norm.twoLetter || '').toLowerCase();
            const name = (norm.name || '').toLowerCase();
            const nativeName = (norm.nativeName || '').toLowerCase();

            // Check if any normalized canonical field matches favorite tokens
            if (code && tokens.has(code)) return true;
            if (twoLetter && tokens.has(twoLetter)) return true;
            if (name && tokens.has(name)) return true;
            if (nativeName && tokens.has(nativeName)) return true;
        }

        // 2. Direct string check
        if (typeof item === 'string') {
            const clean = item.trim().toLowerCase();
            // Direct exact token match
            if (tokens.has(clean)) return true;

            // Check base prefix (e.g. 'en-us' -> 'en')
            const baseCode = clean.split(/[-_]/)[0];
            if (tokens.has(baseCode)) return true;

            // Check if string matches any canonical indexed language name
            const langByName = this._nameToLangMap.get(clean);
            if (langByName) {
                if (langByName.code && tokens.has(langByName.code.toLowerCase())) return true;
                if (langByName.twoLetter && tokens.has(langByName.twoLetter.toLowerCase())) return true;
            }

            return false;
        }

        // 3. Dropdown option object { value, label }
        if (typeof item === 'object' && item.value !== undefined) {
            const valStr = String(item.value).trim().toLowerCase();
            // Check exact value token match
            if (tokens.has(valStr)) return true;

            // Check base prefix of value (e.g. 'en-us' -> 'en')
            const baseVal = valStr.split(/[-_]/)[0];
            if (tokens.has(baseVal)) return true;

            // Check exact label match (e.g. label is 'Arabic' or 'العربية')
            if (item.label) {
                const cleanLabel = String(item.label).trim().toLowerCase();
                if (tokens.has(cleanLabel)) return true;

                // Check if label matches any indexed canonical name
                const langByName = this._nameToLangMap.get(cleanLabel);
                if (langByName) {
                    if (langByName.code && tokens.has(langByName.code.toLowerCase())) return true;
                    if (langByName.twoLetter && tokens.has(langByName.twoLetter.toLowerCase())) return true;
                }
            }

            return false;
        }

        return false;
    }

    /**
     * Inspect a media stream track and check if its language matches any favorite.
     * @param {Object} track - Media stream track from Jellyfin player
     * @returns {boolean} True if track language matches favorites
     */
    isFavoriteTrack(track) {
        // Return false for invalid track object
        if (!track) return false;

        // Retrieve current set of favorite matching tokens
        const tokens = this.getFavoriteTokens();
        if (tokens.size === 0) return false;

        // 1. Check track.Language (e.g. "eng", "ara", "fre", "spa", "en")
        const lang = (track.Language || '').trim().toLowerCase();
        if (lang) {
            // Direct exact token match
            if (tokens.has(lang)) return true;

            // Base code check (e.g. 'en-us' -> 'en')
            const baseLang = lang.split(/[-_]/)[0];
            if (tokens.has(baseLang)) return true;

            // Normalized canonical lookup
            const norm = this.normalizeLanguage(lang);
            if (norm) {
                if (norm.code && tokens.has(norm.code.toLowerCase())) return true;
                if (norm.twoLetter && tokens.has(norm.twoLetter.toLowerCase())) return true;
                if (norm.name && tokens.has(norm.name.toLowerCase())) return true;
                if (norm.nativeName && tokens.has(norm.nativeName.toLowerCase())) return true;
            }
        }

        // Helper to check title strings using exact word tokens or non-Latin script matching
        const matchesTitle = (titleStr) => {
            if (!titleStr) return false;
            const cleanTitle = String(titleStr).trim().toLowerCase();
            if (!cleanTitle) return false;

            // Check non-ASCII / non-Latin native script tokens (e.g. 'العربية', '日本語', '한국어')
            for (const token of tokens) {
                // If token contains non-ASCII characters, safe to check inclusion
                if (/[^\x00-\x7F]/.test(token) && cleanTitle.includes(token)) {
                    return true;
                }
            }

            // Split title by whitespace, punctuation, and delimiters into individual words
            const words = cleanTitle.split(/[\s\-_/()[\].,+:]+/).filter(Boolean);
            for (const word of words) {
                // Check if the discrete word matches a favorite token (e.g. 'arabic', 'ara', 'eng')
                if (tokens.has(word)) {
                    return true;
                }
            }

            return false;
        };

        // 2. Check track.DisplayTitle (e.g. "Arabic (DTS-HD MA 5.1)", "English [SubRip]")
        if (track.DisplayTitle && matchesTitle(track.DisplayTitle)) {
            return true;
        }

        // 3. Check track.Title (e.g. "Arabic", "Director's Commentary")
        if (track.Title && matchesTitle(track.Title)) {
            return true;
        }

        return false;
    }

    /**
     * Filter a list of dropdown options, culture items, or tracks by favorite languages.
     * Always preserves special non-language options (e.g. 'none', 'Default', 'Off', 'Auto', -1).
     *
     * @param {Array} options - List of options to filter
     * @param {Function} [getValueFn] - Optional extractor function to get code from an option
     * @returns {Array} Filtered list containing only favorites and special options
     */
    filterOptions(options, getValueFn = null) {
        if (!Array.isArray(options)) return [];
        // If no favorites are set, return full array unfiltered
        if (!this.hasFavorites()) return options;

        const SPECIAL_VALUES = new Set(['', 'none', 'default', 'auto', 'off', '-1', 'all', 'selectversion']);

        return options.filter((opt) => {
            // Determine raw value/identifier
            const val = getValueFn ? getValueFn(opt) : (opt && opt.value !== undefined ? opt.value : opt);
            const valStr = String(val).toLowerCase();

            // Always keep special fallback options
            if (SPECIAL_VALUES.has(valStr)) {
                return true;
            }

            // Always keep Index === -1 (Off track)
            if (opt && opt.Index === -1) {
                return true;
            }

            // Check if matches favorite
            return this.isFavorite(opt);
        });
    }
}

// Export singleton instance
export const languageManager = new LanguageManager();
export default languageManager;
