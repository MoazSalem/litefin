import { logger } from './Logger.js';

const log = logger.create('FontLoader');

/**
 * ============================================================================
 * FontLoader - Local Font Manager
 * ============================================================================
 * Manages bundled subtitle fonts. Fonts are loaded via @font-face rules
 * in fonts.css which reference local .ttf files in assets/fonts/.
 *
 * This utility provides the mapping between internal font IDs
 * (used by SubtitleStyles) and the actual font family names.
 * ============================================================================
 */
class FontLoader {
    constructor() {
        // Map internal font IDs to their CSS font-family names
        // These names match the @font-face declarations in fonts.css
        this._fontMap = {
            typewriter: 'Courier Prime',
            print: 'Merriweather',
            console: 'Inconsolata',
            cursive: 'Dancing Script',
            casual: 'Patrick Hand',
            smallcaps: 'Cinzel',
            poppins: 'Poppins',
            'noto-arabic': 'Noto Sans Arabic',
            silkscreen: 'Silkscreen',
            'space-grotesk': 'Space Grotesk',
            retrotech: 'RETROTECH',
            kitty: 'Kitty',
            inter: 'Inter',
            proxima: 'Proxima Nova',
            /* ---------------------------------------------------------
               Baloo Bhaijaan 2 - Rounded high-quality font
               --------------------------------------------------------- */
            baloo: 'Baloo Bhaijaan 2',
            opendyslexic: 'OpenDyslexic',
            atkinson: 'Atkinson Hyperlegible'
        };

        // Cache for successfully preloaded static fonts to prevent redundant DOM/API calls
        this._loadedStaticFonts = new Set();

        // Track all blob: URLs created for container fonts so we can revoke
        // them on cleanup and avoid memory leaks across media sessions.
        this._blobUrls = new Set();
    }

    /**
     * Release all blob URLs created for container font attachments.
     * Must be called when the player stops or switches media to prevent leaks.
     */
    clearContainerFonts() {
        for (const url of this._blobUrls) {
            try {
                URL.revokeObjectURL(url);
            } catch (_) {
                /* ignore */
            }
        }
        this._blobUrls.clear();
        log.debug('[FontLoader] Container font blob URLs cleared.');
    }

    /**
     * Get the font family name for a given internal ID
     * @param {string} fontId - Internal font identifier (e.g., 'typewriter')
     * @returns {string|null} The font family name, or null if not mapped
     */
    getFontFamily(fontId) {
        if (!fontId || !this._fontMap[fontId]) return null;
        return this._fontMap[fontId];
    }

    /**
     * Force load a font to ensure it's ready before use.
     * Uses document.fonts.load() or a hidden DOM element to trigger download.
     * @param {string} fontId
     * @returns {Promise<boolean>}
     */
    async loadFont(fontId) {
        if (!fontId || !this._fontMap[fontId]) return false;
        if (this._loadedStaticFonts.has(fontId)) return true;

        const fontFamily = this._fontMap[fontId];
        log.debug(`Preloading font: ${fontFamily}`);

        try {
            // Method 1: Font Loading API
            if (document.fonts && document.fonts.load) {
                await document.fonts.load(`16px "${fontFamily}"`);
                log.debug(`Font loaded via API: ${fontFamily}`);
                this._loadedStaticFonts.add(fontId);
                return true;
            }
        } catch (e) {
            log.warn(`Font API failed, trying DOM fallback: ${e}`);
        }

        // Method 2: Hidden DOM Element (Fallback)
        return new Promise((resolve) => {
            const span = document.createElement('span');
            span.style.fontFamily = `"${fontFamily}"`;
            span.style.opacity = '0';
            span.style.position = 'absolute';
            span.style.pointerEvents = 'none';
            span.textContent = 'FontTest';
            document.body.appendChild(span);

            // Give browser a moment to trigger download/render
            setTimeout(() => {
                document.body.removeChild(span);
                log.debug(`Font loaded via DOM fallback: ${fontFamily}`);
                this._loadedStaticFonts.add(fontId);
                resolve(true);
            }, 100);
        });
    }

    /**
     * Normalize a font name for fuzzy comparison.
     * Strips spaces, hyphens, underscores and lowercases everything so that
     * "LTFinnegan-Medium", "LT Finnegan Medium", and "LTFinneganMedium" all
     * collapse to the same key: "ltfinneganmedium".
     * @param {string} name
     * @returns {string}
     * @private
     */
    _normalizeFontName(name) {
        return (name || '').toLowerCase().replace(/[-_\s]+/g, '');
    }

    /**
     * Aggressively strip weight/style words from a normalized font name
     * to extract its "core" family name for substring matching.
     * e.g. "caveatbrushregular" -> "caveatbrush"
     * e.g. "kalam300" -> "kalam"
     * @param {string} normName
     * @returns {string}
     */
    _getCoreFontName(normName) {
        return normName
            .replace(
                /(regular|bold|italic|ital|light|medium|semibold|heavy|black|thin|100|200|300|400|500|600|700|800|900|fr)$/g,
                ''
            )
            .replace(/b$/g, ''); // catch trailing 'b' for bold
    }

    /**
     * Parses the binary 'name' table of a TTF/OTF file to extract the true internal
     * font family names. This completely eliminates reliance on filenames.
     * @param {ArrayBuffer} buffer
     * @returns {string[]} Array of extracted internal font names
     * @private
     */
    _extractInternalFontNames(buffer) {
        try {
            const view = new DataView(buffer);
            // Must have at least the sfnt header (12 bytes)
            if (buffer.byteLength < 12) return [];

            const numTables = view.getUint16(4);
            let nameOffset = 0;

            for (let i = 0; i < numTables; i++) {
                const offset = 12 + i * 16;
                if (offset + 16 > buffer.byteLength) break;

                const tag = String.fromCharCode(
                    view.getUint8(offset),
                    view.getUint8(offset + 1),
                    view.getUint8(offset + 2),
                    view.getUint8(offset + 3)
                );

                if (tag === 'name') {
                    nameOffset = view.getUint32(offset + 8);
                    break;
                }
            }

            if (!nameOffset || nameOffset + 6 > buffer.byteLength) return [];

            const count = view.getUint16(nameOffset + 2);
            const stringOffset = view.getUint16(nameOffset + 4) + nameOffset;
            const names = new Set();

            for (let i = 0; i < count; i++) {
                const recordOffset = nameOffset + 6 + i * 12;
                if (recordOffset + 12 > buffer.byteLength) break;

                const platformID = view.getUint16(recordOffset);
                const nameID = view.getUint16(recordOffset + 6);
                const length = view.getUint16(recordOffset + 8);
                const offset = view.getUint16(recordOffset + 10);

                // nameID 1 = Font Family, 4 = Full Font Name, 16 = Typographic Family
                // We deliberately exclude nameID 2 (Subfamily) to avoid extracting generic words like "Regular" or "Bold".
                if (nameID === 1 || nameID === 4 || nameID === 16) {
                    if (stringOffset + offset + length > buffer.byteLength) continue;

                    let str = '';
                    if (platformID === 0 || platformID === 3) {
                        // UTF-16BE
                        for (let j = 0; j < length; j += 2) {
                            str += String.fromCharCode(view.getUint16(stringOffset + offset + j));
                        }
                    } else {
                        // MacRoman / ASCII
                        for (let j = 0; j < length; j++) {
                            str += String.fromCharCode(view.getUint8(stringOffset + offset + j));
                        }
                    }
                    if (str) {
                        str = str.replace(/\0/g, '').trim();
                        if (str.length > 0) names.add(str);
                    }
                }
            }

            const result = [];
            if (names && names.forEach) {
                names.forEach((name) => result.push(name));
            }
            return result;
        } catch (e) {
            log.warn('Failed to parse TTF name table:', e);
            return [];
        }
    }

    /**
     * Load fonts attached to a media container.
     * Extracts fonts from MediaAttachments, downloads them to memory, parses their
     * internal metadata to find their true names, and injects them via \@font-face.
     *
     * @param {Array}   attachments   - MediaAttachments array from Jellyfin
     * @param {string}  serverUrl
     * @param {string}  itemId
     * @param {string}  mediaSourceId
     * @param {string}  authToken
     * @param {Set}     [assFontnames] - Exact Fontname strings from the ASS [Styles] section.
     * @returns {Promise<string[]>} Names of successfully registered fonts
     */
    async loadContainerFonts(attachments, serverUrl, itemId, mediaSourceId, authToken, assFontnames = null) {
        if (!attachments || !attachments.length) return [];

        const fontAttachments = attachments.filter((a) => {
            const mime = (a.MimeType || '').toLowerCase();
            const name = (a.Name || a.FileName || '').toLowerCase();
            return (
                mime.includes('font') ||
                mime === 'application/x-truetype-font' ||
                mime === 'application/vnd.ms-opentype' ||
                name.endsWith('.ttf') ||
                name.endsWith('.otf') ||
                name.endsWith('.woff') ||
                name.endsWith('.woff2')
            );
        });

        if (fontAttachments.length === 0) return [];

        // -----------------------------------------------------------------------
        // Build normalized maps for the ASS Fontnames
        // -----------------------------------------------------------------------
        const assMap = [];
        if (assFontnames && assFontnames.size > 0) {
            for (const name of assFontnames) {
                if (name) {
                    const norm = this._normalizeFontName(name);
                    const core = this._getCoreFontName(norm);
                    assMap.push({ original: name, norm, core });
                }
            }
            // log.debug(`ASS fontname map: ${assMap.length} entries`, assMap.map(a => a.original));
        }

        const loadedFonts = [];
        let attachIndex = 0;

        for (const font of fontAttachments) {
            try {
                attachIndex++;
                const uniqueIndex = font.Index !== undefined ? font.Index : attachIndex;

                let url;
                if (font.DeliveryUrl) {
                    url = font.DeliveryUrl.startsWith('http') ? font.DeliveryUrl : `${serverUrl}${font.DeliveryUrl}`;
                    const sep = url.includes('?') ? '&' : '?';
                    url += `${sep}api_key=${encodeURIComponent(authToken)}`;
                } else {
                    url = `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Attachments/${uniqueIndex}?api_key=${encodeURIComponent(authToken)}`;
                }

                // Download the font into memory so we can parse its internal name table.
                // The 5-second timeout prevents runaway fetches when playing a transcoded
                // stream whose original attachment URLs are no longer valid.
                let buffer;
                try {
                    let res;
                    if (typeof AbortController !== 'undefined') {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 5000);
                        res = await fetch(url, { signal: controller.signal });
                        clearTimeout(timeout);
                    } else {
                        // Legacy fallback for WebOS 2/3 (Chrome 38/53)
                        res = await fetch(url);
                    }
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    buffer = await res.arrayBuffer();
                } catch (fetchErr) {
                    if (fetchErr && fetchErr.name === 'AbortError') {
                        log.warn(
                            `[FontLoader] Font attachment ${uniqueIndex} timed out — skipping (probably a transcoded stream).`
                        );
                    } else {
                        log.warn(`[FontLoader] Failed to download font attachment ${uniqueIndex}:`, fetchErr);
                    }
                    continue;
                }

                const internalNames = this._extractInternalFontNames(buffer);
                if (internalNames.length > 0) {
                    // log.debug(`Binary Extracted Names for Attachment ${uniqueIndex}:`, internalNames);
                }

                // Convert buffer to Blob URL for FontFace registration.
                // Track the URL so clearContainerFonts() can revoke it later.
                const blob = new Blob([buffer], { type: font.MimeType || 'font/ttf' });
                const blobUrl = URL.createObjectURL(blob);
                this._blobUrls.add(blobUrl);

                const rawName = font.Name || font.FileName || `ContainerFont${uniqueIndex}`;
                const baseName = rawName.replace(/\.[^/.]+$/, '');
                const normalizedBase = this._normalizeFontName(baseName);
                const coreBase = this._getCoreFontName(normalizedBase);

                // ---------------------------------------------------------------
                // Matching Algorithm:
                // 0. Did the internal names exactly match an ASS name?
                // 1. Exact normalized match ("ltfinneganmedium" === "ltfinneganmedium")
                // 2. Core match ("caveatbrush" === "caveatbrush")
                // 3. Substring match ("oldengl" in "oldenglishtextmt")
                // ---------------------------------------------------------------
                let exactAssName = null;

                // 0. Check internal TTF names first
                for (const internal of internalNames) {
                    const normInternal = this._normalizeFontName(internal);
                    for (const ass of assMap) {
                        if (normInternal === ass.norm) {
                            exactAssName = ass.original;
                            break;
                        }
                    }
                    if (exactAssName) break;
                }

                // If internal names didn't explicitly match an ASS name, fallback to filename guessing
                if (!exactAssName) {
                    for (const ass of assMap) {
                        if (normalizedBase === ass.norm) {
                            exactAssName = ass.original;
                            break;
                        }
                    }
                }
                if (!exactAssName) {
                    for (const ass of assMap) {
                        if (coreBase === ass.core || ass.core.includes(coreBase) || coreBase.includes(ass.core)) {
                            exactAssName = ass.original;
                            break;
                        }
                    }
                }

                const aliasSet = new Set();
                if (exactAssName) aliasSet.add(exactAssName);

                // Add all the true internal names the font claims to be
                for (const name of internalNames) {
                    aliasSet.add(name);
                }

                aliasSet.add(baseName);
                aliasSet.add(baseName.replace(/[-_]+/g, ' ').trim());
                aliasSet.add(baseName.replace(/_/g, ' ').trim());
                aliasSet.add(baseName.replace(/-/g, ' ').trim());
                aliasSet.add(baseName.replace(/[-_\s]+/g, '').trim());

                // URL was resolved at the top of the loop

                // log.debug(`"${baseName}" → ASS match: "${exactAssName || 'none'}" — registering ${aliasSet.size} alias(es)`);

                // ---------------------------------------------------------------
                // Variant Generation:
                // If the filename implies Italic, ONLY register it for style: italic
                // so it doesn't overwrite the Regular font's normal registration.
                // ---------------------------------------------------------------
                const isItalic = normalizedBase.includes('italic') || normalizedBase.includes('ital');
                const isBold =
                    normalizedBase.includes('bold') ||
                    normalizedBase.includes('heavy') ||
                    normalizedBase.includes('black');

                const weights = isBold ? ['bold'] : ['normal', 'bold'];
                const styles = isItalic ? ['italic'] : ['normal', 'italic'];

                const variants = [];
                for (const w of weights) {
                    for (const s of styles) {
                        variants.push({ weight: w, style: s });
                    }
                }

                if (window.FontFace && document.fonts) {
                    // Track this file as loaded once per font FILE (not per alias/variant)
                    // to prevent the returned array being inflated with duplicates.
                    let fileLoaded = false;

                    for (const alias of aliasSet) {
                        let successCount = 0;
                        for (const v of variants) {
                            try {
                                const fontFace = new FontFace(alias, `url("${blobUrl}")`, v);
                                await fontFace.load();
                                document.fonts.add(fontFace);
                                successCount++;
                                fileLoaded = true;
                            } catch (err) {
                                // Only log at ERROR level when the font was explicitly requested
                                // in the ASS style section — otherwise it's just a harmless variant
                                // mismatch (e.g. trying to load an italic variant of a non-italic file).
                                if (exactAssName && alias === exactAssName) {
                                    log.warn(`Variant load failed: ${alias} (${v.weight}/${v.style})`);
                                }
                            }
                        }
                        if (successCount === 0 && exactAssName && alias === exactAssName) {
                            log.error(`FAILED to load any variant for alias "${alias}"`);
                        }
                    }

                    // Push the primary name once per file, not once per alias
                    if (fileLoaded) {
                        loadedFonts.push(exactAssName || baseName);
                    }
                } else {
                    const styleId = `font-attachment-${uniqueIndex}`;
                    if (!document.getElementById(styleId)) {
                        let rules = '';
                        for (const alias of aliasSet) {
                            for (const v of variants) {
                                rules += `
                                    @font-face {
                                        font-family: "${alias}";
                                        font-weight: ${v.weight};
                                        font-style: ${v.style};
                                        src: url("${blobUrl}");
                                    }\n`;
                            }
                        }
                        const style = document.createElement('style');
                        style.id = styleId;
                        style.textContent = rules;
                        document.head.appendChild(style);
                        loadedFonts.push(exactAssName || baseName);
                    }
                }
            } catch (e) {
                log.warn(`Failed to load container font ${font.Name}:`, e);
            }
        }
        return loadedFonts;
    }
}

// Export as singleton
export default new FontLoader();
