/**
 * ============================================================================
 * Litefin - Inline CSS Minification Loader
 * ============================================================================
 * Minifies raw stylesheet text BEFORE css-loader packages it into a
 * style-loader singleton string. This is required for TV build tiers that
 * inline all CSS into the JS bundle (legacy / ultra-legacy via style-loader):
 * Terser cannot shrink an injected CSS string, so without this loader the raw
 * stylesheet text (comments, whitespace, and the full variant stacks in
 * modern/*.css) ships verbatim inside js/main.js.
 *
 * Also flattens @import chain: css-loader does not re-run the user rule for
 * @imported stylesheets (it resolves them with its own bare request), so a
 * loader that only processes the entry module would miss the imported files.
 * Instead this loader recursively inlines every relative @import into one
 * flat stylesheet, then minifies. After this step no @import remains, so
 * css-loader sees a single stylesheet and no child modules are emitted.
 *
 * Runs the same cssnano 'default' pipeline as CssMinimizerPlugin so inline
 * and extracted outputs remain consistent. Custom properties (:root vars)
 * and var() fallbacks are preserved - the runtime CSS variable transformer
 * (_extractThemeVariables) relies on them.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const cssnano = require('cssnano');

/** @type {import('postcss').Plugin} */
function cssnanoPlugin() {
    const cssnanoFactory = cssnano.default || cssnano;
    return cssnanoFactory({ preset: ['default', { discardComments: { removeAll: true } }] });
}

const IMPORT_RE = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*(?:\)\s*)?[^;]*;/g;

/**
 * Recursively inline relative @import statements into the source text.
 * Sub-imports are resolved relative to the file that declares them.
 * Cycle-safe via a visited set; absolute/url imports are left untouched
 * (css-loader still handles those, and bundles.css only uses relative ones).
 *
 * @param {string} cssText - CSS source text
 * @param {string} currentDir - Directory of the file declaring the imports
 * @param {Set<string>} visited - Already inlined files (cycle protection)
 * @returns {string}
 */
function inlineImports(cssText, currentDir, visited) {
    return cssText.replace(IMPORT_RE, (statement, request) => {
        // Leave the statement intact for css-loader if not a relative import
        if (!request.startsWith('.')) {
            return statement;
        }

        const resolved = path.resolve(currentDir, request);
        if (visited.has(resolved)) {
            return ''; // cycle guard: skip second occurrence
        }
        visited.add(resolved);

        const nested = fs.readFileSync(resolved, 'utf8');
        return inlineImports(nested, path.dirname(resolved), visited);
    });
}

module.exports = function cssMinifyLoader(source) {
    const callback = this.async();

    try {
        const flattened = inlineImports(source, path.dirname(this.resourcePath), new Set([this.resourcePath]));

        postcss([cssnanoPlugin()])
            .process(flattened, {
                from: this.resourcePath,
                map: false
            })
            .then((result) => {
                if (result.warnings && result.warnings.length) {
                    for (const w of result.warnings) {
                        this.emitWarning(new Error('css-minify-loader: ' + w.text));
                    }
                }
                callback(null, result.css);
            })
            .catch((err) => callback(new Error('css-minify-loader: ' + err.message)));
    } catch (err) {
        callback(err);
    }
};
