/**
 * SubtitleParser - Utilities for parsing text-based subtitles
 *
 * Supports WebVTT, SRT, and TTML/DFXP formats.
 * Converts raw text into an array of Cue objects: { start, end, text }
 * Start and end times are in seconds.
 *
 * @module subtitles/SubtitleParser
 */

export class SubtitleParser {
    /**
     * Parse subtitle text content (auto-detects format: VTT, SRT, TTML)
     * @param {string} content - Raw subtitle text
     * @returns {Array<{start: number, end: number, text: string}>} Array of cues
     */
    static parse(content) {
        if (!content || typeof content !== 'string') {
            return [];
        }

        // Auto-detect format based on content header
        const trimmed = content.trim();

        // WebVTT detection
        if (trimmed.startsWith('WEBVTT')) {
            return this.parseVTT(content);
        }

        // TTML/DFXP detection (XML-based subtitle format)
        if (trimmed.startsWith('<?xml') || trimmed.startsWith('<tt') || trimmed.includes('<tt ')) {
            return this.parseTTML(content);
        }

        // Default to SRT parsing
        return this.parseSRT(content);
    }

    /**
     * Parse WebVTT content
     * @param {string} vttText - Raw VTT text
     * @returns {Array<{start: number, end: number, text: string}>}
     */
    static parseVTT(vttText) {
        const cues = [];
        const lines = vttText.split(/\r\n|\r|\n/);
        let i = 0;

        // Extract style declarations from any WebVTT STYLE blocks (::cue rules)
        const styleMap = this._parseVTTStyles(vttText);

        // Skip WEBVTT header line
        if (lines[0] && lines[0].startsWith('WEBVTT')) {
            i++;
        }

        while (i < lines.length) {
            let line = lines[i].trim();

            // Skip empty lines and NOTE blocks
            if (!line || line.startsWith('NOTE')) {
                i++;
                continue;
            }

            // Skip entire STYLE blocks (STYLE until empty line separator)
            if (line.startsWith('STYLE')) {
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    i++;
                }
                continue;
            }

            // Check for timing line (contains -->)
            // If current line doesn't have -->, it might be a cue identifier - skip it
            if (!line.includes('-->')) {
                // Check if next line has timing
                if (i + 1 < lines.length && lines[i + 1].includes('-->')) {
                    i++; // Skip identifier, move to timing line
                    line = lines[i].trim();
                } else {
                    i++;
                    continue;
                }
            }

            // Parse timing: 00:00:00.000 --> 00:00:05.000
            const timingMatch = line.match(
                /((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})/
            );

            if (timingMatch) {
                const start = this._parseVTTTime(timingMatch[1]);
                const end = this._parseVTTTime(timingMatch[2]);

                // Collect text lines until empty line
                i++;
                const textLines = [];
                while (i < lines.length && lines[i].trim() !== '') {
                    textLines.push(lines[i].trim());
                    i++;
                }

                if (textLines.length > 0) {
                    cues.push({
                        start,
                        end,
                        text: this._cleanText(textLines.join('<br>'), styleMap)
                    });
                }
            } else {
                i++;
            }
        }

        return cues;
    }

    /**
     * Parse SRT content
     * @param {string} srtText - Raw SRT text
     * @returns {Array<{start: number, end: number, text: string}>}
     */
    static parseSRT(srtText) {
        const cues = [];

        // Normalize line endings and split by double newlines (block separator)
        const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const blocks = normalized.split('\n\n');

        for (const block of blocks) {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) continue;

            // Find timing line (contains -->)
            let timingLineIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('-->')) {
                    timingLineIndex = i;
                    break;
                }
            }

            if (timingLineIndex === -1) continue;

            // Parse timing: 00:00:00,000 --> 00:00:05,000
            const timingLine = lines[timingLineIndex];
            const timingMatch = timingLine.match(
                /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
            );

            if (timingMatch) {
                const start = this._parseSRTTime(timingMatch[1]);
                const end = this._parseSRTTime(timingMatch[2]);

                // Text is everything after timing line
                const textLines = lines.slice(timingLineIndex + 1);
                if (textLines.length > 0) {
                    cues.push({
                        start,
                        end,
                        text: this._cleanText(textLines.join('<br>'))
                    });
                }
            }
        }

        return cues;
    }

    /**
     * Parse TTML / DFXP content (XML-based subtitle format)
     *
     * TTML (Timed Text Markup Language) uses XML structure with <p> elements
     * inside <body> that carry begin/end or begin/dur attributes for timing.
     * Time formats can be HH:MM:SS.mmm, HH:MM:SS:FF (frames), or offset-time.
     *
     * @param {string} ttmlText - Raw TTML/DFXP XML text
     * @returns {Array<{start: number, end: number, text: string}>}
     */
    static parseTTML(ttmlText) {
        const cues = [];

        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(ttmlText, 'text/xml');

            // Check for parse errors
            const parseError = doc.querySelector('parsererror');
            if (parseError) {
                console.warn('TTML parse error:', parseError.textContent);
                return cues;
            }

            // Find all <p> elements (they contain the subtitle text and timing)
            // TTML can have namespaced elements, so we search broadly
            const paragraphs = doc.getElementsByTagName('p');

            for (let i = 0; i < paragraphs.length; i++) {
                const p = paragraphs[i];

                // Extract timing attributes — TTML uses begin/end or begin/dur
                const beginAttr = p.getAttribute('begin');
                const endAttr = p.getAttribute('end');
                const durAttr = p.getAttribute('dur');

                if (!beginAttr) continue;

                const start = this._parseTTMLTime(beginAttr);
                let end;

                if (endAttr) {
                    end = this._parseTTMLTime(endAttr);
                } else if (durAttr) {
                    // Duration-based: end = begin + duration
                    end = start + this._parseTTMLTime(durAttr);
                } else {
                    // No end time — skip this cue (can't display without duration)
                    continue;
                }

                // Extract text content, preserving line breaks from <br> elements
                const text = this._extractTTMLText(p);

                if (text.trim().length > 0) {
                    cues.push({ start, end, text: this._cleanText(text) });
                }
            }
        } catch (err) {
            console.error('Failed to parse TTML:', err);
        }

        return cues;
    }

    /**
     * Parse VTT timestamp: HH:MM:SS.mmm or MM:SS.mmm
     * @private
     */
    static _parseVTTTime(timeStr) {
        // Handle both comma and dot as decimal separator
        const normalized = timeStr.replace(',', '.');
        const parts = normalized.split(':');
        let seconds = 0;

        if (parts.length === 3) {
            // HH:MM:SS.mmm
            seconds += parseInt(parts[0], 10) * 3600;
            seconds += parseInt(parts[1], 10) * 60;
            seconds += parseFloat(parts[2]);
        } else if (parts.length === 2) {
            // MM:SS.mmm
            seconds += parseInt(parts[0], 10) * 60;
            seconds += parseFloat(parts[1]);
        }

        return seconds;
    }

    /**
     * Parse SRT timestamp: HH:MM:SS,mmm
     * @private
     */
    static _parseSRTTime(timeStr) {
        // SRT uses comma as decimal separator
        return this._parseVTTTime(timeStr.replace(',', '.'));
    }

    /**
     * Parse TTML timestamp.
     * Supports multiple formats:
     * - Clock time: HH:MM:SS.mmm or HH:MM:SS:FF (frames — approximated at 24fps)
     * - Offset time: 123.456s, 123456ms, 1234t (ticks)
     * - Plain seconds: 123.456
     *
     * @param {string} timeStr - TTML time expression
     * @returns {number} Time in seconds
     * @private
     */
    static _parseTTMLTime(timeStr) {
        if (!timeStr) return 0;

        const trimmed = timeStr.trim();

        // Offset-time format: "123.456s" or "123456ms"
        const offsetMatch = trimmed.match(/^([\d.]+)(ms|s|h|m|t)$/);
        if (offsetMatch) {
            const val = parseFloat(offsetMatch[1]);
            const unit = offsetMatch[2];
            switch (unit) {
                case 'h': return val * 3600;
                case 'm': return val * 60;
                case 's': return val;
                case 'ms': return val / 1000;
                case 't': return val / 10000000; // Ticks (100ns units)
                default: return val;
            }
        }

        // Clock-time format: HH:MM:SS.mmm or HH:MM:SS:FF
        const parts = trimmed.split(':');
        if (parts.length >= 3) {
            const hours = parseInt(parts[0], 10) || 0;
            const minutes = parseInt(parts[1], 10) || 0;

            // Third part might be SS.mmm or SS
            // Fourth part (if present) is frames — approximate at 24fps
            let secs = parseFloat(parts[2]) || 0;
            if (parts.length === 4) {
                // SS:FF format — add frames as fraction of a second
                secs = parseInt(parts[2], 10) || 0;
                const frames = parseInt(parts[3], 10) || 0;
                secs += frames / 24; // Approximate at 24fps
            }

            return hours * 3600 + minutes * 60 + secs;
        }

        // Fallback: try parsing as plain seconds
        return parseFloat(trimmed) || 0;
    }

    /**
     * Extract text content from a TTML <p> element, converting
     * <br/> elements to HTML line breaks.
     *
     * @param {Element} element - DOM element to extract text from
     * @returns {string} Extracted text with <br> for line breaks
     * @private
     */
    static _extractTTMLText(element) {
        let text = '';

        for (let i = 0; i < element.childNodes.length; i++) {
            const node = element.childNodes[i];

            if (node.nodeType === Node.TEXT_NODE) {
                // Plain text node
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();

                if (tag === 'br') {
                    // Line break
                    text += '<br>';
                } else if (tag === 'span') {
                    // Inline span — recurse to extract nested text
                    text += this._extractTTMLText(node);
                } else {
                    // Other elements — just grab text content
                    text += node.textContent;
                }
            }
        }

        return text;
    }

    /**
     * Map of standard WebVTT color classes to CSS color hex codes.
     * The W3C WebVTT specification explicitly standardizes 8 base colors.
     */
    static WEBVTT_NAMED_COLORS = {
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
     * Parses WebVTT STYLE blocks and extracts CSS rules mapped by selector / class name.
     * WebVTT specs allow ::cue(.class), ::cue(tag), ::cue { ... } blocks.
     *
     * @param {string} vttText - Full WebVTT content
     * @returns {Object.<string, Object.<string, string>>} Map of className -> CSS style properties
     * @private
     */
    static _parseVTTStyles(vttText) {
        const styleMap = {};
        if (!vttText || typeof vttText !== 'string') return styleMap;

        // Match all STYLE blocks: STYLE followed by CSS declarations until double newline or cue timing
        const styleBlockRegex = /STYLE\b[^\n]*\n([\s\S]*?)(?=(?:\r?\n\r?\n|\r?\n(?:NOTE\b|[0-9a-fA-F-]+\r?\n)?(?:\d{2}:)?\d{2}:\d{2}|$))/g;
        let match;

        while ((match = styleBlockRegex.exec(vttText)) !== null) {
            const cssContent = match[1];
            // Match rule blocks: selector { declarations }
            const ruleRegex = /([^{]+)\{([^}]+)\}/g;
            let ruleMatch;

            while ((ruleMatch = ruleRegex.exec(cssContent)) !== null) {
                const selector = ruleMatch[1].trim();
                const declarations = ruleMatch[2];

                // Parse declarations into key-value map
                const parsedStyles = {};
                const declRegex = /([\w-]+)\s*:\s*([^;]+);?/g;
                let declMatch;
                while ((declMatch = declRegex.exec(declarations)) !== null) {
                    const prop = declMatch[1].trim().toLowerCase();
                    const val = declMatch[2].trim();
                    // Store safe visual properties (color, background-color, background, opacity)
                    if (['color', 'background-color', 'background', 'opacity'].includes(prop)) {
                        parsedStyles[prop] = val;
                    }
                }

                if (Object.keys(parsedStyles).length === 0) continue;

                // Extract target class names from selector:
                // e.g. ::cue(.color808080), ::cue(.c1), .color808080
                const classMatches = selector.match(/\.([a-zA-Z0-9_.-]+)/g);
                if (classMatches) {
                    for (const rawClass of classMatches) {
                        const cleanClass = rawClass.replace('.', '').toLowerCase();
                        styleMap[cleanClass] = { ...(styleMap[cleanClass] || {}), ...parsedStyles };
                    }
                } else if (selector.includes('::cue')) {
                    // Global cue default styles
                    styleMap['__default__'] = { ...(styleMap['__default__'] || {}), ...parsedStyles };
                }
            }
        }

        return styleMap;
    }

    /**
     * Converts WebVTT style and class tags into standard inline HTML elements.
     *
     * In WebVTT (and subtitles transcoded by Jellyfin/ffmpeg or converted from
     * ASS/TTML/CC), colors and formatting are expressed through class spans:
     * - Hex text colors: <c.color808080>Text</c> -> <span style="color: #808080;">Text</span>
     * - Hex background colors: <c.bg_color000000>Text</c> -> <span style="background-color: #000000;">Text</span>
     * - WebVTT STYLE block classes: <c.c1>Text</c> -> <span style="color: #ff0000;">Text</span>
     * - Named WebVTT colors: <c.yellow>Text</c> -> <span style="color: #ffff00;">Text</span>
     * - Named background colors: <c.bg_yellow>Text</c> -> <span style="background-color: #ffff00;">Text</span>
     * - Combined classes: <c.color808080.bg_color000000>Text</c>
     * - Voice tags: <v Speaker>Text</v> -> <span class="cue-voice" title="Speaker">Text</span>
     * - Generic class spans without colors: <c.someclass>Text</c> -> <span class="someclass">Text</span>
     * - Bare spans: <c>Text</c> -> <span>Text</span>
     *
     * When subtitleOverrideColors is disabled (default = false), colors specified in the
     * subtitle file are honored, while untagged/unstyled text cleanly falls back to the
     * user's customized Litefin subtitle color.
     * When subtitleOverrideColors is enabled (true), all embedded tag colors are suppressed
     * so that all subtitle text is cleanly overridden by the user's selected subtitle color.
     *
     * @param {string} text - Raw subtitle text
     * @param {Object.<string, Object.<string, string>>} [styleMap={}] - Parsed STYLE block rules
     * @returns {string} Text with WebVTT tags converted to standard HTML tags
     */
    static _convertWebVTTTags(text, styleMap = {}) {
        if (!text || typeof text !== 'string') return '';

        /* -------------------------------------------------------------
           1. Convert closing </c> and </v> tags to standard </span> tags.
           ------------------------------------------------------------- */
        let result = text.replace(/<\/(?:c|v)>/gi, '</span>');

        /* -------------------------------------------------------------
           2. Convert voice tags: <v Voice Name> or <v.class Voice Name>
           ------------------------------------------------------------- */
        result = result.replace(/<v(?:\.([^\s>]+))?(?:\s+([^>]+))?>/gi, (_match, className, voiceName) => {
            const classes = ['cue-voice'];
            if (className) {
                classes.push(...className.split('.').filter(Boolean));
            }
            const titleAttr = voiceName ? ` title="${voiceName.trim().replace(/"/g, '&quot;')}"` : '';
            return `<span class="${classes.join(' ')}"${titleAttr}>`;
        });

        /* -------------------------------------------------------------
           3. Convert WebVTT <c> and <c.class1.class2...> tags to spans.
           Always preserve the extracted style and color information in
           the parsed cue objects so that in-player settings toggling
           (override on/off) can dynamically re-render on the fly without
           re-fetching or losing the original subtitle author styling.
           ------------------------------------------------------------- */
        result = result.replace(/<c(?:\.([a-zA-Z0-9_.-]+))?>/gi, (_match, classListStr) => {
            if (!classListStr) {
                // Bare <c> tag with no class list
                return '<span>';
            }

            const rawClasses = classListStr.split('.').filter(Boolean);
            const inlineStyles = [];
            const customClasses = [];

            for (const cls of rawClasses) {
                const lower = cls.toLowerCase();

                /* -------------------------------------------------------------
                   A. Check styleMap from WebVTT STYLE blocks
                   ------------------------------------------------------------- */
                if (styleMap && styleMap[lower]) {
                    const s = styleMap[lower];
                    if (s.color) {
                        inlineStyles.push(`color: ${s.color}`);
                    }
                    if (s['background-color']) {
                        inlineStyles.push(`background-color: ${s['background-color']}`);
                    } else if (s.background) {
                        inlineStyles.push(`background-color: ${s.background}`);
                    }
                    continue;
                }

                /* -------------------------------------------------------------
                   B. Check for hex foreground color: e.g. color808080, colorF00
                   ------------------------------------------------------------- */
                const hexColorMatch = lower.match(/^color#?([0-9a-f]{3,8})$/i);
                if (hexColorMatch) {
                    inlineStyles.push(`color: #${hexColorMatch[1]}`);
                    continue;
                }

                /* -------------------------------------------------------------
                   C. Check for hex background color: e.g. bg_color000000, bg_color#000
                   ------------------------------------------------------------- */
                const hexBgMatch = lower.match(/^bg_color#?([0-9a-f]{3,8})$/i);
                if (hexBgMatch) {
                    inlineStyles.push(`background-color: #${hexBgMatch[1]}`);
                    continue;
                }

                /* -------------------------------------------------------------
                   D. Check for standard WebVTT named foreground colors
                   ------------------------------------------------------------- */
                if (SubtitleParser.WEBVTT_NAMED_COLORS[lower]) {
                    inlineStyles.push(`color: ${SubtitleParser.WEBVTT_NAMED_COLORS[lower]}`);
                    continue;
                }

                /* -------------------------------------------------------------
                   E. Check for standard WebVTT named background colors
                   ------------------------------------------------------------- */
                if (lower.startsWith('bg_')) {
                    const bgName = lower.slice(3);
                    if (SubtitleParser.WEBVTT_NAMED_COLORS[bgName]) {
                        inlineStyles.push(`background-color: ${SubtitleParser.WEBVTT_NAMED_COLORS[bgName]}`);
                        continue;
                    }
                }

                /* -------------------------------------------------------------
                   F. Unrecognized semantic class (e.g. .narration, .speaker1)
                   Preserved in class attribute without setting color, guaranteeing
                   a clean fallback to the parent .subtitle-line color.
                   ------------------------------------------------------------- */
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

        return result;
    }

    /**
     * Clean subtitle text (remove ASS tags, convert WebVTT classes/colors to spans)
     * @param {string} text - Raw subtitle line text
     * @param {Object.<string, Object.<string, string>>} [styleMap={}] - Parsed STYLE block rules
     * @returns {string} Sanitized/formatted text
     * @private
     */
    static _cleanText(text, styleMap = {}) {
        if (!text) return '';

        /**
         * 1. Remove ASS/SSA style tags: {...}
         * These often appear in SRT/VTT files that were converted from ASS or
         * when the server delivers transcoded text that still contains styling bits.
         * Example: "{\an8}Hello" -> "Hello"
         * 
         * The regex /\{[^\}]*\}/g is performant as it avoids backtracking issues
         * by matching any character that is NOT a closing brace.
         */
        const strippedAss = text.replace(/\{[^}]*\}/g, '');

        /**
         * 2. Convert WebVTT color and class spans (<c.color808080>, <c.yellow>, STYLE block classes)
         * into styled <span> tags so that inline styling is preserved and rendered.
         */
        return this._convertWebVTTTags(strippedAss, styleMap);
    }
}
