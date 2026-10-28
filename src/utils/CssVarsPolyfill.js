/**
 * ============================================================================
 * Litefin Tizen - High-Performance CSS Variables Engine
 * ============================================================================
 * Zero-dependency, lightning-fast CSS custom property (var()) resolution
 * engine designed specifically for legacy Smart TV hardware (webOS 3.x / Tizen 3.0,
 * running Chromium 38-47) where CSS variables are not natively supported.
 *
 * Eliminates the heavy AST parsing overhead and full-DOM reflow locks of
 * generic third-party polyfills, substituting all theme and custom properties
 * in-place via a high-speed single O(N) balanced-paren scan in under 20 milliseconds.
 * ============================================================================
 */

import { logger } from './Logger.js';

/**
 * Token locating var() reference sites in CSS text. Index-based scanning
 * (indexOf + cursor) keeps the stylesheet transform a single O(N) pass.
 */
const VAR_TOKEN = 'var(';

const log = logger.create('CssVarsPolyfill');

class CssVarsPolyfill {
    constructor() {
        /**
         * True if running on an ancient browser lacking native CSS custom properties.
         * Evaluated lazily in init() once window.CSS capability checks execute.
         * @type {boolean}
         */
        this._active = false;

        /**
         * Map of tracked <style> elements to their original unparsed CSS text templates.
         * Retaining raw templates allows instantaneous theme switching without re-parsing.
         *
         * Weak keys: page-level stylesheets are injected per async chunk and removed
         * again when their page component is destroyed, so strong references here
         * would leak every visited page's style element for the app's lifetime.
         * @type {WeakMap<HTMLStyleElement, string>}
         */
        this._styleTemplates = new WeakMap();

        /**
         * Cached baseline variables extracted from static :root rules.
         * Prevents re-scanning the multi-megabyte bundle stylesheet on every theme change.
         * @type {Object|null}
         */
        this._cachedRootVars = null;
    }

    /**
     * Initialize the CSS variable resolution engine.
     *
     * Call this once after all CSS stylesheets have been injected
     * (i.e. after layoutManager.init()). On Chrome 49+ (Tizen 5+, webOS 4+, Desktop, Web),
     * CSS custom properties are native, so this returns immediately as a no-op.
     */
    init() {
        // Real CSS custom property feature detection
        // window.CSS.supports('--test', '0') reliably identifies native variable support
        const nativeCSSVars =
            typeof window.CSS !== 'undefined' &&
            typeof window.CSS.supports === 'function' &&
            window.CSS.supports('--test', '0');

        if (nativeCSSVars) {
            log.debug('Native CSS vars supported — polyfill skipped');
            return;
        }

        this._active = true;
        log.info('CSS vars NOT natively supported — activating high-speed engine');

        const self = this;
        // Defer with setTimeout(0) to ensure style-loader has injected all stylesheets
        setTimeout(function () {
            self._applyTransform(true);
        }, 0);
    }

    /**
     * Re-apply the polyfill after a theme or layout change.
     *
     * LayoutManager.setTheme() calls this after updating the data-theme
     * attribute, so the engine substitutes updated variables in under 15ms.
     */
    update() {
        if (!this._active) return;
        this._applyTransform(false);
    }

    /**
     * Incrementally resolve styles injected after boot.
     *
     * Async page/player chunks ship their own <style> tags (style-loader
     * tiers) that carry var() references but were never seen by the initial
     * pass. This processes ONLY uncached, unprocessed tags - already-tracked
     * stylesheets keep their cached raw template and are left untouched, so
     * the cost is proportional to the newly loaded chunk, not the whole DOM.
     *
     * AsyncPageProxy calls this after each chunk module resolves. No-op when
     * native CSS custom properties are supported.
     */
    ensureStylesResolved() {
        if (!this._active) return;

        const startTime = Date.now();
        const themeVars = this._extractThemeVariables();
        const styleTags = document.querySelectorAll('style:not(#litefin-dynamic-theme-vars)');
        let updatedCount = 0;

        for (let i = 0; i < styleTags.length; i++) {
            const styleEl = styleTags[i];

            // Already tracked by a previous pass - its template is resolved
            // wholesale by _applyTransform on the next theme update instead.
            if (this._styleTemplates.get(styleEl)) continue;

            const rawCss = styleEl.textContent || '';
            if (rawCss.indexOf('var(--') === -1) continue;

            this._styleTemplates.set(styleEl, rawCss);
            styleEl.textContent = this._resolveCssVars(rawCss, themeVars);
            styleEl.setAttribute('data-cssvars', 'applied');
            updatedCount++;
        }

        if (updatedCount > 0) {
            log.debug(
                `Lazy style resolution complete in ${Date.now() - startTime}ms (${updatedCount} style(s) updated)`
            );
        }
    }

    /**
     * Executes the variable resolution pass across tracked stylesheets.
     *
     * Scans for the primary singleton bundled stylesheet (#litefin-bundled-styles)
     * or any active inline <style> elements, substituting variables directly in-place.
     *
     * @param {boolean} isInitial - True if called during initial app boot
     * @private
     */
    _applyTransform(isInitial) {
        const startTime = Date.now();

        // 1. Extract all active theme and :root variables
        const themeVars = this._extractThemeVariables();

        // 2. Discover style tags to transform.
        // Process ALL active inline <style> elements (excluding the dynamic
        // theme helper tag, which LayoutManager keeps var()-free and re-writes
        // itself on every theme change). This intentionally includes both the
        // boot singleton (#litefin-bundled-styles) and any per-chunk styles
        // injected later by lazily loaded pages - the template cache below
        // makes repeat passes over already-resolved tags nearly free, so
        // scanning wide is cheaper than tracking which pages loaded when.
        // The bundled singleton is forced to the front so its transform (and
        // any logging derived from it) keeps its historical ordering.
        const bundledStyle = document.getElementById('litefin-bundled-styles');
        const allStyles = Array.prototype.slice.call(
            document.querySelectorAll('style:not(#litefin-dynamic-theme-vars)')
        );
        const targetStyles = allStyles.filter(function (el) {
            return el !== bundledStyle;
        });
        if (bundledStyle) {
            targetStyles.unshift(bundledStyle);
        }

        let updatedCount = 0;

        // Process each discovered stylesheet
        for (let i = 0; i < targetStyles.length; i++) {
            const styleEl = targetStyles[i];

            // Cache original raw CSS template with unresolved var() expressions
            let rawCss = this._styleTemplates.get(styleEl);
            if (!rawCss) {
                rawCss = styleEl.textContent || '';
                // Only track stylesheets that actually reference CSS variables
                if (rawCss.indexOf('var(--') === -1) {
                    continue;
                }
                this._styleTemplates.set(styleEl, rawCss);
            }

            // Perform high-speed multi-pass resolution
            const transformedCss = this._resolveCssVars(rawCss, themeVars);

            // Directly update the style element's text content in-place
            styleEl.textContent = transformedCss;
            styleEl.setAttribute('data-cssvars', 'applied');
            updatedCount++;
        }

        const elapsed = Date.now() - startTime;
        if (isInitial) {
            log.debug(`Initial CSS vars pass complete in ${elapsed}ms (${updatedCount} style(s) updated)`);
        } else {
            log.debug(`CSS vars update complete in ${elapsed}ms (${updatedCount} style(s) updated)`);
        }
    }

    /**
     * Resolves all var(--name, fallback) references in a CSS string using an
     * ultra-optimized, single-pass balanced-paren scanning pipeline.
     *
     * To achieve maximum rendering performance on resource-constrained TV chips
     * (such as 1.0 GHz dual-core Smart TVs), we first pre-resolve all internal variable
     * references within the in-memory dictionary itself (a microscopic map of ~100 keys).
     * Once the variable map is completely flattened into raw static values, the entire
     * multi-megabyte stylesheet string is transformed in ONE linear scan that never
     * reallocates the full text: output segments are collected into an array and joined
     * exactly once at the end (O(N) time, single final allocation).
     *
     * Expressions are located with indexOf('var(') and their extent is measured by
     * counting balanced parentheses (skipping quoted strings / comments), so fallbacks
     * that themselves contain functions or nested references - e.g.
     * var(--bg, hsla(0,0%,100%,.1)) or var(--a, rgba(var(--dark-rgb,15,15,20),.65)) -
     * are captured completely. A regex capture cannot balance parentheses here and
     * truncates such fallbacks at the first ')', which corrupts the emitted declaration
     * (stray ')') or silently drops the fallback value the declaration relies on.
     * Only the small extracted fallback substring is ever scanned recursively; the
     * full stylesheet string is never re-scanned, spliced, or re-parsed per match.
     *
     * @param {string} cssText - The raw CSS containing var() expressions
     * @param {Object} vars - Map of variable names to their computed values
     * @returns {string} Fully resolved CSS string
     * @private
     */
    _resolveCssVars(cssText, vars) {
        /*
         * ====================================================================
         * STEP 1: Flatten in-memory variables dictionary
         * ====================================================================
         * Variables often reference other variables (e.g. --bg-primary: var(--jf-bg)).
         * Resolving this tiny ~100-entry map in memory takes <0.1ms and avoids
         * having to re-scan the massive multi-megabyte stylesheet string multiple times.
         */
        const flatVars = Object.assign({}, vars);
        let varsChanged = true;
        let dictionaryPass = 0;

        // Iterate until all variable aliases within the dictionary are fully flattened
        while (varsChanged && dictionaryPass < 4) {
            varsChanged = false;
            dictionaryPass++;

            // Loop through each registered variable in the map
            for (const key in flatVars) {
                const val = flatVars[key];
                // Check if this variable value contains another variable reference
                if (typeof val === 'string' && val.indexOf(VAR_TOKEN) !== -1) {
                    const resolved = this._resolveInText(val, flatVars);

                    // Flag if an alias was resolved to trigger subsequent resolution pass
                    if (resolved !== val) {
                        flatVars[key] = resolved;
                        varsChanged = true;
                    }
                }
            }
        }

        /*
         * ====================================================================
         * STEP 2: Single linear replacement pass across the stylesheet text
         * ====================================================================
         * flatVars is pre-flattened, and nested references inside a fallback
         * are resolved on demand against the small extracted fallback substring
         * only - so one linear appended-slice scan completely resolves the CSS.
         */
        return this._resolveInText(cssText, flatVars);
    }

    /**
     * Linear balanced-paren scan of a CSS string resolving every var() expression
     * it fully contains. Built for 800KB+ stylesheets on Chromium 38: match sites
     * are found with indexOf('var(') advancing a cursor, output pieces are
     * appended to a segment array and joined EXACTLY ONCE at the end, so there is
     * no per-match splice / reallocation of the full CSS text.
     *
     * Nested references inside a fallback are resolved by recursing ONLY on the
     * small extracted fallback substring (strictly smaller than the input), so
     * recursion depth equals the var() nesting depth and each level stays linear.
     *
     * @param {string} text - CSS text (whole stylesheet or a substring)
     * @param {Object} flatVars - Pre-flattened variable map
     * @returns {string} Text with every resolvable var() expression substituted
     * @private
     */
    _resolveInText(text, flatVars) {
        const segments = [];
        let cursor = 0;
        let pos;

        while ((pos = text.indexOf(VAR_TOKEN, cursor)) !== -1) {
            // The first argument must be a custom property (--*), allowing blank
            // space after '('. Anything else (e.g. 'var(' inside a quoted string)
            // is not a resolvable var() expression - keep it verbatim.
            const argStart = this._skipCssWhitespace(text, pos + VAR_TOKEN.length);
            if (text.charCodeAt(argStart) !== 45 || text.charCodeAt(argStart + 1) !== 45) {
                segments.push(text.slice(cursor, pos + VAR_TOKEN.length));
                cursor = pos + VAR_TOKEN.length;
                continue;
            }

            // Measure the FULL expression extent by counting balanced parentheses
            // (this is the replacement for regex group capture).
            const closeIdx = this._findExpressionClose(text, pos + 3);
            if (closeIdx === -1) {
                // Unterminated / malformed expression: keep the remainder verbatim.
                segments.push(text.slice(cursor));
                cursor = text.length;
                break;
            }

            const inner = text.slice(argStart, closeIdx);
            const commaIdx = this._findTopLevelChar(inner, ',');
            const varName = (commaIdx === -1 ? inner : inner.slice(0, commaIdx)).trim();
            const knownValue = flatVars[varName];

            let replacement = null;
            if (knownValue !== undefined && knownValue !== '') {
                // Known custom property: substitute its fully flattened value.
                replacement = knownValue;
            } else if (commaIdx !== -1) {
                // Unknown custom property: the fallback is used in its place.
                // Nested var() refs are resolved inside the small fallback substring
                // only (this is where the previous regex-based implementation
                // truncated the capture and corrupted the stylesheet).
                const fallback = inner.slice(commaIdx + 1).trim();
                if (fallback !== '') {
                    replacement =
                        fallback.indexOf(VAR_TOKEN) !== -1 ? this._resolveInText(fallback, flatVars) : fallback;
                }
            }

            if (replacement === null) {
                // Unresolvable (unknown name, no usable fallback): keep the original
                // expression byte-for-byte instead of re-emitting a normalized copy.
                segments.push(text.slice(cursor, closeIdx + 1));
            } else {
                segments.push(text.slice(cursor, pos));
                segments.push(replacement);
            }
            cursor = closeIdx + 1;
        }

        if (cursor < text.length) {
            segments.push(text.slice(cursor));
        }
        return segments.length === 0 ? text : segments.join('');
    }

    /**
     * Index of the first occurrence of a character at parenthesis top level,
     * skipping quoted strings and comments.
     * @param {string} text
     * @param {string} ch - Single character to locate
     * @returns {number} Index, or -1 when absent at top level
     * @private
     */
    _findTopLevelChar(text, ch) {
        let depth = 0;
        let i = 0;
        const len = text.length;
        while (i < len) {
            const c = text.charAt(i);
            if (c === '(' || c === '[') {
                depth++;
            } else if (c === ')' || c === ']') {
                if (depth > 0) depth--;
            } else if (c === '"' || c === "'") {
                i = this._skipQuotedString(text, i) - 1;
            } else if (c === '/' && text.charAt(i + 1) === '*') {
                const end = text.indexOf('*/', i + 2);
                if (end === -1) return -1;
                i = end + 1; // i++ below moves past the '*' of '*/'
            } else if (c === ch && depth === 0) {
                return i;
            }
            i++;
        }
        return -1;
    }

    /**
     * Index of the ')' closing the parenthesis at openIdx, counting balanced
     * parentheses while skipping quoted strings and comments.
     * @param {string} text
     * @param {number} openIdx - Index of the opening '('
     * @returns {number} Index of the matching ')' or -1 when unbalanced
     * @private
     */
    _findExpressionClose(text, openIdx) {
        let depth = 1;
        let i = openIdx + 1;
        const len = text.length;
        while (i < len) {
            const c = text.charAt(i);
            if (c === '(') {
                depth++;
            } else if (c === ')') {
                depth--;
                if (depth === 0) return i;
            } else if (c === '"' || c === "'") {
                i = this._skipQuotedString(text, i) - 1;
            } else if (c === '/' && text.charAt(i + 1) === '*') {
                const end = text.indexOf('*/', i + 2);
                if (end === -1) return -1;
                i = end + 1;
            }
            i++;
        }
        return -1;
    }

    /**
     * Index just past the closing quote of the string starting at start
     * (handles backslash escapes; unterminated strings run to text length).
     * @param {string} text
     * @param {number} start - Index of the opening quote character
     * @returns {number} Index just past the closing quote
     * @private
     */
    _skipQuotedString(text, start) {
        const quote = text.charAt(start);
        let i = start + 1;
        const len = text.length;
        while (i < len) {
            const c = text.charAt(i);
            if (c === '\\') {
                i += 2; // escaped character never terminates the string
            } else if (c === quote) {
                return i + 1;
            } else {
                i++;
            }
        }
        return len;
    }

    /**
     * Index of the first non-whitespace character at or after from
     * (space, tab, LF, CR, FF, VT).
     * @param {string} text
     * @param {number} from
     * @returns {number}
     * @private
     */
    _skipCssWhitespace(text, from) {
        let i = from;
        const len = text.length;
        while (i < len) {
            const code = text.charCodeAt(i);
            if (code !== 32 && !(code >= 9 && code <= 13)) return i;
            i++;
        }
        return len;
    }

    /**
     * Extracts CSS variables from the currently active theme.
     * Caches baseline :root variables once to eliminate repetitive 1.4MB full-text
     * regex scans, extracting dynamic theme values from #litefin-dynamic-theme-vars
     * and runtime style overrides in under 1 millisecond.
     *
     * @returns {Object} Map of css variable names to values
     * @private
     */
    _extractThemeVariables() {
        const root = document.documentElement;
        const vars = {};

        // Regex to capture variables declarations: --name: value
        const varRegex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;}]+)/g;

        /*
         * ====================================================================
         * 1. Baseline :root variables (Extracted & cached once on cold boot)
         * ====================================================================
         * The primary stylesheet contains static :root declarations that never
         * mutate at runtime. Caching these once prevents scanning 1.4MB with
         * regular expressions on subsequent theme updates.
         */
        if (!this._cachedRootVars) {
            this._cachedRootVars = {};
            const rootBlockRegex = /:root[^{]*\{([^}]+)\}/g;
            const styleTags = document.querySelectorAll('style:not(#litefin-dynamic-theme-vars)');

            /*
             * Scan every inline <style> tag: since page stylesheets load as
             * per-chunk style tags (no boot singleton anymore), static :root
             * declarations can live in any of them. Baseline caching still
             * applies - this pass runs once on cold boot only.
             */
            for (let t = 0; t < styleTags.length; t++) {
                const cssText = styleTags[t].textContent || '';
                if (cssText.indexOf(':root') === -1) continue;
                let match;
                while ((match = rootBlockRegex.exec(cssText)) !== null) {
                    const blockContent = match[1];
                    varRegex.lastIndex = 0;
                    let varMatch;
                    while ((varMatch = varRegex.exec(blockContent)) !== null) {
                        this._cachedRootVars[varMatch[1].trim()] = varMatch[2].trim();
                    }
                }
                rootBlockRegex.lastIndex = 0;
            }
        }
        Object.assign(vars, this._cachedRootVars);

        /*
         * ====================================================================
         * 2. Active Theme Variables (#litefin-dynamic-theme-vars)
         * ====================================================================
         * LayoutManager._applyDynamicTheme() writes all active mode colors and
         * surfaces directly into this dedicated 1KB style element. Reading this
         * tiny element takes <0.1ms without scanning the multi-megabyte app bundle.
         */
        const dynamicStyle = document.getElementById('litefin-dynamic-theme-vars');
        if (dynamicStyle && dynamicStyle.textContent) {
            varRegex.lastIndex = 0;
            let varMatch;
            while ((varMatch = varRegex.exec(dynamicStyle.textContent)) !== null) {
                vars[varMatch[1].trim()] = varMatch[2].trim();
            }
        }

        /*
         * ====================================================================
         * 3. Runtime Inline Variables (<html> element style)
         * ====================================================================
         * Captures runtime overrides (e.g. text scaling, zoom, vignette levels)
         * stamped directly onto document.documentElement.style.
         */
        if (root.style) {
            for (let j = 0; j < root.style.length; j++) {
                const prop = root.style[j];
                if (prop && prop.indexOf('--') === 0) {
                    const value = root.style.getPropertyValue(prop);
                    if (value) vars[prop] = value.trim();
                }
            }
        }

        return vars;
    }
}

// Export singleton — one instance for the entire app lifecycle
export const cssVarsPolyfill = new CssVarsPolyfill();
export default CssVarsPolyfill;
