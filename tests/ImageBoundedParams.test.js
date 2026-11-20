/**
 * ============================================================================
 * Bounded Image Request Parameters - Test Suite
 * ============================================================================
 * Verifies that poster cards and thumbnails request a bounded maxHeight from
 * the Jellyfin image endpoint, while full-screen hero/backdrop artwork keeps
 * its preset resolution so 4K panels still receive high-resolution textures.
 * ============================================================================
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (index) => Array.from(storageMap.keys())[index] ?? null,
    get length() {
        return storageMap.size;
    }
};

globalThis.document = {
    documentElement: { getAttribute: () => 'classic' }
};
globalThis.window = {
    location: { hash: '#/home' },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
};

const { storage } = await import('../src/utils/StorageService.js');
const { imageService } = await import('../src/utils/ImageService.js');

test('ImageService: hero backdrops keep their preset resolution for 4K panels', () => {
    storage.setItem('pref:imageQuality', 'ultra');
    storage.setItem('pref:heroImageQuality', 'ultra');

    const params = imageService.getParams('hero-immersive');

    assert.equal(params.maxWidth, 3840, 'Hero width follows the selected preset, not a hard cap');
    assert.equal(params.maxHeight, null, 'Hero height must not be constrained');
    assert.equal(params.quality, 99, 'Hero quality follows the selected preset');
});

test('ImageService: generic and details backdrops are not bounded', () => {
    storage.setItem('pref:imageQuality', 'ultra');

    const backdrop = imageService.getParams('backdrop');
    assert.equal(backdrop.maxWidth, 2160);
    assert.equal(backdrop.maxHeight, null);
    assert.equal(backdrop.quality, 99);

    const detailsBackdrop = imageService.getParams('details-backdrop');
    assert.equal(detailsBackdrop.maxWidth, 2880, 'Details default preset stays at very-high');
    assert.equal(detailsBackdrop.maxHeight, null);
    assert.equal(detailsBackdrop.quality, 95);
});

test('ImageService: poster cards derive a 2:3 height bound from the row width', () => {
    storage.setItem('pref:imageQuality', 'ultra');

    const poster = imageService.getParams('poster', 'home');

    assert.equal(poster.maxWidth, 456, 'Home poster keeps its preset width');
    assert.equal(poster.maxHeight, Math.round(456 * 1.5), 'Poster height bound is 2:3');
    assert.equal(poster.quality, 99, 'Poster quality keeps the user preset');
});

test('ImageService: thumbnails and card backdrops derive a 16:9 height bound', () => {
    storage.setItem('pref:imageQuality', 'medium');

    const thumb = imageService.getParams('thumb');
    assert.equal(thumb.maxWidth, 388);
    assert.equal(thumb.maxHeight, Math.round(388 * (9 / 16)));

    const cardBackdrop = imageService.getParams('card-backdrop');
    assert.equal(cardBackdrop.maxWidth, 400);
    assert.equal(cardBackdrop.maxHeight, Math.round(400 * (9 / 16)));
    assert.equal(cardBackdrop.quality, 90, 'Card backdrops keep the user preset quality');
});

test('ImageService: original preset keeps every bound unset', () => {
    storage.setItem('pref:imageQuality', 'original');
    storage.setItem('pref:heroImageQuality', 'default');

    const params = imageService.getParams('hero-immersive');

    assert.equal(params.maxWidth, null);
    assert.equal(params.maxHeight, null);
    assert.equal(params.quality, null);
});

test('ApiClient.getImageUrl: derives a maxHeight when only maxWidth is provided', async () => {
    const { ApiClient } = await import('../src/api/ApiClient.js');
    const client = new ApiClient();
    client._serverUrl = 'http://localhost:8096';

    const poster = new URL(client.getImageUrl('abc', 'Primary', { maxWidth: 400, quality: 80 }));
    assert.equal(poster.searchParams.get('maxWidth'), '400');
    assert.equal(poster.searchParams.get('maxHeight'), '600', 'Primary derives a 2:3 height bound');
    assert.equal(poster.searchParams.get('quality'), '80');

    const backdrop = new URL(client.getImageUrl('abc', 'Backdrop', { maxWidth: 1920 }));
    assert.equal(backdrop.searchParams.get('maxHeight'), null, 'Backdrops are not height-bounded');

    const explicit = new URL(client.getImageUrl('abc', 'Backdrop', { maxWidth: 1920, maxHeight: 720 }));
    assert.equal(explicit.searchParams.get('maxHeight'), '720', 'Explicit maxHeight is preserved');
});

test('ImageService: square artwork keeps a 1:1 height bound', () => {
    storage.setItem('pref:imageQuality', 'medium');

    const square = imageService.getParams('square', 'music');

    assert.equal(square.maxWidth, 388);
    assert.equal(square.maxHeight, 388);
});
