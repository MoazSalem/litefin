import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// ============================================================================
// Skip Intro Plugin: Duplicate / Multi-Provider MediaSegments Test Suite
// ============================================================================

const pluginSource = readFileSync(
    new URL('../src/plugins/installed/skip-intro/index.js', import.meta.url),
    'utf8'
)
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default skipIntroPlugin;', 'skipIntroPlugin;');

const TICKS_PER_SECOND = 10_000_000;

function createPlugin(mediaSegmentsItems, chapters = []) {
    const registeredWidgets = [];

    const context = vm.createContext({
        i18n: {
            t: (key) => key,
            translateDOM() {}
        },
        PlayerSettings: {
            get: (key) => {
                if (key === 'skipSegmentSource') return 'server';
                return 'AskToSkip';
            }
        },
        document: {
            createElement: () => ({ innerHTML: '', className: '' }),
            activeElement: null
        }
    });

    const plugin = vm.runInContext(pluginSource, context);

    const api = {
        log: {
            debug() {},
            info() {},
            warn() {},
            error() {}
        },
        serverPlugins: {
            async call() {
                return { Items: mediaSegmentsItems };
            }
        },
        async getItem() {
            return { Chapters: chapters };
        },
        addOSDWidget(widget) {
            registeredWidgets.push(widget);
        }
    };

    return { plugin, api, registeredWidgets };
}

test('Merges overlapping Intro segments from multiple server providers into a single widget', async () => {
    // Simulate Intro Skipper + skipme.db both reporting the same intro with slight offset
    const { plugin, api, registeredWidgets } = createPlugin([
        { Type: 'Intro', StartTicks: 15 * TICKS_PER_SECOND, EndTicks: 105 * TICKS_PER_SECOND },
        { Type: 'Intro', StartTicks: 14 * TICKS_PER_SECOND, EndTicks: 103 * TICKS_PER_SECOND }
    ]);

    await plugin.onPlayerStart({ Id: 'ep-1', Type: 'Episode', Chapters: [] }, api);

    const introWidgets = registeredWidgets.filter((w) => w.id.startsWith('skip-intro-btn'));
    assert.equal(introWidgets.length, 1, 'Expected only one Skip Intro widget for overlapping intro segments');

    // Verify merged bounds span [14s, 105s]
    assert.equal(introWidgets[0].shouldShow(14 * TICKS_PER_SECOND), true);
    assert.equal(introWidgets[0].shouldShow(104 * TICKS_PER_SECOND), true);
    assert.equal(introWidgets[0].shouldShow(105 * TICKS_PER_SECOND), false);
});

test('Preserves distinct non-overlapping Intro segments while keeping Recap + Intro separate', async () => {
    const { plugin, api, registeredWidgets } = createPlugin([
        { Type: 'Recap', StartTicks: 0, EndTicks: 30 * TICKS_PER_SECOND },
        { Type: 'Intro', StartTicks: 20 * TICKS_PER_SECOND, EndTicks: 90 * TICKS_PER_SECOND },
        { Type: 'Intro', StartTicks: 21 * TICKS_PER_SECOND, EndTicks: 91 * TICKS_PER_SECOND },
        { Type: 'Intro', StartTicks: 600 * TICKS_PER_SECOND, EndTicks: 660 * TICKS_PER_SECOND }
    ]);

    await plugin.onPlayerStart({ Id: 'ep-2', Type: 'Episode', Chapters: [] }, api);

    const introWidgets = registeredWidgets.filter((w) => w.id.startsWith('skip-intro-btn'));
    const recapWidgets = registeredWidgets.filter((w) => w.id.startsWith('skip-recap-btn'));

    assert.equal(recapWidgets.length, 1, 'Recap widget should remain independent from Intro');
    assert.equal(introWidgets.length, 2, 'Two non-overlapping Intro segments should produce 2 widgets');
    assert.equal(introWidgets[0].shouldShow(50 * TICKS_PER_SECOND), true);
    assert.equal(introWidgets[1].shouldShow(50 * TICKS_PER_SECOND), false);
});
