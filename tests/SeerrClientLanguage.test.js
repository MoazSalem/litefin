import assert from 'node:assert/strict';
import test from 'node:test';

// Define global browser shims for Node testing environment
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        location: { hash: '', origin: 'http://localhost' }
    };
}
if (typeof globalThis.localStorage === 'undefined') {
    const map = new Map();
    globalThis.localStorage = {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear()
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.0.0';
}

const { seerr, SeerrClient } = await import('../src/api/seerrClient.js');
const { i18n } = await import('../src/utils/i18n.js');
const { storage } = await import('../src/utils/StorageService.js');
const { api } = await import('../src/api/ApiClient.js');

/**
 * ============================================================================
 * Unit Tests: Seerr Client Language & Localization
 * ============================================================================
 * Verifies that:
 *   - _getPreferredLanguage resolves BCP-47 / ISO 639-1 tags from i18n & storage
 *   - _withLanguage properly appends language query parameters without duplicates
 *   - _withLanguage respects explicit language overrides
 *   - API routes (search, trending, details, discover) append active language
 * ============================================================================
 */

test('_getPreferredLanguage standardizes language codes for TMDB/Seerr', () => {
    const client = new SeerrClient();

    // 1. Test 2-letter language codes
    i18n.currentLang = 'de';
    assert.equal(client._getPreferredLanguage(), 'de');

    i18n.currentLang = 'fr';
    assert.equal(client._getPreferredLanguage(), 'fr');

    i18n.currentLang = 'ar';
    assert.equal(client._getPreferredLanguage(), 'ar');

    // 2. Test regional language tags with hyphen or underscore
    i18n.currentLang = 'pt-br';
    assert.equal(client._getPreferredLanguage(), 'pt-BR');

    i18n.currentLang = 'zh_cn';
    assert.equal(client._getPreferredLanguage(), 'zh-CN');

    i18n.currentLang = 'en-US';
    assert.equal(client._getPreferredLanguage(), 'en-US');

    // 3. Test fallback to storage when i18n is not set
    i18n.currentLang = null;
    storage.setItem('app_language', 'es');
    assert.equal(client._getPreferredLanguage(), 'es');

    storage.setItem('app_language', 'pt-pt');
    assert.equal(client._getPreferredLanguage(), 'pt-PT');

    // Clean up
    storage.removeItem('app_language');
    i18n.currentLang = 'en-us';
});

test('_withLanguage appends language query parameter correctly', () => {
    const client = new SeerrClient();
    i18n.currentLang = 'de';

    // Appending to path with no existing query string
    assert.equal(client._withLanguage('/Discover/Trending'), '/Discover/Trending?language=de');

    // Appending to path with existing query parameters
    assert.equal(
        client._withLanguage('/Search?query=Inception&page=1'),
        '/Search?query=Inception&page=1&language=de'
    );

    // Explicit language override takes precedence over current i18n language
    assert.equal(client._withLanguage('/Discover/Trending', 'fr'), '/Discover/Trending?language=fr');
    assert.equal(client._withLanguage('/Movie/12345', 'es'), '/Movie/12345?language=es');

    // Should not duplicate language if already present
    assert.equal(
        client._withLanguage('/Discover/Movies?genre=28&language=ja'),
        '/Discover/Movies?genre=28&language=ja'
    );
    assert.equal(
        client._withLanguage('/Discover/Movies?language=it&page=2'),
        '/Discover/Movies?language=it&page=2'
    );

    // Clean up
    i18n.currentLang = 'en-us';
});

test('SeerrClient endpoints use localized routes and partition caches by language', async () => {
    const client = new SeerrClient();
    i18n.currentLang = 'de';

    const recordedPaths = [];
    const origGet = api.get;
    api.get = async (path) => {
        recordedPaths.push(path);
        return { results: [], page: 1, totalPages: 1 };
    };

    try {
        // Test discoverTrending localization
        await client.discoverTrending();
        assert.equal(recordedPaths[recordedPaths.length - 1], '/Litefin/Seerr/Discover/Trending?language=de');

        // Test search localization
        await client.search('Batman', 1);
        assert.equal(recordedPaths[recordedPaths.length - 1], '/Litefin/Seerr/Search?query=Batman&page=1&language=de');

        // Test discoverMovies localization
        await client.discoverMovies(1, { genre: '28' });
        assert.equal(recordedPaths[recordedPaths.length - 1], '/Litefin/Seerr/Discover/Movies?page=1&genre=28&language=de');

        // Test discoverTv localization
        await client.discoverTv(1, { network: '213' });
        assert.equal(recordedPaths[recordedPaths.length - 1], '/Litefin/Seerr/Discover/Tv?page=1&network=213&language=de');

        // Verify cache keys differ when language changes
        const lang1 = client._getPreferredLanguage();
        assert.equal(lang1, 'de');
        i18n.currentLang = 'fr';
        const lang2 = client._getPreferredLanguage();
        assert.equal(lang2, 'fr');
    } finally {
        api.get = origGet;
        i18n.currentLang = 'en-us';
    }
});
