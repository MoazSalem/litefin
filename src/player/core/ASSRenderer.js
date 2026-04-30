/**
 * ASSRenderer — ASS/SSA Subtitle Renderer
 *
 * Renders ASS subtitles as DOM elements overlaid on the video using libjass.
 * libjass uses pure inline styles (no CSS variables, no nesting) making it
 * natively compatible with Tizen 4+ (Chrome 56+).
 *
 * Two rendering modes:
 *   1. HTML5 video: Uses WebRenderer + VideoClock (auto clock sync, manual DOM)
 *   2. Tizen AVPlay: Uses WebRenderer + ManualClock (manual time sync via tick())
 *
 * We always use WebRenderer directly (not DefaultRenderer) because
 * DefaultRenderer replaces the video element in the DOM with its own wrapper,
 * which breaks the player's existing layout and positioning.
 *
 * @module core/ASSRenderer
 */

import libjass from 'libjass';
import 'libjass/libjass.css';
import { logger } from '../../utils/Logger.js';

const log = logger.create('ASSRenderer');


export default class ASSRenderer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element that wraps the video
     * @param {HTMLVideoElement} [options.video] - The video element (for VideoClock sync)
     * @param {number} [options.width] - Video width (required if video not provided)
     * @param {number} [options.height] - Video height (required if video not provided)
     */
    constructor({ container, video, width, height }) {
        // The container that overlaps the video — we render subtitles inside this
        this._container = container;

        // If a video element is provided, we use VideoClock for auto time-sync.
        // Otherwise, ManualClock for Tizen AVPlay.
        this._videoElement = video || null;
        this._isVirtual = !video;

        // Video dimensions (used for calculating subtitle overlay size)
        this._videoWidth = width || 1920;
        this._videoHeight = height || 1080;

        // libjass WebRenderer instance
        this._renderer = null;
        // Clock instance (VideoClock or ManualClock)
        this._clock = null;
        // The wrapper div that libjass manages
        this._wrapper = null;
        // Current font family override (e.g. 'Poppins')
        this._fontFamily = null;
        // Current font class override (e.g. 'font-poppins')
        this._fontClass = null;
        // Store the original raw content for re-parsing on style changes
        this._rawContent = null;
        // Last known playback time for nudging on style change
        this._lastTime = null;

        /*
         * Seek debounce: when the user jumps a chapter or scrubs rapidly,
         * `_onSeeking` fires followed by a burst of `timeupdate` events while
         * the browser re-buffers. Each tick drives libjass ASS cue lookups
         * synchronously on the main thread — the same thread that runs the
         * OSD opacity CSS transition. We debounce seek ticks so that libjass
         * only re-renders once after the seek settles (100ms of silence),
         * freeing the main thread for the OSD animation to complete smoothly.
         */
        this._seekDebounceTimer = null;
        this._isSeeking = false;

        /*
         * Timeupdate throttle: during normal playback we tick libjass at most
         * once every 100ms (matching the AVPlay tick rate and providing
         * sub-100ms subtitle accuracy without excessive main-thread load).
         */
        this._lastTickTime = 0;
        this._tickThrottleMs = 100;

        log.info('ASSRenderer initialized' +
            (this._isVirtual ? ' (AVPlay/ManualClock mode)' : ' (HTML5/VideoClock mode)'));
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Update the current playback time (only used for AVPlay/ManualClock mode).
     * In HTML5 video mode, this is driven by the timeupdate event in _createRenderer().
     *
     * The stored _delaySeconds offset is applied here for both modes.
     * A positive delay means subtitles display later — we subtract from the clock
     * time so libjass "thinks" it's earlier and fires cues later.
     *
     * @param {number} timeSeconds - Current time in seconds
     */
    tick(timeSeconds) {
        this._lastTime = timeSeconds;
        if (this._clock) {
            /*
             * During a seek burst (chapter jump / scrubbing), suppress individual
             * ticks and coalesce them into a single tick 100ms after the seek settles.
             * This prevents libjass from doing repeated synchronous ASS cue layout
             * work while the OSD show animation is also running on the main thread.
             */
            if (this._isSeeking) {
                // Cancel any previous pending debounce
                if (this._seekDebounceTimer) clearTimeout(this._seekDebounceTimer);
                this._seekDebounceTimer = setTimeout(() => {
                    this._isSeeking = false;
                    this._seekDebounceTimer = null;
                    this._doTick(timeSeconds);
                }, 100);
                return;
            }

            /*
             * During normal playback, throttle to _tickThrottleMs (100ms).
             * libjass interpolates between ticks internally, so this doesn't
             * visibly degrade subtitle accuracy while cutting main-thread load.
             */
            const now = Date.now();
            if (now - this._lastTickTime < this._tickThrottleMs) return;
            this._lastTickTime = now;

            this._doTick(timeSeconds);
        }
    }

    /**
     * Internal: apply the delay offset and call clock.tick().
     * Separated so seek debounce and normal throttle share the same path.
     * @param {number} timeSeconds
     * @private
     */
    _doTick(timeSeconds) {
        if (!this._clock) return;
        // Apply the user-set subtitle delay offset.
        // Positive delay → subtract from time → clock runs slower → cues fire later.
        const offsetTime = timeSeconds - (this._delaySeconds || 0);
        try {
            this._clock.tick(offsetTime);
        } catch (err) {
            /*
             * libjass can throw on malformed ASS vector drawing commands (\p tag)
             * where the internal SVG element is undefined. We cannot patch libjass,
             * but we CAN suppress the error so it doesn't spam on every timeupdate.
             * The subtitle simply won't render for that cue rather than crashing the app.
             */
            log.warn('libjass tick error (likely malformed \\p drawing tag):', err.message);
        }
    }

    /**
     * Resize the subtitle area to match current video/container dimensions.
     *
     * @param {number} [width] - New video width (optional, reads from video element)
     * @param {number} [height] - New video height (optional, reads from video element)
     */
    resize(width, height) {
        if (width) this._videoWidth = width;
        if (height) this._videoHeight = height;

        if (this._renderer) {
            this._resizeRenderer();
        }
    }

    /**
     * Load and render an ASS subtitle track.
     * Parses the ASS content and creates the WebRenderer.
     *
     * @param {string} content - Raw ASS/SSA subtitle file content
     */
    async setTrack(content) {
        if (typeof content !== 'string') {
            log.error('setTrack received non-string content:', typeof content);
            throw new Error('Subtitle content must be a string');
        }

        // Destroy any existing renderer before creating a new one
        this.destroy();

        try {
            // Store the original content for later style changes
            this._rawContent = content;

            // Parse the raw ASS content into a structured ASS object
            log.info('Pre-processing ASS content for style enforcement...');
            const processedContent = this._preProcessAssContent(
                content, 
                this._fontFamily, 
                this._fontScale || 1.0, 
                this._outlineThickness || 0.8, 
                this._shadowThickness || 0.5
            );
            
            this._ass = await libjass.ASS.fromString(processedContent);
            log.info(`ASS parsed: ${this._ass.dialogues.length} dialogue lines, ` +
                     `script res: ${this._ass.properties.resolutionX}x${this._ass.properties.resolutionY}`);

            // Create the renderer (always WebRenderer, different clock per mode)
            this._createRenderer();

            log.info('ASS renderer created successfully');
        } catch (err) {
            let errorMsg;
            if (err instanceof Error) {
                errorMsg = `${err.name}: ${err.message}\n${err.stack}`;
            } else if (typeof err === 'object') {
                errorMsg = JSON.stringify(err);
            } else {
                errorMsg = String(err);
            }
            
            // Provide a preview of the content that failed to parse
            const preview = content ? content.substring(0, 300).replace(/\r?\n/g, '\\n') : 'null/empty';
            log.error(`Failed to create ASS renderer. Error: ${errorMsg}`);
            log.error(`Content preview: ${preview}`);
            
            this.destroy();
            throw err;
        }
    }

    /**
     * Set subtitle timing offset.
     * Note: libjass doesn't have a built-in delay property. For ManualClock
     * mode, we offset the time in tick(). For VideoClock mode, this is a no-op
     * for now.
     *
     * @param {number} seconds - Offset in seconds
     */
    setDelay(seconds) {
        this._delaySeconds = seconds || 0;
        log.debug(`Subtitle delay set to ${seconds}s`);
    }

    /**
     * Set a custom font styles on the subtitle wrapper and the ASS object.
     * This allows overriding the embedded ASS fonts with a user-selected font.
     * @param {string} className - CSS class name (e.g. 'font-poppins')
     * @param {string} fontFamily - Raw font family name (e.g. 'Poppins')
     */
    /**
     * Internal helper to apply all current font class, etc.
     * to the wrapper element.
     * @private
     */
    _updateWrapperStyles() {
        if (!this._wrapper) return;

        // Base class
        const classNames = ['libjass-wrapper'];
        if (this._fontClass) classNames.push(this._fontClass);

        // Spacing overrides
        const hasLineHeight = this._lineHeight !== undefined && this._lineHeight !== 0;
        const hasLetterSpacing = this._letterSpacing !== undefined && this._letterSpacing !== 0;
        const hasBottomOffset = this._bottomOffset !== undefined && this._bottomOffset !== 0;

        if (hasLineHeight) {
            this._wrapper.style.setProperty('--ass-vertical-spacing', this._lineHeight + 'px');
            classNames.push('override-line-height');
        } else {
            this._wrapper.style.removeProperty('--ass-vertical-spacing');
        }

        if (hasBottomOffset) {
            this._wrapper.style.setProperty('--ass-bottom-offset', this._bottomOffset + 'px');
            classNames.push('override-bottom-offset');
        } else {
            this._wrapper.style.removeProperty('--ass-bottom-offset');
        }

        if (hasLetterSpacing) {
            this._wrapper.style.setProperty('--ass-letter-spacing', this._letterSpacing + 'px');
            classNames.push('override-letter-spacing');
        } else {
            this._wrapper.style.removeProperty('--ass-letter-spacing');
        }

        this._wrapper.className = classNames.join(' ');
        log.debug(`Wrapper updated: className="${this._wrapper.className}", lineH=${this._lineHeight}, bottom=${this._bottomOffset}, letterS=${this._letterSpacing}`);
    }

    async setFontStyles(className, fontFamily, fontScale = 1.0, outlineThickness = 0.8, shadowThickness = 0.5, lineHeight = 0, letterSpacing = 0, bottomOffset = 0) {
        log.info(`ASSRenderer.setFontStyles: class="${className}", family="${fontFamily}", scale=${fontScale}, outline=${outlineThickness}, shadow=${shadowThickness}, lineH=${lineHeight}, letterS=${letterSpacing}, bottom=${bottomOffset}`);
        this._fontClass = className;
        this._fontFamily = fontFamily;
        this._fontScale = fontScale;
        this._outlineThickness = outlineThickness;
        this._shadowThickness = shadowThickness;
        this._lineHeight = lineHeight;
        this._letterSpacing = letterSpacing;
        this._bottomOffset = bottomOffset;

        this._updateWrapperStyles();

        if (this._rawContent && fontFamily) {
            log.info(`Re-parsing ASS with new font choice: ${fontFamily} (Scale: ${fontScale}, Out: ${outlineThickness}, Shad: ${shadowThickness})`);
            
            // Re-preprocess and re-parse the entire string.
            // This is the most "Nuclear" and definitive way to ensure the new font
            // and border styles are applied throughout the entire track.
            const processedContent = this._preProcessAssContent(this._rawContent, fontFamily, fontScale, outlineThickness, shadowThickness);
            this._ass = await libjass.ASS.fromString(processedContent);

            // Re-creating the renderer is the only way to apply ASS object changes
            // The renderer will now handle its own "nudge" once ready.
            this._createRenderer();
        }
    }

    _preProcessAssContent(content, fontFamily, fontScale = 1.0, outlineThickness = 0.8, shadowThickness = 0.5) {
        if (!content) return content;

        log.info(`Preprocessing ASS content with font="${fontFamily}", scale=${fontScale}, outline=${outlineThickness}, shadow=${shadowThickness}`);

        const lines = content.split(/\r?\n/);

        // =====================================================================
        // Inject missing PlayResX / PlayResY into the [Script Info] section.
        //
        // libjass is strictly unforgiving: if resolutionX or resolutionY is
        // undefined after parsing the whole file it throws "Malformed ASS
        // script." and rejects the entire track.  Jellyfin's FFmpeg extraction
        // pipeline (e.g. remuxing from MKV to TS, or extracting from MP4)
        // often strips these fields from the Script Info block.
        //
        // We scan for their presence upfront and, when absent, inject safe
        // defaults right after the ScriptType declaration so the rest of the
        // pre-processor loop runs on already-valid content.
        // =====================================================================
        // ====================================================================
        // Fix PlayResX / PlayResY — must be present AND non-zero.
        //
        // When libjass encounters PlayResX=0 or PlayResY=0 (explicitly set to
        // zero, or missing entirely) it divides by those values when computing
        // every subtitle position.  This produces Infinity/NaN CSS values which
        // trigger massive browser style-recalculation on EVERY tick, freezing
        // the entire UI whenever the user seeks, chapter-jumps, or scrubs.
        //
        // We also handle Jellyfin's FFmpeg extraction quirk where the resolution
        // fields are completely stripped from the [Script Info] block.
        // ====================================================================

        /**
         * Parse the numeric value from a "PlayResX: NNN" line, or -1 if absent.
         * @param {string} key
         */
        const getPlayRes = (key) => {
            const line = lines.find(l => new RegExp(`^${key}\\s*:`, 'i').test(l.trim()));
            if (!line) return -1; // missing entirely
            return parseInt(line.split(':')[1], 10) || 0; // 0 if value is "0" or NaN
        };

        const resX = getPlayRes('PlayResX');
        const resY = getPlayRes('PlayResY');

        /*
         * The standard ASS specification defaults to 384x288 when PlayRes fields 
         * are missing. If we use video dimensions (e.g. 1920x1080), fonts sized
         * for the smaller 288p canvas will appear tiny on screen. 
         */
        const safeResX = 384;
        const safeResY = 288;

        if (resX <= 0 || resY <= 0) {
            log.warn(`ASS script has invalid PlayRes (${resX}x${resY}) — patching to ${safeResX}x${safeResY}`);

            // Inject after [Script Info] to ensure it's in the correct section
            const scriptInfoIdx = lines.findIndex(l => /^\[Script Info\]/i.test(l.trim()));
            const insertAt = scriptInfoIdx !== -1 ? scriptInfoIdx + 1 : 0;

            // Helper: replace in-place if the line already exists (to avoid duplication)
            const setPlayRes = (key, value) => {
                const idx = lines.findIndex(l => new RegExp(`^${key}\\s*:`, 'i').test(l.trim()));
                if (idx !== -1) {
                    lines[idx] = `${key}: ${value}`;
                } else {
                    lines.splice(insertAt, 0, `${key}: ${value}`);
                }
            };

            setPlayRes('PlayResX', safeResX);
            setPlayRes('PlayResY', safeResY);
        }

        let styleFormat = null;
        let stylesOverridden = 0;

        const processedLines = lines.map(line => {
            const trimmed = line.trim();
            
            // 1. Capture the Styles format line
            if (trimmed.startsWith('Format:') && (trimmed.includes('Outline') || trimmed.includes('Fontname'))) {
                // Ensure we handle both "Format:" and "[V4 Styles]" headers correctly if needed
                // For now we just parse the format line in the Styles section.
                styleFormat = trimmed.substring(trimmed.indexOf(':') + 1).split(',').map(s => s.trim());
                log.debug(`Found Styles Format: ${styleFormat.join(', ')}`);
                return line;
            }
            
            // 2. Override Style definitions
            if (trimmed.startsWith('Style:') && styleFormat) {
                const parts = line.substring(line.indexOf(':') + 1).split(',');
                
                // Override Fontname
                const fontIdx = styleFormat.indexOf('Fontname');
                if (fontIdx !== -1 && fontFamily) {
                    parts[fontIdx] = fontFamily;
                }
                
                // Override Fontsize - Scaling up if a specific boost is requested (e.g. for Noto Arabic)
                const sizeIdx = styleFormat.indexOf('Fontsize');
                if (sizeIdx !== -1 && fontFamily && fontScale !== 1.0) {
                    const originalSize = parseFloat(parts[sizeIdx]);
                    if (!isNaN(originalSize)) {
                        parts[sizeIdx] = (originalSize * fontScale).toFixed(2);
                    }
                }
                
                // Override Outline — null means "don't override; use the value from the ASS file"
                const outlineIdx = styleFormat.indexOf('Outline');
                if (outlineIdx !== -1 && outlineThickness !== null && outlineThickness !== undefined) {
                    parts[outlineIdx] = String(outlineThickness);
                }
                
                // Override Shadow — null means "don't override; use the value from the ASS file"
                const shadowIdx = styleFormat.indexOf('Shadow');
                if (shadowIdx !== -1 && shadowThickness !== null && shadowThickness !== undefined) {
                    parts[shadowIdx] = String(shadowThickness);
                }
                
                stylesOverridden++;
                // Adding a space after "Style: " for standard ASS compatibility
                return 'Style: ' + parts.join(',');
            }

            // 3. Strip problematic inline overrides from Dialogues (\fn, \bord, \shad, etc.)
            if (trimmed.startsWith('Dialogue:')) {
                /*
                 * Strip per-dialogue font/border/shadow overrides that conflict
                 * with the style-level values we enforced above.
                 *
                 * IMPORTANT: Exclude ')' from the match character class so we
                 * never consume the closing paren of a \t() animation block.
                 * Original regex used [^\\}]+ which would swallow ')', silently
                 * corrupting the ASS tag structure in karaoke/fx tracks and
                 * producing garbled positioning for \pos()-based subtitles.
                 */
                return line.replace(/\\(fn|bord|shad|s?out|s?shad)[^\\})]+(?=[\\})])/g, '');
            }

            return line;
        });

        log.info(`ASS Pre-processor: Overrode ${stylesOverridden} style(s) with font "${fontFamily}"`);
        return processedLines.join('\n');
    }

    /**
     * Show subtitles (if hidden).
     */
    show() {
        if (this._wrapper) {
            this._wrapper.style.display = '';
        }
    }

    /**
     * Hide subtitles without destroying the renderer.
     */
    hide() {
        if (this._wrapper) {
            this._wrapper.style.display = 'none';
        }
    }

    /**
     * Clear the current track's internal state (clock, renderer, parsed ASS object)
     * without tearing down the DOM wrapper or unregistering video event listeners.
     *
     * This is the "soft reset" for track switching during the same playback session.
     * Use destroy() for a full cleanup (e.g. on media context change).
     *
     * After clearTrack(), the instance is dormant but reusable — call setTrack()
     * to load a new ASS file into the same wrapper.
     */
    clearTrack() {
        // Stop the clock so libjass stops driving subtitle rendering
        if (this._clock) {
            try {
                this._clock.disable();
            } catch (err) {
                log.warn('clearTrack: error disabling clock:', err);
            }
            this._clock = null;
        }

        // Drop the renderer reference (it holds the libjass WebRenderer)
        if (this._renderer) {
            this._renderer = null;
        }

        // Drop the parsed ASS object and raw content
        this._ass = null;
        this._rawContent = null;

        // Hide the wrapper — clearTrack() means no subtitle is showing
        if (this._wrapper) {
            this._wrapper.style.display = 'none';
        }

        log.info('ASSRenderer track cleared (wrapper and video listeners retained for reuse)');
    }

    /**
     * Destroy the renderer and clean up all resources.
     * Safe to call multiple times.
     */
    destroy() {
        // Remove event listeners for video and window events
        if (this._onMetadata && this._videoElement) {
            this._videoElement.removeEventListener('loadedmetadata', this._onMetadata);
            this._onMetadata = null;
        }

        if (this._videoElement) {
            this._videoElement.removeEventListener('timeupdate', this._onTimeUpdate);
            this._videoElement.removeEventListener('seeking', this._onSeeking);
            this._videoElement.removeEventListener('play', this._onPlay);
            this._videoElement.removeEventListener('pause', this._onPause);
        }

        if (this._onWindowResize) {
            window.removeEventListener('resize', this._onWindowResize);
            this._onWindowResize = null;
        }

        // Cancel any pending seek debounce timers to prevent stale callbacks
        // from calling _doTick() after the renderer has been destroyed.
        if (this._seekDebounceTimer) {
            clearTimeout(this._seekDebounceTimer);
            this._seekDebounceTimer = null;
        }
        this._isSeeking = false;

        // Disable the clock first (stops ticking)
        if (this._clock) {
            try {
                this._clock.disable();
            } catch (err) {
                log.warn('Error disabling clock:', err);
            }
            this._clock = null;
        }

        // Clear the renderer reference
        if (this._renderer) {
            this._renderer = null;
            log.info('ASS renderer destroyed');
        }

        // Remove the wrapper div from the DOM
        if (this._wrapper && this._wrapper.parentNode) {
            this._wrapper.parentNode.removeChild(this._wrapper);
        }
        this._wrapper = null;

        this._ass = null;
    }

    // ========================================================================
    // Private: Renderer Creation
    // ========================================================================

    /**
     * Create the WebRenderer with the appropriate clock.
     *
     * For HTML5 video mode: uses VideoClock (auto-syncs with <video> events)
     * For AVPlay mode: uses ManualClock (driven via tick() calls)
     *
     * We always use WebRenderer directly instead of DefaultRenderer because
     * DefaultRenderer does DOM manipulation (replaces the video element with
     * a wrapper div) that breaks our player's layout. By using WebRenderer,
     * we keep full control of the DOM.
     *
     * @private
     */
    _createRenderer() {
        // IMPORTANT: Thoroughly clean up any previous renderer/clock/DOM
        // This prevents "stacking" where multiple clocks/wrappers fight for resources.
        if (this._clock) {
            try {
                this._clock.disable();
                log.info('Disabled old ASS clock');
            } catch (err) {
                log.warn('Error disabling old clock:', err);
            }
            this._clock = null;
        }

        if (this._renderer) {
            this._renderer = null;
        }

        if (this._wrapper && this._wrapper.parentNode) {
            log.info('Removing old subtitle wrapper');
            this._wrapper.parentNode.removeChild(this._wrapper);
            this._wrapper = null;
        }

        // Create the wrapper div for subtitle rendering
        this._wrapper = document.createElement('div');
        this._wrapper.className = 'libjass-wrapper';
        this._wrapper.style.position = 'absolute';
        this._wrapper.style.top = '0';
        this._wrapper.style.left = '0';
        this._wrapper.style.width = '100%';
        this._wrapper.style.height = '100%';
        this._wrapper.style.pointerEvents = 'none';
        this._wrapper.style.zIndex = '1';
        /*
         * Force LTR on the wrapper regardless of the document direction.
         * libjass uses absolute CSS pixel positioning for \pos() coordinates.
         * If the parent has direction:rtl (e.g. Arabic locale), CSS layout
         * can flip the internal coordinate system, compressing or mirroring
         * karaoke/fx subtitle lines that use individual \pos() per syllable.
         */
        this._wrapper.style.direction = 'ltr';

        // Append to the player container (overlays the video)
        this._container.appendChild(this._wrapper);

        // Re-apply all current settings to the wrapper
        this._updateWrapperStyles();

        // Create the clock based on what mode we're in
        // Create the clock - We now UNIFY on ManualClock for both HTML5 and AVPlay.
        // This avoids the lack of seeking() in VideoClock and gives us perfect control.
        this._clock = new libjass.renderers.ManualClock();
        log.info('Created ManualClock (Unified Strategy)');

        if (this._videoElement) {
            /*
             * CRITICAL: Always remove any previously registered listeners before adding
             * new ones. _createRenderer() can be called multiple times (e.g. from
             * setFontStyles() when the user changes the subtitle font). Without this
             * removal step, every call stacks a new 'timeupdate' listener on top of
             * the old one. Since this._onTimeUpdate is reassigned, destroy() can no
             * longer clean up the old listener reference — causing double-ticking that
             * puts libjass's SVG state machine into a half-initialized state and crashes
             * with "Cannot read properties of undefined (reading 'appendItem')".
             */
            if (this._onTimeUpdate) this._videoElement.removeEventListener('timeupdate', this._onTimeUpdate);
            if (this._onSeeking)    this._videoElement.removeEventListener('seeking', this._onSeeking);
            if (this._onPlay)       this._videoElement.removeEventListener('play', this._onPlay);
            if (this._onPause)      this._videoElement.removeEventListener('pause', this._onPause);

            // Drive the ManualClock via HTML5 Video events.
            // NOTE: All time updates go through this.tick() so the offset is applied.
            this._onTimeUpdate = () => this.tick(this._videoElement.currentTime);
            this._onSeeking = () => {
                /*
                 * Mark that we are in a seek burst. tick() will suppress individual
                 * ticks and debounce into a single tick once the seek settles.
                 * This prevents libjass from hammering the main thread during
                 * rapid seeks (chapter jumps, scrubbing through the seekbar) at
                 * the same moment the OSD is showing its opacity transition.
                 */
                this._isSeeking = true;
                if (this._seekDebounceTimer) clearTimeout(this._seekDebounceTimer);
                // Schedule the debounced tick in case seeked never fires
                this._seekDebounceTimer = setTimeout(() => {
                    this._isSeeking = false;
                    this._seekDebounceTimer = null;
                    if (this._clock) this._doTick(this._videoElement.currentTime);
                }, 150);
            };
            this._onPlay = () => {
                if (this._clock) this._clock.play();
            };
            this._onPause = () => {
                if (this._clock) this._clock.pause();
            };

            this._videoElement.addEventListener('timeupdate', this._onTimeUpdate);
            this._videoElement.addEventListener('seeking', this._onSeeking);
            this._videoElement.addEventListener('play', this._onPlay);
            this._videoElement.addEventListener('pause', this._onPause);

            // Sync initial state
            if (!this._videoElement.paused) {
                this._clock.play();
            }
            this._clock.tick(this._videoElement.currentTime);
        }

        // Renderer settings — disable SVG filters for Tizen compatibility
        // (uses CSS text-shadow instead, which works on Chrome 56+)
        const settings = new libjass.renderers.RendererSettings();
        settings.enableSvg = false;

        // Create WebRenderer: (ass, clock, wrapperDiv, settings)
        this._renderer = new libjass.renderers.WebRenderer(
            this._ass,
            this._clock,
            this._wrapper,
            settings
        );

        // When the renderer is ready (fonts measured, etc.), do initial sizing
        this._renderer.addEventListener('ready', () => {
            log.info('WebRenderer ready, triggering initial resize');

            // Size the subtitle overlay to match the video
            this._resizeRenderer();

            // For ManualClock, start playing (it's paused by default)
            if (this._isVirtual && this._clock) {
                this._clock.play();
            }

            // Nudge the renderer to show subs immediately, especially if paused.
            // Priority: Last tracked tick > Actual video currentTime > 0
            // Route through tick() so the delay offset is applied correctly.
            const nudgeTime = this._lastTime ?? (this._videoElement ? this._videoElement.currentTime : 0);
            log.info(`ASSRenderer: Nudging renderer on ready at ${nudgeTime}s (offset: ${this._delaySeconds || 0}s)`);
            if (this._clock) {
                // Use tick() to ensure the delay offset is applied from the start
                this.tick(nudgeTime);
            }
        });

        // ================================================================
        // Re-resize when video dimensions become available or change.
        // The 'ready' event often fires before loadedmetadata, so
        // videoWidth/Height are 0 at that point.
        // ================================================================
        if (this._videoElement) {
            // Remove any pre-existing loadedmetadata listener before registering a new one
            if (this._onMetadata) {
                this._videoElement.removeEventListener('loadedmetadata', this._onMetadata);
            }
            this._onMetadata = () => {
                log.info('Video metadata loaded, re-resizing subtitle overlay');
                this._resizeRenderer();
            };
            this._videoElement.addEventListener('loadedmetadata', this._onMetadata);

            // If metadata is already loaded (video already playing), resize now
            if (this._videoElement.videoWidth > 0) {
                log.info('Video metadata already available, resizing immediately');
                // Small delay to ensure DOM is settled
                setTimeout(() => this._resizeRenderer(), 100);
            }
        }

        // Re-resize when the window/container changes size
        this._onWindowResize = () => this._resizeRenderer();
        window.addEventListener('resize', this._onWindowResize);
    }

    /**
     * Resize the WebRenderer's subtitle area to match the video dimensions.
     * Accounts for letterboxing when the container aspect ratio differs
     * from the video aspect ratio.
     *
     * @private
     */
    _resizeRenderer() {
        if (!this._renderer || !this._wrapper) return;

        // For HTML5 video, read the actual video element dimensions
        let videoWidth = this._videoWidth;
        let videoHeight = this._videoHeight;
        if (this._videoElement) {
            videoWidth = this._videoElement.videoWidth || this._videoWidth;
            videoHeight = this._videoElement.videoHeight || this._videoHeight;
        }
        
        // Prevent NaN calculations if video dimensions are 0 (e.g. during early initialization or audio-only)
        if (!videoWidth || !videoHeight) {
            videoWidth = 1280;
            videoHeight = 720;
        }

        // Container dimensions (what space we have to render in)
        const containerWidth = this._container.offsetWidth || videoWidth;
        const containerHeight = this._container.offsetHeight || videoHeight;

        // Compute the scale factor to fit video in the container
        // while preserving aspect ratio (letterboxing)
        const ratio = Math.min(
            containerWidth / videoWidth,
            containerHeight / videoHeight
        );

        // Calculate the subtitle overlay size and offset (centered)
        const subsWidth = videoWidth * ratio;
        const subsHeight = videoHeight * ratio;
        const subsLeft = (containerWidth - subsWidth) / 2;
        const subsTop = (containerHeight - subsHeight) / 2;

        log.debug(`Resize: video=${videoWidth}x${videoHeight}, ` +
                  `container=${containerWidth}x${containerHeight}, ` +
                  `subs=${subsWidth.toFixed(0)}x${subsHeight.toFixed(0)}, ` +
                  `offset=(${subsLeft.toFixed(0)},${subsTop.toFixed(0)})`);

        // Tell libjass the subtitle rendering area dimensions + position
        this._renderer.resize(subsWidth, subsHeight, subsLeft, subsTop);
    }
}
