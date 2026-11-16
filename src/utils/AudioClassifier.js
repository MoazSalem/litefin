/**
 * ============================================================================
 * Litefin - Audio Stream Classifier
 * ============================================================================
 * Evaluates media stream metadata across audio tracks to determine language
 * categorization (Subbed, Dubbed, Subbed/Dubbed).
 *
 * Operates purely on client-side stream metadata without external network latency.
 * ============================================================================
 */

/**
 * Recognized Japanese language identifiers found in Matroska/MP4 tags,
 * ISO 639-1, ISO 639-2/B, and ISO 639-2/T conventions.
 */
const JAPANESE_LANGUAGE_CODES = new Set([
    'jpn',
    'jp',
    'ja',
    'jap',
    'japanese',
    'japan'
]);

/**
 * Tokens denoting unspecified, undefined, or generic multilingual tracks
 * where the spoken dialogue cannot be safely inferred.
 */
const UNKNOWN_LANGUAGE_CODES = new Set([
    'und',
    'unknown',
    'unk',
    'zxx',
    'mis',
    'mul',
    'qaa',
    'qab'
]);

/**
 * Known foreign languages (ISO 639-1, ISO 639-2, and common names)
 * Used to ensure audio tracks are only flagged as Dubbed if an actual foreign language is identified.
 */
const FOREIGN_LANGUAGE_CODES = new Set([
    'en', 'eng', 'english',
    'es', 'spa', 'spanish', 'espanol', 'español',
    'fr', 'fra', 'fre', 'french', 'francais', 'français',
    'de', 'deu', 'ger', 'german', 'deutsch',
    'it', 'ita', 'italian', 'italiano',
    'pt', 'por', 'portuguese', 'português', 'portugues',
    'ru', 'rus', 'russian',
    'zh', 'zho', 'chi', 'chinese', 'mandarin', 'cantonese',
    'ko', 'kor', 'korean',
    'hi', 'hin', 'hindi',
    'ar', 'ara', 'arabic',
    'pl', 'pol', 'polish',
    'nl', 'nld', 'dut', 'dutch',
    'sv', 'swe', 'swedish',
    'no', 'nor', 'norwegian',
    'fi', 'fin', 'finnish',
    'da', 'dan', 'danish',
    'tr', 'tur', 'turkish',
    'vi', 'vie', 'vietnamese',
    'th', 'tha', 'thai',
    'id', 'ind', 'indonesian',
    'tl', 'tgl', 'tagalog', 'filipino',
    'el', 'ell', 'gre', 'greek',
    'he', 'heb', 'hebrew',
    'hu', 'hun', 'hungarian',
    'cs', 'ces', 'cze', 'czech',
    'ro', 'ron', 'rum', 'romanian',
    'uk', 'ukr', 'ukrainian',
    'ms', 'msa', 'may', 'malay',
    'fa', 'fas', 'per', 'persian', 'farsi',
    'dub', 'dubbed'
]);

export class AudioClassifier {
    /**
     * Normalizes an arbitrary language tag string into a trimmed, lowercased token.
     *
     * @param {string} [rawLanguage] - Raw language code or title from stream header
     * @returns {string} Cleaned language token
     */
    static normalizeLanguage(rawLanguage) {
        if (!rawLanguage || typeof rawLanguage !== 'string') {
            return '';
        }
        return rawLanguage.trim().toLowerCase();
    }

    /**
     * Determines whether a given language token maps to Japanese.
     * Checks standard ISO codes, dialect tags, and full language descriptors.
     *
     * @param {string} [lang] - Normalized or raw language code
     * @returns {boolean} True if matching Japanese codes
     */
    static isJapanese(lang) {
        if (!lang) return false;
        const normalized = this.normalizeLanguage(lang);
        if (JAPANESE_LANGUAGE_CODES.has(normalized)) {
            return true;
        }
        // Match prefix codes like 'ja-jp', 'ja_jp', 'jpn-...'
        if (/^(ja|jpn)[-_]/i.test(normalized)) {
            return true;
        }
        // Match word boundaries for japanese or nihongo in titles/descriptors
        if (/\b(japanese|japan|nihongo|jpn|ja)\b/i.test(normalized)) {
            return true;
        }
        return false;
    }

    /**
     * Checks if a language token represents an untagged, missing, or purely technical descriptor.
     * Technical format strings like "AAC - Stereo", "FLAC 2.0", or "Audio 1" are NOT languages.
     *
     * @param {string} [lang] - Normalized or raw language code
     * @returns {boolean} True if unspecified or technical audio format string
     */
    static isUnknownOrUntagged(lang) {
        if (!lang) return true;
        const normalized = this.normalizeLanguage(lang);
        if (!normalized || UNKNOWN_LANGUAGE_CODES.has(normalized)) return true;

        // If string contains only technical audio codec/channel/track tokens
        const stripped = normalized
            .replace(/\b(stereo|mono|surround|[0-9]\.[0-9]|aac|flac|ac3|eac3|dts|mp3|opus|vorbis|truehd|atmos|audio|track|stream|default|undefined|unknown|und|unk|2ch|6ch|8ch|lossless|pcm|ddp?|hd|ma|pro)\b/gi, '')
            .replace(/[^a-z0-9]/gi, '')
            .trim();

        // If after stripping all technical noise, nothing remains, it is untagged
        if (stripped.length === 0) {
            return true;
        }

        return false;
    }

    /**
     * Determines whether a given language token maps to a known non-Japanese language.
     * Prevents technical codecs, channels, or unspecified audio tracks from falsely being marked as Dubbed.
     *
     * @param {string} [lang] - Normalized or raw language code / title
     * @returns {boolean} True if matching a recognized foreign language
     */
    static isForeignLanguage(lang) {
        if (!lang) return false;
        const normalized = this.normalizeLanguage(lang);
        if (this.isJapanese(normalized)) return false;
        if (this.isUnknownOrUntagged(normalized)) return false;

        // Check exact match in foreign language registry
        if (FOREIGN_LANGUAGE_CODES.has(normalized)) return true;

        // Check prefix codes like 'en-us', 'es-es', 'fr-ca', etc.
        const prefix = normalized.split(/[-_]/)[0];
        if (FOREIGN_LANGUAGE_CODES.has(prefix)) return true;

        // Check word boundaries for foreign languages or dub markers in descriptors
        if (/\b(english|spanish|espanol|español|french|francais|français|german|deutsch|italian|italiano|russian|chinese|mandarin|cantonese|korean|portuguese|português|hindi|arabic|polish|dutch|swedish|norwegian|finnish|danish|turkish|vietnamese|thai|indonesian|tagalog|filipino|greek|hebrew|hungarian|czech|romanian|ukrainian|malay|farsi|persian|dub|dubbed)\b/i.test(normalized)) {
            return true;
        }

        // If the code is a valid 2-letter or 3-letter ISO code that is not unknown/technical,
        // treat it as foreign language
        if (/^[a-z]{2,3}$/.test(normalized) && !UNKNOWN_LANGUAGE_CODES.has(normalized)) {
            return true;
        }

        return false;
    }

    /**
     * Extracts an array of audio stream language strings from a Jellyfin item,
     * MediaSource, or an existing stream list.
     *
     * @param {Object|Array} itemOrStreams - Jellyfin item object or array of streams
     * @returns {string[]} List of raw language strings
     */
    static extractAudioLanguages(itemOrStreams) {
        if (!itemOrStreams) return [];

        const extractFromStream = (s) => {
            if (!s) return null;
            const type = (s.Type || '').toLowerCase();
            if (type !== 'audio' && s.Type) return null;

            // 1. Prefer explicit Language code if present and valid
            if (s.Language && !this.isUnknownOrUntagged(s.Language)) {
                return s.Language;
            }

            // 2. If Language is missing or unknown, check if DisplayTitle/Title contains language hints
            const title = s.DisplayTitle || s.Title || '';
            if (title) {
                if (this.isJapanese(title)) return 'jpn';
                if (this.isForeignLanguage(title)) return title;
            }

            // Only return Language if it is not untagged
            if (s.Language && !this.isUnknownOrUntagged(s.Language)) {
                return s.Language;
            }

            return '';
        };

        // Direct array of strings or stream objects
        if (Array.isArray(itemOrStreams)) {
            return itemOrStreams
                .map((entry) => (typeof entry === 'string' ? entry : extractFromStream(entry)))
                .filter(Boolean);
        }

        const collected = [];

        // Check top-level MediaStreams on item
        if (Array.isArray(itemOrStreams.MediaStreams)) {
            itemOrStreams.MediaStreams.forEach((s) => {
                const lang = extractFromStream(s);
                if (lang) collected.push(lang);
            });
        }

        // Check MediaSources array across all sources
        if (Array.isArray(itemOrStreams.MediaSources)) {
            itemOrStreams.MediaSources.forEach((source) => {
                if (Array.isArray(source?.MediaStreams)) {
                    source.MediaStreams.forEach((s) => {
                        const lang = extractFromStream(s);
                        if (lang) collected.push(lang);
                    });
                }
            });
        }

        return collected;
    }

    /**
     * Checks if the media item or audio language collection contains at least one Japanese audio stream.
     * Useful for cross-verifying anime status on animation titles without explicit anime tags.
     *
     * @param {Object|Array} itemOrLanguages - Jellyfin item or list of audio language descriptors
     * @returns {boolean} True if an identifiable Japanese dialogue track is present
     */
    static hasJapaneseAudio(itemOrLanguages) {
        if (!itemOrLanguages) return false;

        // Extract normalized audio languages list from stream headers
        const rawLanguages = Array.isArray(itemOrLanguages) && itemOrLanguages.every((x) => typeof x === 'string')
            ? itemOrLanguages
            : this.extractAudioLanguages(itemOrLanguages);

        if (!rawLanguages || rawLanguages.length === 0) return false;

        // Inspect candidates for Japanese language code or token
        return rawLanguages.some((lang) => {
            if (this.isUnknownOrUntagged(lang)) return false;
            return this.isJapanese(lang);
        });
    }

    /**
     * Classifies audio language categorization for an item or a set of audio language strings.
     *
     * Rule Set:
     * - "Subbed": Japanese audio track present, with NO non-Japanese audio tracks.
     * - "Dubbed": Non-Japanese audio track present, with NO Japanese audio track.
     * - "Subbed/Dubbed": Both Japanese and one or more non-Japanese audio tracks exist.
     * - null: Untagged files or items with no identifiable language metadata (undefined != dubbed).
     *
     * @param {Object|Array} itemOrLanguages - Jellyfin item or array of audio languages
     * @returns {'Subbed'|'Dubbed'|'Subbed/Dubbed'|null}
     */
    static classify(itemOrLanguages) {
        if (!itemOrLanguages) return null;

        // Extract raw language candidates
        const rawLanguages = Array.isArray(itemOrLanguages) && itemOrLanguages.every((x) => typeof x === 'string')
            ? itemOrLanguages
            : this.extractAudioLanguages(itemOrLanguages);

        if (!rawLanguages || rawLanguages.length === 0) {
            return null;
        }

        let sawJapanese = false;
        let sawForeign = false;

        // Iterate through all candidate tracks
        for (let i = 0; i < rawLanguages.length; i++) {
            const lang = rawLanguages[i];
            if (this.isUnknownOrUntagged(lang)) {
                // Skip untagged or undefined tokens rather than guessing
                continue;
            }

            if (this.isJapanese(lang)) {
                sawJapanese = true;
            } else if (this.isForeignLanguage(lang)) {
                sawForeign = true;
            }
        }

        // Both Japanese dialogue and a foreign/dub track coexist
        if (sawJapanese && sawForeign) {
            return 'Subbed/Dubbed';
        }

        // Only foreign/dub track identified
        if (sawForeign) {
            return 'Dubbed';
        }

        // Pure original Japanese audio track without alternative language dubs
        if (sawJapanese) {
            return 'Subbed';
        }

        // Untagged files with no usable language descriptors: undefined is NOT dubbed
        return null;
    }

    /**
     * Evaluates a collection of episodes (e.g. for a whole season) and determines
     * if an overarching verdict applies uniformly across all classified episodes.
     *
     * If all classified episodes agree (e.g. all Subbed), the season receives that label.
     * If episodes have conflicting tracks (some Dubbed, some Subbed), returns null
     * to avoid presenting inaccurate season-wide promises.
     *
     * @param {Array<Object>} episodes - Array of episode objects
     * @returns {'Subbed'|'Dubbed'|'Subbed/Dubbed'|null}
     */
    static classifySeason(episodes) {
        if (!Array.isArray(episodes) || episodes.length === 0) {
            return null;
        }

        let commonVerdict = null;

        for (let i = 0; i < episodes.length; i++) {
            const ep = episodes[i];
            const verdict = this.classify(ep);

            // Unclassified/untagged episodes are skipped from breaking consensus
            if (!verdict) continue;

            if (commonVerdict === null) {
                commonVerdict = verdict;
                continue;
            }

            // Mismatched episode classifications nullify season-wide promise
            if (commonVerdict !== verdict) {
                return null;
            }
        }

        return commonVerdict;
    }
}
