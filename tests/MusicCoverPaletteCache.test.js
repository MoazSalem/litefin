import assert from 'node:assert/strict';
import test from 'node:test';
import { paletteForItem, FALLBACK_PALETTE } from '../src/music/coverPalette.js';

test('a cover that fails to load is cached as the fallback and not fetched again', async () => {
    const loads = [];
    globalThis.Image = class {
        set src(url) {
            loads.push(url);
            setImmediate(() => this.onerror && this.onerror());
        }
    };
    try {
        assert.deepEqual(await paletteForItem('no-cors', 'http://srv/img'), FALLBACK_PALETTE);
        assert.deepEqual(await paletteForItem('no-cors', 'http://srv/img'), FALLBACK_PALETTE);
        assert.equal(loads.length, 1);
    } finally {
        delete globalThis.Image;
    }
});
