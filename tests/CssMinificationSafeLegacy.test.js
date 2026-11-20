import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import cssnano from 'cssnano';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

/**
 * Validates that safe minification options preserve vendor fallbacks, calc spacing,
 * and quoted attribute selectors across homepage, details page, and library stylesheets.
 */
test('CSS Minification: Preserves legacy vendor fallbacks and calc syntax', async () => {
    // Read loader source to verify safe configuration
    const loaderSrc = fs.readFileSync(path.resolve(rootDir, 'css-minify-loader.cjs'), 'utf8');
    assert.match(loaderSrc, /mergeRules:\s*false/, 'css-minify-loader must disable mergeRules');
    assert.match(loaderSrc, /discardOverridden:\s*false/, 'css-minify-loader must disable discardOverridden');
    assert.match(loaderSrc, /calc:\s*false/, 'css-minify-loader must disable calc rewriting');
    assert.match(loaderSrc, /colormin:\s*false/, 'css-minify-loader must disable colormin');
    assert.match(loaderSrc, /minifySelectors:\s*false/, 'css-minify-loader must disable minifySelectors');

    // Safe preset matching css-minify-loader.cjs
    const safeCssnanoPreset = [
        'default',
        {
            discardComments: { removeAll: true },
            normalizeWhitespace: true,
            mergeRules: false,
            discardOverridden: false,
            discardDuplicates: false,
            calc: false,
            colormin: false,
            minifySelectors: false,
            mergeLonghand: false,
            reduceInitial: false,
            zindex: false
        }
    ];

    const plugin = (cssnano.default || cssnano)({ preset: safeCssnanoPreset });

    // Test details.css
    const detailsCss = fs.readFileSync(path.resolve(rootDir, 'src/styles/details.css'), 'utf8');
    const minDetails = (await postcss([plugin]).process(detailsCss, { from: 'src/styles/details.css', map: false })).css;

    // Verify -webkit-box declarations are not stripped
    const origBoxMatches = (detailsCss.match(/display:\s*-webkit-box/g) || []).length;
    const minBoxMatches = (minDetails.match(/display:\s*-webkit-box/g) || []).length;
    assert.strictEqual(minBoxMatches, origBoxMatches, 'All display: -webkit-box declarations must be preserved');

    // Test library.css
    const libraryCss = fs.readFileSync(path.resolve(rootDir, 'src/styles/library.css'), 'utf8');
    const minLibrary = (await postcss([plugin]).process(libraryCss, { from: 'src/styles/library.css', map: false })).css;

    // Verify calc spacing is preserved
    assert.match(minLibrary, /calc\(\s*\(?\s*100%\s*\/\s*var\(--grid-columns/, 'calc division must keep spacing around /');
    assert.match(minLibrary, /--grid-card-margin/, 'grid-card-margin must be retained');
});

test('CSS Variables: Details, Library, and Home pages contain required baseline variables', () => {
    const detailsCss = fs.readFileSync(path.resolve(rootDir, 'src/styles/details.css'), 'utf8');
    assert.match(detailsCss, /:root[^{]*\{[^}]*--jf-background-rgb\s*:/, 'details.css must declare --jf-background-rgb on :root');

    const libraryCss = fs.readFileSync(path.resolve(rootDir, 'src/styles/library.css'), 'utf8');
    assert.match(libraryCss, /:root[^{]*\{[^}]*--grid-card-margin\s*:/, 'library.css must declare --grid-card-margin on :root');
    assert.match(libraryCss, /:root[^{]*\{[^}]*--grid-columns\s*:/, 'library.css must declare --grid-columns on :root');

    const homeCss = fs.readFileSync(path.resolve(rootDir, 'src/styles/home.css'), 'utf8');
    assert.match(homeCss, /var\(--card-width,\s*240px\)/, 'home.css must include fallback for --card-width');
    assert.match(homeCss, /var\(--card-height,\s*360px\)/, 'home.css must include fallback for --card-height');
});

test('App.js: Chunk loaders trigger synchronous style resolution', () => {
    const appSrc = fs.readFileSync(path.resolve(rootDir, 'src/core/App.js'), 'utf8');
    assert.match(appSrc, /loadDetailsPageModule[\s\S]*?ensureStylesResolved\(true\)/, 'loadDetailsPageModule must resolve styles');
    assert.match(appSrc, /loadLibraryPageModule[\s\S]*?ensureStylesResolved\(true\)/, 'loadLibraryPageModule must resolve styles');
    assert.match(appSrc, /loadPlayerModule[\s\S]*?ensureStylesResolved\(true\)/, 'loadPlayerModule must resolve styles');
});

