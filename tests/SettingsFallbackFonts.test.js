import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { getFallbackFontId, getFallbackFontName, getFallbackFontFamily } from '../src/utils/FallbackFonts.js';

const source = readFileSync(new URL('../src/pages/SettingsPage.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default SettingsPage;', 'SettingsPage;');
const fonts = [{ Name: 'UI & 字体.ttf' }, { Name: "Subtitle (O'Brien).otf" }];
const baseOptions = [
    { value: 'poppins', label: 'Poppins' },
    { value: 'fallback-font', label: 'Server fallback' }
];

function createSettings(storageData = {}) {
    const saved = new Map(Object.entries(storageData));
    const buttons = [];
    const loads = [];
    let flushes = 0;
    let modal;
    const context = vm.createContext({
        Page: class {},
        availableLanguages: [],
        logger: { create: () => ({ warn() {}, debug() {}, info() {} }) },
        i18n: { t: (key) => key, ensureBiDi: (value) => value },
        getFallbackFontId,
        getFallbackFontName,
        escapeHtml: (value) =>
            String(value).replace(
                /[&<>"']/g,
                (char) =>
                    ({
                        '&': '&amp;',
                        '<': '&lt;',
                        '>': '&gt;',
                        '"': '&quot;',
                        "'": '&#39;'
                    })[char]
            ),
        FontLoader: {
            getFallbackFonts: async () => fonts,
            loadFont: async (id) => {
                loads.push(id);
                return true;
            }
        },
        storage: {
            getItem: (key) => saved.get(key) ?? null,
            setItem: (key, value) => saved.set(key, String(value)),
            flush: () => {
                flushes++;
            }
        },
        layoutManager: {
            getMediaRowsLayout: () => 'modern',
            setUiFont: (value) => saved.set('litefin:uiFont', value)
        },
        PlayerSettings: {
            get: (key) => saved.get(`player:${key}`),
            set: (key, value) => saved.set(`player:${key}`, value)
        },
        document: { getElementById: () => null },
        eventBus: { emit() {} },
        focusManager: { invalidateCache() {} }
    });
    const page = new (vm.runInContext(source, context))();
    page.$ = () => null;
    page.$$ = (selector) => (selector === '.select-btn' ? buttons : []);
    page._renderSelectionModal = (title, options, currentValue, select) => {
        modal = { options, currentValue, select };
    };

    function addButton(id, value = '', options = baseOptions) {
        const handlers = {};
        const label = { innerText: '' };
        const button = {
            dataset: { id, value, options: JSON.stringify(options) },
            classList: { add() {}, remove() {} },
            addEventListener: (event, handler) => {
                handlers[event] = handler;
            },
            querySelector: () => label,
            closest: () => ({ querySelector: () => ({ textContent: 'Fonts' }) })
        };
        buttons.push(button);
        return { button, label, click: () => handlers.click({}) };
    }
    return { page, saved, loads, addButton, getModal: () => modal, getFlushes: () => flushes };
}

test('all server font files appear in UI, plain subtitle, and ASS font menus', async () => {
    const { page, addButton } = createSettings();
    const buttons = ['ui-font-select', 'subtitle-font-select', 'subtitle-font-ass-select'].map((id) => addButton(id));
    await page._loadFallbackFontOptions();
    for (const { button } of buttons) {
        const options = JSON.parse(button.dataset.options);
        assert.deepEqual(
            options.filter((option) => getFallbackFontName(option.value)).map((option) => option.label),
            fonts.map((font) => font.Name)
        );
        assert.ok(options.some((option) => option.value === 'poppins'));
        assert.ok(options.some((option) => option.value === 'fallback-font'));
    }
});

test('a saved named font retains its label and value before the server font list arrives', () => {
    const { page } = createSettings();
    const id = getFallbackFontId(fonts[1].Name);
    for (const select of ['ui-font-select', 'subtitle-font-select', 'subtitle-font-ass-select']) {
        const html = page._renderDropdown(select, baseOptions, id);
        assert.ok(html.includes(`data-value="${id}"`));
        assert.ok(html.includes('Subtitle (O&#39;Brien).otf'));
    }
    const legacyFile = page._renderDropdown('jellyfin-fallback-font-select', [], fonts[0].Name);
    assert.ok(legacyFile.includes('UI &amp; 字体.ttf'));
});

test('font selection saves the complete per-file ID and restores it on a fresh settings page', async () => {
    const settings = createSettings();
    const ui = settings.addButton('ui-font-select');
    const subtitles = settings.addButton('subtitle-font-select');
    const ass = settings.addButton('subtitle-font-ass-select');
    settings.page._bindDropdownEvents();
    const uiId = getFallbackFontId(fonts[0].Name);
    const subtitleId = getFallbackFontId(fonts[1].Name);
    for (const [button, value] of [
        [ui, uiId],
        [subtitles, subtitleId],
        [ass, uiId]
    ]) {
        await button.click();
        assert.ok(settings.getModal().options.some((option) => option.value === value));
        settings.getModal().select(value);
    }
    assert.equal(settings.saved.get('litefin:uiFont'), uiId);
    assert.equal(settings.saved.get('player:subtitleFont'), subtitleId);
    assert.equal(settings.saved.get('player:subtitleFontAss'), uiId);
    assert.equal(settings.getFlushes(), 2);
    assert.deepEqual(settings.loads, [subtitleId, uiId]);

    const restarted = createSettings(Object.fromEntries(settings.saved));
    const restoredButton = restarted.addButton('subtitle-font-select', restarted.saved.get('player:subtitleFont'));
    restarted.page._bindDropdownEvents();
    await restoredButton.click();
    assert.equal(restarted.getModal().currentValue, subtitleId);
    assert.equal(restoredButton.label.innerText, fonts[1].Name);
});

test('named subtitle fonts supply their own CSS/ASS family and clear it for a bundled font', () => {
    const subtitleSource =
        readFileSync(new URL('../src/utils/SubtitleStyles.js', import.meta.url), 'utf8')
            .replace(/^import .*;\r?\n/gm, '')
            .replace(/^export function /gm, 'function ')
            .replace('export default {', 'const subtitleStyles = {') + '\nsubtitleStyles;';
    let font = getFallbackFontId(fonts[1].Name);
    const styles = vm.runInNewContext(subtitleSource, {
        PlayerSettings: { get: (key) => (key.startsWith('subtitleFont') ? font : undefined) },
        getFallbackFontFamily,
        getFallbackFontName,
        window: { innerHeight: 1080 }
    });
    assert.equal(styles.getFontFamily('subtitleFontAss'), getFallbackFontFamily(font));
    assert.equal(
        styles.getTextStyles().find((style) => style.name === 'fontFamily').value,
        `"${getFallbackFontFamily(font)}", sans-serif`
    );
    font = 'poppins';
    assert.equal(styles.getFontFamily(), 'Poppins');
    assert.equal(styles.getTextStyles().find((style) => style.name === 'fontFamily').value, '');
});
