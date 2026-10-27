import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Media Card Favorite Badge Test Suite
 * ============================================================================
 * Cards of favorite items show a heart badge when "Show Favorite Badges" is
 * on. Its tooltip text follows the app language.
 * ============================================================================
 */

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.document = {
    createElement: () => ({
        getContext: () => ({}),
        setAttribute: () => {},
        removeAttribute: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false }
    }),
    documentElement: {
        setAttribute: () => {},
        removeAttribute: () => {},
        getAttribute: (name) => (name === 'data-layout-media-rows' ? 'expanding' : null),
        hasAttribute: () => false
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};
globalThis.window = globalThis;
globalThis.__APP_VERSION__ = '1.0.0';

const { storage } = await import('../src/utils/StorageService.js');
const { i18n } = await import('../src/utils/i18n.js');
const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');

const favoriteMovie = (id) => ({
    Id: id,
    Name: `Movie ${id}`,
    Type: 'Movie',
    ProductionYear: 2024,
    MediaSourceCount: 2,
    ImageTags: { Primary: 'tag' },
    UserData: { IsFavorite: true, Played: true }
});

test('CardRenderer: the favorite badge title is translated', () => {
    storage.setItem('pref:showFavoriteBadges', 'true');
    const savedDictionary = i18n.dictionary;
    try {
        i18n.dictionary = { Favorite: 'Favorit' };
        CardRenderer.clearCache();
        const html = CardRenderer.createCardHtml(favoriteMovie('fav-1'), { type: 'poster' });
        assert.match(html, /<div class="favorite-badge" title="Favorit">/);

        i18n.dictionary = { Favorite: 'Lieblings"film' };
        CardRenderer.clearCache();
        const quoted = CardRenderer.createCardHtml(favoriteMovie('fav-2'), { type: 'poster' });
        assert.match(quoted, /title="Lieblings&quot;film"/, 'the translation is escaped inside the attribute');
    } finally {
        i18n.dictionary = savedDictionary;
        storage.removeItem('pref:showFavoriteBadges');
        CardRenderer.clearCache();
    }
});
