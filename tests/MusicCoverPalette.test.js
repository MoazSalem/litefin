import assert from 'node:assert/strict';
import test from 'node:test';
import { pickPalette, FALLBACK_PALETTE } from '../src/music/coverPalette.js';
import { ambientEnabled } from '../src/music/ambient.js';

const SIZE = 32;

function buildImage(pixelAt) {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const [r, g, b] = pixelAt(x, y);
            const i = (y * SIZE + x) * 4;
            data.set([r, g, b, 255], i);
        }
    }
    return data;
}

const near = (actual, expected) => actual.every((c, i) => Math.abs(c - expected[i]) <= 40);

test('pickPalette returns three distinct colors from a two-tone image', () => {
    const orange = [255, 140, 0];
    const purple = [120, 40, 180];
    const palette = pickPalette(buildImage((x) => (x < SIZE / 2 ? orange : purple)));
    assert.equal(palette.length, 3);
    assert.ok(
        palette.some((c) => near(c, orange)),
        'includes orange'
    );
    assert.ok(
        palette.some((c) => near(c, purple)),
        'includes purple'
    );
});

test('pickPalette ignores near-black and near-white', () => {
    const palette = pickPalette(buildImage((x) => (x < SIZE / 2 ? [0, 0, 0] : [255, 255, 255])));
    assert.deepEqual(palette, FALLBACK_PALETTE);
});

test('pickPalette always returns exactly three', () => {
    const palette = pickPalette(buildImage(() => [200, 60, 60]));
    assert.equal(palette.length, 3);
    assert.ok(near(palette[0], [200, 60, 60]));
    for (const c of palette) assert.equal(c.length, 3);
});

test('ambientEnabled is true when no build tier or document is defined', () => {
    assert.equal(ambientEnabled(), true);
});
