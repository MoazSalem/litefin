/**
 * ============================================================================
 * Litefin Tizen - Utils extensions for screensaver
 * ============================================================================
 */

import { PlayerSettings } from './PlayerSettings.js';
import { storage } from './StorageService.js';
import { i18n } from './i18n.js';

export function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Escapes a value for safe interpolation into HTML text content or
 * double-quoted attribute values.
 *
 * The app renders many server-supplied strings (item names, EPG data,
 * subtitle cues, discovery replies, backup labels) through innerHTML
 * template literals. This is the single escaper for all such sinks.
 * Note: i18n.ensureBiDi() is a BiDi layout helper only — it returns the
 * input unchanged in LTR mode and must never be treated as an escaper.
 *
 * @param {*} value - Value to escape (coerced to string; null/undefined -> '')
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Named/numeric HTML entities that legitimately appear in subtitle files.
 * Decoded BEFORE escaping so pre-encoded files don't render as literal text
 * ("AT&amp;T" -> "AT&T"). Single-pass replace: substituted text is never
 * re-scanned, so "&amp;lt;" correctly becomes literal "&lt;" text.
 * @private
 */
const SUBTITLE_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0'
};

/**
 * Map of standard WebVTT color classes to CSS color hex codes.
 * @private
 */
const WEBVTT_NAMED_COLORS = {
    white: '#ffffff',
    lime: '#00ff00',
    cyan: '#00ffff',
    red: '#ff0000',
    yellow: '#ffff00',
    magenta: '#ff00ff',
    blue: '#0000ff',
    black: '#000000',
    gray: '#808080',
    grey: '#808080'
};

/**
 * Converts WebVTT style and class tags into standard inline span tags.
 * @param {string} text - Raw subtitle text
 * @returns {string} Text with WebVTT tags converted
 * @private
 */
function _convertWebVTTTags(text) {
    if (!text || typeof text !== 'string') return '';

    // Check if user enabled subtitle color override in settings (defaults to true)
    let overrideColors = true;
    try {
        overrideColors = PlayerSettings.get('subtitleOverrideColors') !== false;
    } catch (_) {
        // Environment without storage/PlayerSettings initialized
    }

    // Convert closing </c> and </v> tags to </span>
    let result = text.replace(/<\/(?:c|v)>/gi, '</span>');

    // Convert voice tags: <v Voice Name>
    result = result.replace(/<v(?:\.([^\s>]+))?(?:\s+([^>]+))?>/gi, (_match, className, voiceName) => {
        const classes = ['cue-voice'];
        if (className) {
            classes.push(...className.split('.').filter(Boolean));
        }
        const titleAttr = voiceName ? ` title="${voiceName.trim().replace(/"/g, '&quot;')}"` : '';
        return `<span class="${classes.join(' ')}"${titleAttr}>`;
    });

    // Convert WebVTT <c> and <c.class1.class2...> tags to styled spans
    result = result.replace(/<c(?:\.([a-zA-Z0-9_.-]+))?>/gi, (_match, classListStr) => {
        if (!classListStr) {
            return '<span>';
        }

        const rawClasses = classListStr.split('.').filter(Boolean);
        const inlineStyles = [];
        const customClasses = [];

        for (const cls of rawClasses) {
            const lower = cls.toLowerCase();

            /* ---------------------------------------------------------
               1. Hex foreground colors: color808080, colorF00, color#808080
               When overrideColors is active, we recognize it as a color
               tag and skip applying the inline color, cleanly falling back
               to Litefin's configured subtitle color.
               --------------------------------------------------------- */
            const hexColorMatch = lower.match(/^color#?([0-9a-f]{3,8})$/i);
            if (hexColorMatch) {
                if (!overrideColors) {
                    inlineStyles.push(`color: #${hexColorMatch[1]}`);
                }
                continue;
            }

            /* ---------------------------------------------------------
               2. Hex background colors: bg_color000000, bg_color#000
               --------------------------------------------------------- */
            const hexBgMatch = lower.match(/^bg_color#?([0-9a-f]{3,8})$/i);
            if (hexBgMatch) {
                if (!overrideColors) {
                    inlineStyles.push(`background-color: #${hexBgMatch[1]}`);
                }
                continue;
            }

            /* ---------------------------------------------------------
               3. Standard named WebVTT foreground colors (yellow, lime, etc.)
               --------------------------------------------------------- */
            if (WEBVTT_NAMED_COLORS[lower]) {
                if (!overrideColors) {
                    inlineStyles.push(`color: ${WEBVTT_NAMED_COLORS[lower]}`);
                }
                continue;
            }

            /* ---------------------------------------------------------
               4. Standard named WebVTT background colors (bg_yellow, etc.)
               --------------------------------------------------------- */
            if (lower.startsWith('bg_')) {
                const bgName = lower.slice(3);
                if (WEBVTT_NAMED_COLORS[bgName]) {
                    if (!overrideColors) {
                        inlineStyles.push(`background-color: ${WEBVTT_NAMED_COLORS[bgName]}`);
                    }
                    continue;
                }
            }

            /* ---------------------------------------------------------
               5. Unrecognized semantic classes (e.g. .narration, .character)
               Preserved in the class attribute without setting inline color,
               so they cleanly inherit the parent .subtitle-line styles.
               --------------------------------------------------------- */
            customClasses.push(cls);
        }

        const attrs = [];
        if (customClasses.length > 0) {
            attrs.push(`class="${customClasses.join(' ')}"`);
        }
        if (inlineStyles.length > 0) {
            attrs.push(`style="${inlineStyles.join('; ')};"`);
        }

        return attrs.length > 0 ? `<span ${attrs.join(' ')}>` : '<span>';
    });

    // Strip color attribute from font tags when overrideColors is active
    if (overrideColors) {
        result = result.replace(/<font\b([^>]*?)(\s+color=(?:"[^"]*"|'[^']*'|[^\s>]+))([^>]*?)>/gi, '<font$1$3>');
    }

    return result;
}

/**
 * Sanitizes subtitle cue text for the DOM subtitle overlay.
 *
 * SRT/WebVTT cues legitimately carry simple markup: styling tags (<i>, <b>,
 * <u>) preserved by SubtitleParser._cleanText, multi-line cues joined with
 * <br> by the parser itself, WebVTT class/color tags converted into styled
 * spans (<c.color808080> -> <span style="color: #808080;">), and some releases
 * use <font face/size/color>. Fully escaping cue text turned all of that into
 * visible literal tags.
 *
 * This restores formatting safely, in three provably closed steps:
 * 1. Convert WebVTT tags (<c.colorXXXXXX>, <v Speaker>) into styled spans.
 * 2. Decode pre-encoded HTML entities (bounded, single pass).
 * 3. Escape EVERYTHING — the string is now inert.
 * 4. Re-allow only the exact escaped spellings of whitelisted bare tags
 *    (i/b/u/em/strong/br/font/span/ruby/rt) and font/span tags whose
 *    attributes (face, size, color, style, class, title) are strictly
 *    double-quoted with values that contain no entities or script sinks.
 * Anything else (<img>, <script>, unknown tags, event handlers) remains
 * escaped, inert text.
 *
 * @param {*} text - Raw cue text from the subtitle parser
 * @returns {string} HTML-safe string with cue styling and line breaks intact
 */
export function sanitizeSubtitleText(text) {
    if (text === null || text === undefined) return '';

    // Check if user enabled subtitle color override in settings (defaults to true)
    let overrideColors = true;
    try {
        overrideColors = PlayerSettings.get('subtitleOverrideColors') !== false;
    } catch (_) {
        // Environment without storage/PlayerSettings initialized
    }

    let rawText = String(text);

    // Normalize single-quoted or unquoted font colors to double quotes before processing
    rawText = rawText.replace(/<font(\s+[^>]*)color='([^']*)'([^>]*)>/gi, '<font$1color="$2"$3>');
    rawText = rawText.replace(/<font(\s+[^>]*)color=([^"'\s>]+)([^>]*)>/gi, '<font$1color="$2"$3>');

    // Convert any WebVTT tags (<c...>, </c>, <v...>, </v>) into standard spans
    if (/<[cv][\s.>]/i.test(rawText) || /<\/[cv]>/i.test(rawText)) {
        rawText = _convertWebVTTTags(rawText);
    } else if (overrideColors) {
        rawText = rawText.replace(/<font\b([^>]*?)(\s+color=(?:"[^"]*"|'[^']*'|[^\s>]+))([^>]*?)>/gi, '<font$1$3>');
    }

    const decoded = rawText.replace(
        /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi,
        (match, entity) => {
            if (entity[0] === '#') {
                const code = entity[1] === 'x' || entity[1] === 'X'
                    ? parseInt(entity.slice(2), 16)
                    : parseInt(entity.slice(1), 10);
                return Number.isInteger(code) && code > 0 && code <= 0x10ffff
                    ? String.fromCodePoint(code)
                    : match;
            }
            return SUBTITLE_ENTITIES[entity.toLowerCase()] ?? match;
        }
    );

    return escapeHtml(decoded)
        // HTML tag/attribute whitespace is [ \t\n\r\f] only — JS \s also
        // matches NBSP/\u2028/\ufeff etc., which browsers treat as attribute
        // NAME characters, so allowing \s would emit renamed/junk attributes.
        .replace(/&lt;(\/?)(i|b|u|em|strong|br|font|span|ruby|rt)[ \t\n\r\f]*\/?&gt;/gi, '<$1$2>')
        .replace(/&lt;font((?:[ \t\n\r\f]+(?:face|size|color)=&quot;[^&]*&quot;)+[ \t\n\r\f]*)&gt;/gi,
            (match, attrs) => {
                if (overrideColors) {
                    attrs = attrs.replace(/[ \t\n\r\f]+color=&quot;[^&]*&quot;/gi, '');
                }
                const cleanedAttrs = attrs.replace(/&quot;/g, '"').trim();
                return cleanedAttrs ? `<font ${cleanedAttrs}>` : '<font>';
            })
        .replace(/&lt;span((?:[ \t\n\r\f]+(?:style|class|title)=&quot;[^&]*&quot;)+[ \t\n\r\f]*)&gt;/gi,
            (match, attrs) => {
                // Ensure style does not contain javascript: or unsafe expressions
                if (/javascript:|expression\(|url\(/i.test(attrs)) {
                    return match;
                }
                if (overrideColors) {
                    // Strip inline color and background-color declarations when override is active
                    attrs = attrs.replace(/style=&quot;([^&]*)&quot;/gi, (_m, styleVal) => {
                        const cleaned = styleVal
                            .replace(/(?:^|;)\s*(?:background-color|background|color)\s*:[^;]*/gi, '')
                            .trim()
                            .replace(/^;+|;+$/g, '');
                        return cleaned ? `style=&quot;${cleaned}&quot;` : '';
                    });
                }
                const cleanedAttrs = attrs.replace(/&quot;/g, '"').trim();
                return cleanedAttrs ? `<span ${cleanedAttrs}>` : '<span>';
            });
}

/**
 * ============================================================================
 * Overview & Biography Max Lines Clamp Helper
 * ============================================================================
 * Resolves the CSS class used to clamp the synopsis, description, or
 * biography across item details and person pages (including Seerr).
 *
 * standards by providing comfortable, legible reading lengths for desktop,
 * tablet, mobile, and TV screen viewing contexts.
 *
 * @returns {string} The CSS clamp class (e.g. 'line-clamp-6', 'line-clamp-none')
 * ============================================================================
 */
export function getOverviewClampClass() {
    // Read the user-defined max lines preference from local storage
    const maxLines = storage.getItem('pref:detailsOverviewMaxLines') || '6';

    // If 'none' or unconstrained full text is selected, return line-clamp-none
    if (maxLines === 'none') {
        return 'line-clamp-none';
    }

    // Return the matching numeric clamp class (e.g., 'line-clamp-4', 'line-clamp-6')
    return `line-clamp-${maxLines}`;
}

/**
 * ============================================================================
 * Overview Always Show Button Helper
 * ============================================================================
 * Checks whether the user has configured the app to always show the overview
 * modal button on details and person pages (including Seerr) even if the
 * description is short and doesn't overflow.
 *
 * @returns {boolean} True if the button should always be rendered, false otherwise.
 * ============================================================================
 */
export function shouldAlwaysShowOverviewButton() {
    // Read the user-defined toggle preference, off by default (false)
    return storage.getItem('pref:detailsAlwaysShowSeeMore') === 'true';
}

/**
 * ============================================================================
 * Overview Button Label Helper
 * ============================================================================
 * Resolves the appropriate button label based on the active setting:
 * - When pref:detailsAlwaysShowSeeMore is true, returns 'Detailed View'.
 * - When false/default, returns 'Show More'.
 *
 * @returns {string} The localized button text.
 * ============================================================================
 */
export function getOverviewButtonText() {
    // If the always-show toggle is enabled, switch label to "Detailed View"
    if (shouldAlwaysShowOverviewButton()) {
        return i18n.t('DetailedView') || 'Detailed View';
    }

    // Default standard label when truncated
    return i18n.t('ShowMore') || 'Show more';
}

/**
 * ============================================================================
 * Subtitle Provider Name Normalizer
 * ============================================================================
 * Converts internal provider keys from SubBuzz, Bazarr, and Jellyfin plugins
 * into user-friendly branded provider names.
 *
 * @param {string} name - Raw provider identifier
 * @returns {string} Formatted display provider name
 */
export function formatProviderName(name) {
    if (!name) return '';
    const clean = String(name).trim();
    const lower = clean.toLowerCase().replace(/[\s._-]+/g, '');

    switch (lower) {
        case 'opensubtitles':
        case 'opensubtitlescom':
        case 'opensubtitlesorg':
            return 'OpenSubtitles';
        case 'subsource':
        case 'subsourcenet':
            return 'SubSource';
        case 'subdl':
        case 'subdlcom':
            return 'SubDL';
        case 'yifysubtitles':
        case 'yify':
            return 'YIFY Subtitles';
        case 'addic7ed':
        case 'addic7edcom':
            return 'Addic7ed';
        case 'subf2m':
        case 'subf2mco':
            return 'Subf2m';
        case 'subssabbz':
            return 'Subs.sab.bz';
        case 'subsunacsnet':
            return 'Subsunacs.net';
        case 'subscene':
        case 'subscenecom':
            return 'Subscene';
        case 'podnapisi':
        case 'podnapisinet':
            return 'Podnapisi';
        case 'titulky':
        case 'titulkycom':
            return 'Titulky';
        case 'supersubtitles':
            return 'SuperSubtitles';
        default:
            return clean;
    }
}

/**
 * ============================================================================
 * Remote Subtitle Metadata Parser
 * ============================================================================
 * Deeply extracts, decodes, and normalizes rich subtitle properties returned by
 * Jellyfin native providers, SubBuzz multi-provider plugin, and Bazarr plugin:
 * - Real underlying sub-providers (e.g., SubSource, SubDL, OpenSubtitles)
 * - AI & Machine translation badges ([AI], [MT], os-auto, etc.)
 * - Hearing Impaired / SDH detection across flags, filenames, and provider IDs
 * - Forced subtitle flags across filenames, flags, and provider IDs
 * - Match percentage scores extracted from numeric fields or provider comments
 * - Uploader / author credits
 * - Formatted download counts with thousands separators
 * - Clean titles stripped of HTML markup and duplicated bracket tags
 * - Status placeholders (e.g., Bazarr background search in progress)
 *
 * @param {Object} r - RemoteSubtitleInfo item
 * @returns {Object} Structured metadata for UI rendering
 */
export function parseSubtitleMetadata(r) {
    if (!r) return {};

    // Detect Bazarr async search placeholders
    const isPlaceholder = !!(r.Id && String(r.Id).startsWith('placeholder_'));
    const rawName = r.Name || '';
    const rawComment = r.Comment || '';
    const rawProvider = r.ProviderName || '';

    // Strip HTML tags from title (SubBuzz supports SubtitleInfoWithHtml)
    let cleanName = rawName.replace(/<[^>]*>/g, '').trim();

    // Parse ID parts if Bazarr formatted: (movie|episode)|id|provider|HI|Forced|subtitle
    const idParts = (r.Id && typeof r.Id === 'string') ? r.Id.split('|') : [];
    const isBazarrId = (idParts[0] === 'movie' || idParts[0] === 'episode') && idParts.length >= 6;
    const bazarrHi = isBazarrId && idParts[3]?.toLowerCase() === 'true';
    const bazarrForced = isBazarrId && idParts[4]?.toLowerCase() === 'true';

    // Hearing Impaired / SDH detection across all provider sources
    const isHearingImpaired = !!(
        r.HearingImpaired ||
        r.IsHearingImpaired ||
        bazarrHi ||
        (r.ThreeLetterISOLanguageName && r.ThreeLetterISOLanguageName.toLowerCase().includes('hi')) ||
        /\b(sdh|hearing impaired|hi)\b/i.test(cleanName) ||
        /\b(sdh|hearing impaired|hi)\b/i.test(rawComment)
    );

    // Forced subtitle detection
    const isForced = !!(
        r.Forced ||
        r.IsForced ||
        bazarrForced ||
        /\bforced\b/i.test(cleanName) ||
        /\bforced\b/i.test(rawComment)
    );

    // AI & Machine Translation detection (SubBuzz tags and os-auto uploaders)
    const isAiTranslated = !!(
        r.AiTranslated ||
        r.MachineTranslated ||
        /\b(?:ai|machine)[ -]?translated\b/i.test(rawComment) ||
        /\[(?:AI|MT)\]/i.test(rawName) ||
        /\b(os-auto)\b/i.test(r.Author || '') ||
        /\b(os-auto)\b/i.test(rawComment)
    );

    const isMachineTranslated = !!(
        r.MachineTranslated ||
        /\bmachine[ -]?translated\b/i.test(rawComment) ||
        /\[MT\]/i.test(rawName)
    );

    // Strip duplicate badge tags from the title now that we render them as badges
    cleanName = cleanName.replace(/^(\[(?:Forced|HI\/SDH|SDH|HI|AI|MT)\]\s*)+/i, '').trim();
    if (!cleanName) cleanName = rawName;

    // Sub-provider and uploader extraction
    let displayProvider = rawProvider;
    let uploader = r.Author || '';

    if (rawProvider && rawProvider.toLowerCase() === 'bazarr') {
        // Bazarr ID pattern: "movie|123|provider|..." or "episode|456|provider|..."
        const idParts = (r.Id || '').split('|');
        let subProvider = '';
        if (idParts.length >= 3 && (idParts[0] === 'movie' || idParts[0] === 'episode')) {
            subProvider = idParts[2];
        }

        // Bazarr Comment format: "{provider} - Score: XX% - by {uploader}"
        const commentParts = rawComment.split(' - ');
        if (!subProvider && commentParts.length > 0 && commentParts[0]) {
            subProvider = commentParts[0].trim();
        }

        // Extract uploader from Bazarr comment if present
        const uploaderMatch = rawComment.match(/by\s+([^\s\-<]+)/i);
        if (uploaderMatch) {
            uploader = uploaderMatch[1].trim();
        }

        if (subProvider) {
            displayProvider = formatProviderName(subProvider);
        } else {
            displayProvider = 'Bazarr';
        }
    } else if (rawProvider && rawProvider.toLowerCase().includes('subbuzz')) {
        // SubBuzz sub-provider resolution
        let subProvider = r.SubBuzzProviderName || '';

        // Check if ID is prefixed by provider key
        if (!subProvider && r.Id) {
            const knownSubbuzz = [
                'Addic7ed', 'OpenSubtitlesCom', 'Subf2m', 'SubDl',
                'SubSource', 'SubsSabBz', 'SubsUnacsNet', 'YifySubtitles', 'Subscene'
            ];
            const found = knownSubbuzz.find((p) => r.Id.startsWith(p));
            if (found) subProvider = found;
        }

        // Extract from comment header "[Provider]" or "<b>[Provider]</b>"
        if (!subProvider) {
            const commentMatch = rawComment.match(/\[([a-zA-Z0-9_.\-]+)\]/);
            if (commentMatch) {
                subProvider = commentMatch[1];
            }
        }

        if (subProvider) {
            displayProvider = formatProviderName(subProvider);
        } else {
            displayProvider = 'SubBuzz';
        }
    } else if (displayProvider) {
        displayProvider = formatProviderName(displayProvider);
    }

    // Match score and hash match resolution
    let score = null;
    let isPerfectMatch = !!r.IsHashMatch;

    if (typeof r.Score === 'number' && !isNaN(r.Score)) {
        score = r.Score <= 1 ? Math.round(r.Score * 100) : Math.round(r.Score);
    }

    // Parse score from comment if not present on top-level object
    if (score === null && rawComment) {
        const scoreMatch = rawComment.match(/Score:\s*([\d\.]+)%?/i);
        if (scoreMatch) {
            const parsedScore = parseFloat(scoreMatch[1]);
            if (!isNaN(parsedScore)) {
                score = parsedScore <= 1 ? Math.round(parsedScore * 100) : Math.round(parsedScore);
            }
        }
    }

    if (score !== null && score >= 100) {
        isPerfectMatch = true;
    }

    let matchBadge = '';
    if (isPerfectMatch) {
        matchBadge = `<span class="track-badge match-badge">★ 100% Match</span>`;
    } else if (score !== null && score > 0) {
        matchBadge = `<span class="track-badge match-badge">${score}% Match</span>`;
    } else if (typeof r.CommunityRating === 'number' && !isNaN(r.CommunityRating) && r.CommunityRating > 0) {
        matchBadge = `<span class="track-badge match-badge">★ ${r.CommunityRating.toFixed(1)}</span>`;
    }

    // Format & framerate & download counts
    const format = (r.Format || '').toUpperCase();
    const frameRate = r.FrameRate ? `${r.FrameRate} fps` : '';
    const downloads = r.DownloadCount != null ? `↓ ${r.DownloadCount.toLocaleString()}` : '';

    return {
        id: r.Id,
        isPlaceholder,
        placeholderComment: rawComment,
        name: cleanName,
        displayProvider,
        uploader,
        format,
        frameRate,
        downloads,
        isHearingImpaired,
        isForced,
        isAiTranslated,
        isMachineTranslated,
        isPerfectMatch,
        score,
        matchBadge
    };
}
