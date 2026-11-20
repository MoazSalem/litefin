import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Action Button Label Position Test Suite
 * ============================================================================
 * The details, person and Seerr pages show the focused action button's name
 * under it ("Show Button Names Tooltip"). The action row wraps onto a second
 * row on narrow screens, so the label must hang from the focused button
 * itself in both styles: a label pinned to the first row's height draws the
 * second row's names over the second row of buttons.
 * The page methods under test are taken from the source and run on a stub
 * page (the modules themselves need a full DOM).
 * ============================================================================
 */

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Source of one class method, from its signature to the closing brace at method indentation. */
function extractMethod(source, signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const PAGES = [
    { file: '../src/pages/DetailsPage.js', actionsId: '#actions' },
    { file: '../src/pages/PersonPage.js', actionsId: '#person-fav-actions' },
    { file: '../src/pages/SeerrDetailsPage.js', actionsId: '#actions' }
];

function createPage({ file, actionsId }, tooltipPref) {
    const source = read(file);
    const bar = {
        style: {},
        classes: new Set(),
        classList: {
            add: (c) => bar.classes.add(c),
            remove: (c) => bar.classes.delete(c),
            contains: (c) => bar.classes.has(c)
        }
    };
    const text = { textContent: '' };
    const actions = { contains: () => true, addEventListener() {} };
    const elements = { '#action-tooltip-bar': bar, '#action-tooltip-text': text, [actionsId]: actions };

    const context = vm.createContext({
        storage: { getItem: (key) => (key === 'pref:showActionTooltips' ? tooltipPref : null) },
        eventBus: { on() {}, off() {} },
        document: { activeElement: null, documentElement: { hasAttribute: () => false } },
        window: { matchMedia: () => ({ matches: true }) },
        requestAnimationFrame: () => 0,
        setTimeout: () => 0
    });
    const methods = ['_getActionTooltipsMode() {', '_setupTooltipListener() {'].map((sig) =>
        extractMethod(source, sig)
    );
    const page = vm.runInContext(`({\n${methods.join(',\n')}\n})`, context);
    page.$ = (selector) => elements[selector] || null;
    page._setupTooltipListener();
    return { page, bar, text };
}

/** A 72px action button with its 12px margin, on the first or the wrapped second row. */
function actionButton(row, label) {
    return {
        offsetLeft: 112,
        offsetWidth: 72,
        offsetTop: row === 1 ? 12 : 108,
        offsetHeight: 72,
        getAttribute: (name) => (name === 'data-tooltip' ? label : null),
        querySelector: () => null,
        matches: () => true
    };
}

for (const pageInfo of PAGES) {
    const name = pageInfo.file.split('/').pop();

    test(`${name}: the floating label hangs from the focused button on either row`, () => {
        const { page, bar, text } = createPage(pageInfo, null); // floating text is the default

        page._onFocusChangedForTooltip(actionButton(1, 'Mark Played'));
        assert.equal(bar.style.top, '84px', 'first row: label anchored at the button bottom');
        assert.equal(bar.style.left, '148px');
        assert.equal(text.textContent, 'Mark Played');
        assert.ok(bar.classes.has('visible'));

        page._onFocusChangedForTooltip(actionButton(2, 'Subtitle Tracks'));
        assert.equal(bar.style.top, '180px', 'second row: label moves under the second row');
        assert.equal(text.textContent, 'Subtitle Tracks');
    });

    test(`${name}: name cards keep their position under the focused button`, () => {
        const { page, bar } = createPage(pageInfo, 'cards');
        page._onFocusChangedForTooltip(actionButton(2, 'Subtitle Tracks'));
        assert.equal(bar.style.top, '180px');
    });
}

test('details.css: floating text is offset from the button, not pinned to the row', () => {
    const css = read('../src/styles/details.css');
    const start = css.indexOf('.action-btn-tooltip-bar.style-floating,');
    assert.ok(start !== -1, 'floating label rule not found');
    const rule = css.slice(start, css.indexOf('}', start));

    assert.doesNotMatch(rule, /\btop\s*:/, 'the floating style must not override the top set by the page');
    assert.doesNotMatch(rule, /!important/);
    // 18px below the button edge: the 90px it used to sit at on a single row (72px button + 12px margin + 6px)
    assert.match(rule, /\btransform:\s*translate\(-50%,\s*18px\)/);
    assert.match(rule, /-webkit-transform:\s*translate\(-50%,\s*18px\)/);
});
