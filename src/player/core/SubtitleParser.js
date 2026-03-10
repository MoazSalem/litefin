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

        // Skip WEBVTT header line
        if (lines[0] && lines[0].startsWith('WEBVTT')) {
            i++;
        }

        while (i < lines.length) {
            let line = lines[i].trim();

            // Skip empty lines, NOTE blocks, and STYLE blocks
            if (!line || line.startsWith('NOTE') || line.startsWith('STYLE')) {
                i++;
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
                        text: this._cleanText(textLines.join('<br>'))
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
     * Clean subtitle text (preserve safe HTML tags)
     * @private
     */
    static _cleanText(text) {
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
        return text.replace(/\{[^}]*\}/g, '');
    }
}
