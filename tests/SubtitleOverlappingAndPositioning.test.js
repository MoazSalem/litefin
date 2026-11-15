import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Polyfill minimal browser DOM globals for testing in Node environment
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

const { SubtitleParser } = await import('../src/player/core/SubtitleParser.js');

// Load SubtitleManager class via VM to bypass libjass.css Node ESM import limitation
const subManagerSource = readFileSync(new URL('../src/player/core/SubtitleManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class SubtitleManager', 'class SubtitleManager')
    .replace(/^export .*;\n?/gm, '')
    .replace(/^export default .*;\n?/gm, '');

function createSubtitleManager(options = {}, settingsMock = {}) {
    const settings = {
        subtitleOverlappingCues: true,
        ...settingsMock
    };
    const context = vm.createContext({
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
        FontLoader: { clearContainerFonts() {} },
        PlayerSettings: {
            get: (key) => (key in settings ? settings[key] : 'auto'),
            set: (key, val) => { settings[key] = val; }
        },
        DeliveryMethod: { NONE: 'none', EXTERNAL_TEXT: 'external_text' },
        SubtitleParser,
        Math
    });

    const SubtitleManagerClass = vm.runInContext(subManagerSource + '\nSubtitleManager;', context);
    return new SubtitleManagerClass(options);
}

/**
 * ============================================================================
 * Subtitle Overlapping & Top-Positioning Test Suite
 * ============================================================================
 * Validates that text subtitle tracks (VTT, SRT) accurately parse and retain
 * screen hemisphere placement (top vs bottom) and deliver all concurrently
 * active cues simultaneously during playback without dropping dialogue lines.
 * ============================================================================
 */

test('SubtitleParser: detects top position from WebVTT line percentage settings', () => {
    const vttContent = `WEBVTT

00:18:28.560 --> 00:18:32.230 line:20%
CLAC CLAC

00:18:28.810 --> 00:18:30.980
Qu'est-ce que ça veut dire ?

00:18:35.000 --> 00:18:40.000 line:85%
Bottom subtitle
`;

    // Parse VTT cues
    const cues = SubtitleParser.parse(vttContent);
    assert.equal(cues.length, 3);

    // Cue 1: line:20% is in the top half (< 50%)
    assert.equal(cues[0].text, 'CLAC CLAC');
    assert.equal(cues[0].position, 'top');
    assert.equal(cues[0].start, 1108.56);
    assert.equal(cues[0].end, 1112.23);

    // Cue 2: No line setting defaults to bottom dialogue placement
    assert.equal(cues[1].text, "Qu'est-ce que ça veut dire ?");
    assert.equal(cues[1].position, 'bottom');

    // Cue 3: line:85% is in the bottom half (>= 50%)
    assert.equal(cues[2].text, 'Bottom subtitle');
    assert.equal(cues[2].position, 'bottom');
});

test('SubtitleParser: detects top position from SRT {\\an8}, {\\an7}, {\\an9} tags and strips them', () => {
    const srtContent = `1
00:00:01,000 --> 00:00:04,000
{\\an8}CLAC CLAC

2
00:00:02,000 --> 00:00:05,000
{\\an7}Top Left Sign

3
00:00:03,000 --> 00:00:06,000
{\\an9}Top Right Sign

4
00:00:04,000 --> 00:00:07,000
{\\an2}Bottom Center Dialogue

5
00:00:05,000 --> 00:00:08,000
Standard Untagged Dialogue
`;

    // Parse SRT cues
    const cues = SubtitleParser.parse(srtContent);
    assert.equal(cues.length, 5);

    // Cue 1: {\an8} top-center
    assert.equal(cues[0].text, 'CLAC CLAC');
    assert.equal(cues[0].position, 'top');

    // Cue 2: {\an7} top-left
    assert.equal(cues[1].text, 'Top Left Sign');
    assert.equal(cues[1].position, 'top');

    // Cue 3: {\an9} top-right
    assert.equal(cues[2].text, 'Top Right Sign');
    assert.equal(cues[2].position, 'top');

    // Cue 4: {\an2} bottom-center
    assert.equal(cues[3].text, 'Bottom Center Dialogue');
    assert.equal(cues[3].position, 'bottom');

    // Cue 5: Untagged bottom dialogue
    assert.equal(cues[4].text, 'Standard Untagged Dialogue');
    assert.equal(cues[4].position, 'bottom');
});

test('SubtitleParser: sorts out-of-order cues chronologically by start time', () => {
    const unorderedSrt = `1
00:00:10,000 --> 00:00:15,000
Second cue

2
00:00:05,000 --> 00:00:12,000
First cue
`;

    const cues = SubtitleParser.parse(unorderedSrt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, 'First cue');
    assert.equal(cues[0].start, 5.0);
    assert.equal(cues[1].text, 'Second cue');
    assert.equal(cues[1].start, 10.0);
});

test('SubtitleManager: emits all overlapping cues concurrently without skipping dialogue', () => {
    const capturedEvents = [];

    // Instantiate SubtitleManager with cue event listener
    const manager = createSubtitleManager({
        serverUrl: 'http://localhost:8096',
        authToken: 'test-token',
        onPrimaryCue: (data) => {
            capturedEvents.push(data);
        }
    });

    // Simulate loaded external text subtitle track
    manager._primaryDelivery = 'external_text';

    // Cues matching anime scenario:
    // Cue 0: Long top sign [2] from 10.0s to 25.0s
    // Cue 1: Dialogue [3] from 12.0s to 16.0s
    // Cue 2: Dialogue [4] from 18.0s to 22.0s
    // Cue 3: Dialogue [10] from 23.0s to 28.0s
    // Cue 4: Overlapping speaker [11] from 24.0s to 27.0s
    const cues = [
        { start: 10.0, end: 25.0, text: 'TOP SIGN', position: 'top' },
        { start: 12.0, end: 16.0, text: 'Dialogue line 1', position: 'bottom' },
        { start: 18.0, end: 22.0, text: 'Dialogue line 2', position: 'bottom' },
        { start: 23.0, end: 28.0, text: 'Speaker A: Hello', position: 'bottom' },
        { start: 24.0, end: 27.0, text: 'Speaker B: Hi there', position: 'bottom' }
    ];

    manager._primaryCues = cues;
    manager._primaryMaxDuration = manager._computeMaxCueDuration(cues);

    // 1. Tick at t = 9.0s (Before any cue)
    manager.tick(9.0);
    assert.equal(capturedEvents.length, 0);

    // 2. Tick at t = 10.5s (Top sign starts)
    manager.tick(10.5);
    assert.equal(capturedEvents.length, 1);
    assert.equal(capturedEvents[0].cues.length, 1);
    assert.equal(capturedEvents[0].cues[0].text, 'TOP SIGN');
    assert.equal(capturedEvents[0].cues[0].position, 'top');

    // 3. Tick at t = 13.0s (Dialogue line 1 starts WHILE top sign is active)
    manager.tick(13.0);
    assert.equal(capturedEvents.length, 2);
    const activeAt13 = capturedEvents[1].cues;
    assert.equal(activeAt13.length, 2);
    assert.equal(activeAt13[0].text, 'TOP SIGN');
    assert.equal(activeAt13[0].position, 'top');
    assert.equal(activeAt13[1].text, 'Dialogue line 1');
    assert.equal(activeAt13[1].position, 'bottom');

    // 4. Tick at t = 17.0s (Dialogue line 1 has ended, between dialogue 1 and 2, sign still active)
    manager.tick(17.0);
    assert.equal(capturedEvents.length, 3);
    const activeAt17 = capturedEvents[2].cues;
    assert.equal(activeAt17.length, 1);
    assert.equal(activeAt17[0].text, 'TOP SIGN');

    // 5. Tick at t = 19.0s (Dialogue line 2 starts WHILE top sign is still active)
    manager.tick(19.0);
    assert.equal(capturedEvents.length, 4);
    const activeAt19 = capturedEvents[3].cues;
    assert.equal(activeAt19.length, 2);
    assert.equal(activeAt19[0].text, 'TOP SIGN');
    assert.equal(activeAt19[1].text, 'Dialogue line 2');

    // 6. Tick at t = 24.5s (Top sign [0], Speaker A [3], and Speaker B [4] ALL THREE ACTIVE CONCURRENTLY)
    manager.tick(24.5);
    assert.equal(capturedEvents.length, 5);
    const activeAt245 = capturedEvents[4].cues;
    assert.equal(activeAt245.length, 3);
    assert.equal(activeAt245[0].text, 'TOP SIGN');
    assert.equal(activeAt245[0].position, 'top');
    assert.equal(activeAt245[1].text, 'Speaker A: Hello');
    assert.equal(activeAt245[1].position, 'bottom');
    assert.equal(activeAt245[2].text, 'Speaker B: Hi there');
    assert.equal(activeAt245[2].position, 'bottom');

    // 7. Tick at t = 26.0s (Top sign ended at 25s, both bottom speakers still active)
    manager.tick(26.0);
    assert.equal(capturedEvents.length, 6);
    const activeAt26 = capturedEvents[5].cues;
    assert.equal(activeAt26.length, 2);
    assert.equal(activeAt26[0].text, 'Speaker A: Hello');
    assert.equal(activeAt26[1].text, 'Speaker B: Hi there');

    // 8. Tick at t = 30.0s (All cues have ended)
    manager.tick(30.0);
    assert.equal(capturedEvents.length, 7);
    assert.equal(capturedEvents[6].text, '');
    assert.equal(capturedEvents[6].cues.length, 0);

    // Clean up
    manager.destroy();
});

test('SubtitleManager: seek reset wipes active cues and clears screen immediately', () => {
    let lastEvent = null;

    const manager = createSubtitleManager({
        serverUrl: 'http://localhost:8096',
        authToken: 'test-token',
        onPrimaryCue: (data) => {
            lastEvent = data;
        }
    });

    manager._primaryDelivery = 'external_text';
    const cues = [
        { start: 10.0, end: 20.0, text: 'Active Cue', position: 'bottom' }
    ];
    manager._primaryCues = cues;
    manager._primaryMaxDuration = manager._computeMaxCueDuration(cues);

    // Show cue
    manager.tick(12.0);
    assert.equal(lastEvent.cues.length, 1);
    assert.equal(lastEvent.cues[0].text, 'Active Cue');

    // Player initiates seek -> resetActiveCues
    manager.resetActiveCues();
    assert.equal(lastEvent.text, '');
    assert.equal(lastEvent.cues.length, 0);

    // Clean up
    manager.destroy();
});

test('CSS rules: verifies stacked cues layout and top overlay baseline', () => {
    const cssContent = readFileSync(new URL('../src/styles/player-page.css', import.meta.url), 'utf8');

    // Verify .subtitle-cue block layout and stacking margin
    assert.match(
        cssContent,
        /\.subtitle-cue\s*\{[^}]*display:\s*block;[^}]*text-align:\s*center;/s,
        '.subtitle-cue must be block centered'
    );
    assert.match(
        cssContent,
        /\.subtitle-cue\s*\+\s*\.subtitle-cue\s*\{[^}]*margin-top:\s*6px;/s,
        '.subtitle-cue + .subtitle-cue must have vertical stacking margin'
    );

    // Verify .subtitle-overlay.pos-top baseline has bottom: auto and top: 10%
    assert.match(
        cssContent,
        /\.subtitle-overlay\.pos-top[^{]*\{[^}]*bottom:\s*auto;[^}]*top:\s*10%;/s,
        '.subtitle-overlay.pos-top must be anchored to the top hemisphere'
    );
});

test('PlayerPage: template includes #subtitle-top-overlay alongside #subtitle-overlay', () => {
    const playerPageContent = readFileSync(new URL('../src/pages/PlayerPage.js', import.meta.url), 'utf8');

    // Must declare #subtitle-top-overlay in DOM template
    assert.match(
        playerPageContent,
        /<div\s+id="subtitle-top-overlay"\s+class="subtitle-overlay\s+pos-top\s+hidden"><\/div>/,
        'PlayerPage template must contain #subtitle-top-overlay'
    );

    // Must implement _renderCuesIntoOverlay with .subtitle-cue stacking
    assert.match(
        playerPageContent,
        /_renderCuesIntoOverlay\(overlay,\s*cues,\s*isHdr,\s*isSecondary\s*=\s*false\)/,
        'PlayerPage must implement _renderCuesIntoOverlay'
    );

    // Must implement _renderPrimarySubtitles with top/bottom separation
    assert.match(
        playerPageContent,
        /_renderPrimarySubtitles\(data,\s*isHdr\)/,
        'PlayerPage must implement _renderPrimarySubtitles'
    );
});

test('SubtitleManager: when subtitleOverlappingCues is false, skips overlapping cues during active cue', () => {
    const capturedEvents = [];

    // Instantiate SubtitleManager with overlapping explicitly disabled
    const manager = createSubtitleManager({
        serverUrl: 'http://localhost:8096',
        authToken: 'test-token',
        onPrimaryCue: (data) => {
            capturedEvents.push(data);
        }
    }, {
        subtitleOverlappingCues: false
    });

    manager._primaryDelivery = 'external_text';
    const cues = [
        { start: 10.0, end: 25.0, text: 'TOP SIGN', position: 'top' },
        { start: 12.0, end: 16.0, text: 'Dialogue line 1', position: 'bottom' },
        { start: 18.0, end: 22.0, text: 'Dialogue line 2', position: 'bottom' },
        { start: 26.0, end: 30.0, text: 'Speaker A: Hello', position: 'bottom' },
        { start: 27.0, end: 29.0, text: 'Speaker B: Hi there', position: 'bottom' }
    ];

    manager._primaryCues = cues;
    manager._primaryMaxDuration = manager._computeMaxCueDuration(cues);

    // 1. Tick at t = 10.5s: 'TOP SIGN' starts
    manager.tick(10.5);
    assert.equal(capturedEvents.length, 1);
    assert.equal(capturedEvents[0].cues.length, 1);
    assert.equal(capturedEvents[0].cues[0].text, 'TOP SIGN');

    // 2. Tick at t = 13.0s: Dialogue 1 would start, but is skipped because overlapping is disabled
    manager.tick(13.0);
    // No new event fired because active cue remained TOP SIGN
    assert.equal(capturedEvents.length, 1);

    // 3. Tick at t = 19.0s: Dialogue 2 would start, also skipped
    manager.tick(19.0);
    assert.equal(capturedEvents.length, 1);

    // 4. Tick at t = 25.5s: TOP SIGN has ended at 25s, silence between 25.0s and 26.0s
    manager.tick(25.5);
    assert.equal(capturedEvents.length, 2);
    assert.equal(capturedEvents[1].text, '');
    assert.equal(capturedEvents[1].cues.length, 0);

    // 5. Tick at t = 27.5s: Speaker A and Speaker B are both active, only Speaker A is selected (single cue mode)
    manager.tick(27.5);
    assert.equal(capturedEvents.length, 3);
    assert.equal(capturedEvents[2].cues.length, 1);
    assert.equal(capturedEvents[2].cues[0].text, 'Speaker A: Hello');

    manager.destroy();
});

test('PlayerSettings: subtitleOverlappingCues defaults to true', () => {
    // Read raw PlayerSettings module source
    const playerSettingsContent = readFileSync(new URL('../src/utils/PlayerSettings.js', import.meta.url), 'utf8');

    // Ensure default configuration includes the key set to true
    assert.match(
        playerSettingsContent,
        /subtitleOverlappingCues:\s*true,/,
        'PlayerSettings DEFAULTS must declare subtitleOverlappingCues: true'
    );
});

test('SubtitlesTab: renders toggle for subtitleOverlappingCues and binds click handler', () => {
    // Read raw SubtitlesTab module source
    const subtitlesTabContent = readFileSync(new URL('../src/pages/settings/tabs/SubtitlesTab.js', import.meta.url), 'utf8');

    // Toggle switch element in markup
    assert.match(
        subtitlesTabContent,
        /subtitle-overlapping-cues-toggle/,
        'SubtitlesTab must render subtitle-overlapping-cues-toggle'
    );
    assert.match(
        subtitlesTabContent,
        /_toggle\([^)]*['"]subtitleOverlappingCues['"]\)/,
        'SubtitlesTab toggle must pass setting subtitleOverlappingCues'
    );

    // Event listener in mount()
    assert.match(
        subtitlesTabContent,
        /\$?\('#subtitle-overlapping-cues-toggle'\)/,
        'SubtitlesTab mount() must bind listener to #subtitle-overlapping-cues-toggle'
    );
    assert.match(
        subtitlesTabContent,
        /PlayerSettings\.set\('subtitleOverlappingCues'/,
        'SubtitlesTab mount() listener must persist to PlayerSettings'
    );
});



