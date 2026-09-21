import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill minimal browser DOM globals so Logger and PlayerSettings initialize cleanly in Node
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' })
};

const { sanitizeSubtitleText } = await import('../src/utils/Utils.js');
const { SubtitleParser } = await import('../src/player/core/SubtitleParser.js');
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');

/**
 * ============================================================================
 * Subtitle Formatting Test Suite
 * ============================================================================
 * Verifies that WebVTT color and class tags (<c.color808080>, <c.yellow>, etc.)
 * are accurately converted into styled color <span> elements across both the
 * parser pipeline and the sanitizeSubtitleText DOM sanitizer, while maintaining
 * strict XSS defenses.
 * ============================================================================
 */

test('subtitleOverrideColors defaults to true in PlayerSettings', () => {
    // Clean storage state must yield true
    storageMap.clear();
    assert.equal(PlayerSettings.get('subtitleOverrideColors'), true);
});

test('WebVTT color class tags are converted to styled span elements when override is disabled', () => {
    PlayerSettings.set('subtitleOverrideColors', false);

    // 1. Hex foreground color test
    const hexInput = '<c.color808080>Subtitle content</c>';
    const sanitizedHex = sanitizeSubtitleText(hexInput);
    assert.equal(sanitizedHex, '<span style="color: #808080;">Subtitle content</span>');

    // 2. Named WebVTT color test
    const yellowInput = '<c.yellow>Yellow text</c>';
    const sanitizedYellow = sanitizeSubtitleText(yellowInput);
    assert.equal(sanitizedYellow, '<span style="color: #ffff00;">Yellow text</span>');

    // 3. Combined foreground and background colors
    const comboInput = '<c.colorFFFFFF.bg_color000000>High contrast text</c>';
    const sanitizedCombo = sanitizeSubtitleText(comboInput);
    assert.equal(sanitizedCombo, '<span style="color: #ffffff; background-color: #000000;">High contrast text</span>');

    // 4. Multiple / nested styling tags
    const nestedInput = '<i><c.colorE5E5E5>Italic light grey</c></i>';
    const sanitizedNested = sanitizeSubtitleText(nestedInput);
    assert.equal(sanitizedNested, '<i><span style="color: #e5e5e5;">Italic light grey</span></i>');

    // Reset back to default
    PlayerSettings.set('subtitleOverrideColors', true);
});

test('SubtitleParser converts WebVTT cues and preserves styles regardless of override setting', () => {
    // Override is ON by default
    assert.equal(PlayerSettings.get('subtitleOverrideColors'), true);

    const vttContent = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c.color808080>Subtitle content</c>
`;
    // Parser must retain full color markup so cues in memory don't lose author styling
    const cues = SubtitleParser.parse(vttContent);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, '<span style="color: #808080;">Subtitle content</span>');
});

test('Toggling override setting during playback dynamically toggles colors when starting with override ON', () => {
    const vttContent = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c.color808080>Subtitle content</c>
`;
    // 1. Start playback with override ON (default)
    PlayerSettings.set('subtitleOverrideColors', true);
    const cues = SubtitleParser.parse(vttContent);
    assert.equal(cues[0].text, '<span style="color: #808080;">Subtitle content</span>');

    // Displayed cue with override ON: color is stripped so it inherits Litefin color
    assert.equal(sanitizeSubtitleText(cues[0].text), '<span>Subtitle content</span>');

    // 2. User toggles override to OFF in the OSD during playback
    PlayerSettings.set('subtitleOverrideColors', false);

    // Displayed cue with override OFF: original author color is restored!
    assert.equal(sanitizeSubtitleText(cues[0].text), '<span style="color: #808080;">Subtitle content</span>');

    // 3. User toggles override back to ON in the OSD
    PlayerSettings.set('subtitleOverrideColors', true);

    // Displayed cue with override ON: overridden again
    assert.equal(sanitizeSubtitleText(cues[0].text), '<span>Subtitle content</span>');
});

test('SubtitleParser extracts styles from WebVTT STYLE blocks', () => {
    PlayerSettings.set('subtitleOverrideColors', false);

    const vttContent = `WEBVTT

STYLE
::cue(.c1) {
    color: #ff0000;
    background-color: #000000;
}
::cue(.blue_text) {
    color: #0000ff;
}

00:00:01.000 --> 00:00:04.000
<c.c1>Red on black</c> and <c.blue_text>Blue</c>
`;
    const cues = SubtitleParser.parse(vttContent);
    assert.equal(cues.length, 1);
    assert.equal(
        cues[0].text,
        '<span style="color: #ff0000; background-color: #000000;">Red on black</span> and <span style="color: #0000ff;">Blue</span>'
    );

    PlayerSettings.set('subtitleOverrideColors', true);
});

test('Classes without defined colors cleanly fall back without setting color', () => {
    const vttContent = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c.narration>Speaker text</c>
`;
    const cues = SubtitleParser.parse(vttContent);
    assert.equal(cues.length, 1);
    // Preserves class="narration" but does NOT inject an empty or hardcoded color,
    // so it cleanly inherits Litefin's configured subtitle color!
    assert.equal(cues[0].text, '<span class="narration">Speaker text</span>');
});

test('subtitleOverrideColors controls whether tag colors are applied or overridden', async () => {
    // 1. By default (true): tag colors are overridden and stripped, falling back to Litefin color
    storageMap.clear();
    assert.equal(PlayerSettings.get('subtitleOverrideColors'), true);
    const overridden = sanitizeSubtitleText('<c.color808080>Subtitle content</c>');
    assert.equal(overridden, '<span>Subtitle content</span>');

    // Also strip color from legacy font tags
    const fontOverridden = sanitizeSubtitleText('<font color="#ff0000">Red font</font>');
    assert.equal(fontOverridden, '<font>Red font</font>');

    // 2. When override is toggled off (false): tag colors are preserved
    PlayerSettings.set('subtitleOverrideColors', false);
    const preserved = sanitizeSubtitleText('<c.color808080>Subtitle content</c>');
    assert.equal(preserved, '<span style="color: #808080;">Subtitle content</span>');

    // Clean up back to default
    PlayerSettings.set('subtitleOverrideColors', true);
});

test('Sanitization prevents XSS and unsafe script sinks', () => {
    // Malicious script tags must remain escaped and inert
    const scriptInput = '<script>alert(1)</script>';
    assert.equal(sanitizeSubtitleText(scriptInput), '&lt;script&gt;alert(1)&lt;/script&gt;');

    // Unsafe attributes (e.g. onerror, onclick) must not be rendered as active element attributes
    const eventInput = '<span onclick="alert(1)">Click</span>';
    assert.equal(sanitizeSubtitleText(eventInput), '&lt;span onclick=&quot;alert(1)&quot;&gt;Click</span>');
});

test('en-US.json contains SubtitleOverrideColors translation keys', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const enUsPath = path.resolve('src/locales/en-US.json');
    const locales = JSON.parse(fs.readFileSync(enUsPath, 'utf8'));

    assert.equal(locales.SubtitleOverrideColors, 'Override Subtitle Colors');
    assert.ok(locales.SubtitleOverrideColorsDesc.includes('Override colors embedded in subtitles'));
});

test('SubtitleQuickSettings includes overrideColors item with proper options', async () => {
    const SubtitleQuickSettings = (await import('../src/player/osd/SubtitleQuickSettings.js')).default;
    const dummyOsd = { player: { _subtitleManager: { isASSActive: () => false } } };
    const menu = new SubtitleQuickSettings(dummyOsd);
    menu._buildItems();

    const overrideItem = menu.items.find(item => item.key === 'subtitleOverrideColors');
    assert.ok(overrideItem, 'overrideColors item must be present in SubtitleQuickSettings');
    assert.equal(overrideItem.type, 'select');
    assert.equal(overrideItem.labelKey, 'SubtitleOverrideColors');
    assert.deepEqual(overrideItem.options.map(o => o.value), [true, false]);
});
