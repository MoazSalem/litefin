import { logger } from './Logger.js';
import { state } from '../core/StateManager.js';
import { api } from '../api/index.js';
import { storage } from './StorageService.js';

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
            baloo: 'Baloo Bhaijaan 2',
            opendyslexic: 'OpenDyslexic',
            atkinson: 'Atkinson Hyperlegible',
            'poiret-one': 'Poiret One',
            'zen-kaku-gothic-new': 'Zen Kaku Gothic New',
            'fallback-font': 'Jellyfin Fallback Font'
        };

        // Cache for successfully preloaded static fonts to prevent redundant DOM/API calls
        this._loadedStaticFonts = new Set();

        // Track all blob: URLs created for container fonts so we can revoke
        // them on cleanup and avoid memory leaks across media sessions.
        this._blobUrls = new Set();

        // Dynamically fetched server fallback font URL
        this._fallbackFontUrl = null;
    }

    /**
     * Retrieve the dynamically fetched server fallback font URL
     * @returns {string|null} The fallback font URL
     */
    getFallbackFontUrl() {
        return this._fallbackFontUrl;
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
        log.debug('Container font blob URLs cleared.');
    }

    /**
     * =========================================================================
     * getContainerFontUrls
     * =========================================================================
     * Returns a flat array of all active container-embedded font blob URLs currently
     * stored in the session cache. This allows the WASM subtitle renderer
     * (libass-wasm / SubtitlesOctopus) to resolve and draw custom typesetting
     * files directly.
     * =========================================================================
     * @returns {string[]} Array of active blob URLs
     */
    getContainerFontUrls() {
        return Array.from(this._blobUrls);
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
     * @param {boolean} [forceReload=false]
     * @returns {Promise<boolean>}
     */
    async loadFont(fontId, forceReload = false) {
        if (!fontId || !this._fontMap[fontId]) return false;
        if (this._loadedStaticFonts.has(fontId) && !forceReload) return true;

        /*
         * -------------------------------------------------------------
         * Special Handling: Jellyfin Server Fallback Font
         * -------------------------------------------------------------
         * If the requested font is the server fallback font, we construct
         * the authenticated retrieval URL dynamically and load it via
         * CSS FontFace API or style tag injection fallback.
         * -------------------------------------------------------------
         */
        if (fontId === 'fallback-font') {
            try {
                const token = api.accessToken;
                if (!token || !api.serverUrl) {
                    log.warn('Cannot load fallback font: serverUrl or accessToken missing');
                    return false;
                }

                // Query the list of fallback fonts from the server
                const fonts = await api.get('/FallbackFont/Fonts');
                if (!fonts || !fonts.length) {
                    log.warn('No fallback fonts returned from server');
                    return false;
                }

                // Retrieve the user selected font name, falling back to the first font from the server list
                const userSelectedFont = storage.getItem('pref:jellyfinFallbackFont');
                let fontName = '';
                if (userSelectedFont && fonts.some(f => f.Name === userSelectedFont)) {
                    fontName = userSelectedFont;
                } else {
                    fontName = fonts[0].Name;
                }
                
                if (!fontName) {
                    log.warn('Invalid fallback font name in server response');
                    return false;
                }
                
                const serverInfo = state.get('server:info') || {};
                const isEmbyInstance = !!(
                    serverInfo.ServerName &&
                    (!serverInfo.ProductName || serverInfo.ProductName.toLowerCase().includes('emby'))
                );
                const authKey = isEmbyInstance ? 'api_key' : 'ApiKey';
                const url = `${api.serverUrl}/FallbackFont/Fonts/${encodeURIComponent(fontName)}?${authKey}=${encodeURIComponent(token)}`;

                log.debug(`Downloading Jellyfin fallback font binary from: ${url}`);
                
                // Download the font binary to create a clean blob URL, preventing FS errors in WASM worker
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const buffer = await response.arrayBuffer();
                const blob = new Blob([buffer], { type: response.headers.get('content-type') || 'font/ttf' });
                
                // Revoke the old fallback font URL if it exists to avoid memory leaks
                if (this._fallbackFontUrl) {
                    try {
                        URL.revokeObjectURL(this._fallbackFontUrl);
                    } catch (_) {
                        /* ignore */
                    }
                }
                
                const blobUrl = URL.createObjectURL(blob);
                this._fallbackFontUrl = blobUrl;

                log.debug(`Loading Jellyfin fallback font "${fontName}" from blob URL: ${blobUrl}`);

                if (window.FontFace && document.fonts) {
                    const fontFace = new FontFace('Jellyfin Fallback Font', `url("${blobUrl}")`);
                    await fontFace.load();
                    document.fonts.add(fontFace);
                    log.info(`Jellyfin fallback font "${fontName}" loaded successfully via FontFace API`);
                    this._loadedStaticFonts.add(fontId);
                    return true;
                } else {
                    const styleId = 'jellyfin-fallback-font-style';
                    if (!document.getElementById(styleId)) {
                        const style = document.createElement('style');
                        style.id = styleId;
                        style.textContent = `
                            @font-face {
                                font-family: "Jellyfin Fallback Font";
                                src: url("${blobUrl}");
                            }
                        `;
                        document.head.appendChild(style);
                        log.info(`Jellyfin fallback font "${fontName}" injected via fallback style tag`);
                    }
                    this._loadedStaticFonts.add(fontId);
                    return true;
                }
            } catch (err) {
                log.error('Failed to load Jellyfin fallback font:', err);
                return false;
            }
        }

        const fontFamily = this._fontMap[fontId];
        log.debug(`Preloading font: ${fontFamily}`);

        try {
            // Method 1: Font Loading API
            if (document.fonts && document.fonts.load) {
                /*
                 * -------------------------------------------------------------
                 * Stage 1: Invoke Font API Pre-load
                 * -------------------------------------------------------------
                 * Tell the browser's layout engine to immediately schedule and
                 * download the specified font-family name binary.
                 * -------------------------------------------------------------
                 */
                await document.fonts.load(`16px "${fontFamily}"`);

                /*
                 * -------------------------------------------------------------
                 * Stage 2: Await Layout Engine Stabilization
                 * -------------------------------------------------------------
                 * Standard Font Face loading is asynchronous. Even though load()
                 * resolved, the engine might not have finished rasterizing or
                 * linking the font layout tables. Awaiting document.fonts.ready
                 * guarantees the font is fully active and ready to draw.
                 * -------------------------------------------------------------
                 */
                if (document.fonts.ready) {
                    await document.fonts.ready;
                }

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

        /*
         * Dynamically select the token query parameter key name.
         * Emby does not return a 'ProductName' in its public (unauthenticated)
         * System Info response, whereas Jellyfin does.
         */
        const serverInfo = state.get('server:info') || {};
        const isEmbyInstance = !!(
            serverInfo.ServerName &&
            (!serverInfo.ProductName || serverInfo.ProductName.toLowerCase().includes('emby'))
        );
        const authKey = isEmbyInstance ? 'api_key' : 'ApiKey';

        // Download all font attachments in parallel.
        // This avoids the major sequential bottleneck when a media container has multiple fonts.
        const downloadPromises = fontAttachments.map(async (font, idx) => {
            const uniqueIndex = font.Index !== undefined ? font.Index : idx + 1;
            let url;
            if (font.DeliveryUrl) {
                url = font.DeliveryUrl.startsWith('http') ? font.DeliveryUrl : `${serverUrl}${font.DeliveryUrl}`;
                const sep = url.includes('?') ? '&' : '?';
                url += `${sep}${authKey}=${encodeURIComponent(authToken)}`;
            } else {
                url = `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Attachments/${uniqueIndex}?${authKey}=${encodeURIComponent(authToken)}`;
            }

            try {
                let res;
                if (typeof AbortController !== 'undefined') {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 5000);
                    res = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeout);
                } else {
                    res = await fetch(url);
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buffer = await res.arrayBuffer();
                return { font, buffer, uniqueIndex };
            } catch (fetchErr) {
                if (fetchErr && fetchErr.name === 'AbortError') {
                    log.warn(`Font attachment ${uniqueIndex} timed out — skipping (probably a transcoded stream).`);
                } else {
                    log.warn(`Failed to download font attachment ${uniqueIndex}:`, fetchErr);
                }
                return null;
            }
        });

        // In parallel, wait for the downloaded files and the ASS font names resolution
        const [downloadedResults, resolvedAssFontnames] = await Promise.all([
            Promise.all(downloadPromises),
            Promise.resolve(assFontnames)
        ]);

        // -----------------------------------------------------------------------
        // Build normalized maps for the ASS Fontnames
        // -----------------------------------------------------------------------
        const assMap = [];
        if (resolvedAssFontnames && resolvedAssFontnames.size > 0) {
            for (const name of resolvedAssFontnames) {
                if (name) {
                    const norm = this._normalizeFontName(name);
                    const core = this._getCoreFontName(norm);
                    assMap.push({ original: name, norm, core });
                }
            }
            // log.debug(`ASS fontname map: ${assMap.length} entries`, assMap.map(a => a.original));
        }
        const loadedFonts = [];

        for (const result of downloadedResults) {
            if (!result) continue;
            const { font, buffer, uniqueIndex } = result;
            try {
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

        /*
         * ---------------------------------------------------------------------
         * Global Font Engine Synchronization
         * ---------------------------------------------------------------------
         * When the 'awaitTracksBeforePlayback' setting is active, we must ensure
         * that the TV browser has completely parsed, validated, and registered
         * all newly added FontFace objects.
         *
         * If the platform supports document.fonts.ready, we block execution
         * here to let the renderer resolve all font descriptors. This prevents
         * layout recalculations and font flashes when the first ASS subtitle
         * frames are rasterized to canvas.
         * ---------------------------------------------------------------------
         */
        if (window.FontFace && document.fonts && document.fonts.ready) {
            try {
                log.debug('Awaiting document.fonts.ready for container fonts...');
                await document.fonts.ready;
                log.debug('All registered container fonts are layout-ready.');
            } catch (readyErr) {
                log.warn('document.fonts.ready failed to resolve:', readyErr);
            }
        }

        return loadedFonts;
    }
}

// Export as singleton
export default new FontLoader();
