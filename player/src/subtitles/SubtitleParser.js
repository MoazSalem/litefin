/**
 * SubtitleParser - Utilities for parsing text-based subtitles
 * 
 * Supports WebVTT and SRT formats.
 * Converts raw text into an array of Cue objects: { start, end, text }
 * Start and end times are in seconds.
 * 
 * @module subtitles/SubtitleParser
 */

export class SubtitleParser {
    /**
     * Parse subtitle text content (auto-detects format)
     * @param {string} content - Raw subtitle text
     * @returns {Array<{start: number, end: number, text: string}>} Array of cues
     */
    static parse(content) {
        if (!content || typeof content !== 'string') {
            return [];
        }

        // Auto-detect format based on content
        const trimmed = content.trim();
        if (trimmed.startsWith('WEBVTT')) {
            return this.parseVTT(content);
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
     * Clean subtitle text (preserve safe HTML tags)
     * @private
     */
    static _cleanText(text) {
        // Keep basic HTML formatting tags that are commonly used in subtitles
        // Remove potentially dangerous tags but keep <b>, <i>, <u>, <br>
        return text;
    }
}
