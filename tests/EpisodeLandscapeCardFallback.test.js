import assert from 'node:assert/strict';
import test from 'node:test';

/*
 * ============================================================================
 * Episode Landscape Card Artwork Fallback Test Suite
 * ============================================================================
 * Verifies that landscape media cards (such as merged Continue Watching /
 * Next Up rows) correctly resolve artwork hierarchies for episodes.
 * Ensures that when a TV show lacks dedicated 16:9 thumbnails or backdrops,
 * the card reliably falls back to the parent series primary poster instead
 * of triggering 404 network errors or dropping to gradient initial placeholders.
 * ============================================================================
 */

// In-memory mock storage implementation for isolated test runs
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

// Polyfill minimal DOM environment required by CardRenderer
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
        getAttribute: (name) => (name === 'data-layout-media-rows' ? 'classic' : null),
        hasAttribute: () => false
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};
globalThis.window = globalThis;
globalThis.__APP_VERSION__ = '1.0.0';

// Import target CardRenderer component under test
const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');
const { storage } = await import('../src/utils/StorageService.js');

test('Episode Landscape: falls back to Series Primary poster when show has no backdrop or episode still', () => {
    // Reset stored preferences to default
    storageMap.clear();
    CardRenderer._prefs = null;
    CardRenderer._prefs = null;

    // Mock episode data where user identified the series or added an image manually
    // The series has a Primary poster tag, but no 16:9 episode still or backdrop exists
    const episode = {
        Id: 'ep-001',
        Type: 'Episode',
        Name: 'The Beginning',
        SeriesId: 'series-999',
        SeriesName: 'My Awesome Series',
        SeriesPrimaryImageTag: 'series-poster-tag-123',
        ParentBackdropItemId: 'series-999',
        // ParentBackdropImageTags is empty (no backdrop available on server)
        ParentBackdropImageTags: []
    };

    // Render landscape card matching merged Continue Watching & Next Up row configuration
    const html = CardRenderer.createCardHtml(episode, {
        isLandscape: true,
        type: 'resume',
        contextType: 'resume'
    });

    // Verify the card does not drop to initials gradient fallback
    assert.ok(!html.includes('media-fallback'), 'Card should not render gradient initials fallback');

    // Verify the card requests the parent series primary poster artwork
    assert.ok(
        html.includes('/Items/series-999/Images/Primary'),
        'Card image URL must target the parent Series Primary image'
    );

    // Verify tag parameter is included for cache busting
    assert.ok(
        html.includes('tag=series-poster-tag-123'),
        'Card image URL must include the SeriesPrimaryImageTag'
    );
});

test('Episode Landscape: does not generate blind Backdrop URL when ParentBackdropImageTags is empty', () => {
    storageMap.clear();
    CardRenderer._prefs = null;

    const episode = {
        Id: 'ep-002',
        Type: 'Episode',
        Name: 'Uncharted Waters',
        SeriesId: 'series-888',
        ParentBackdropItemId: 'series-888',
        // No backdrop tags exist
        ParentBackdropImageTags: [],
        SeriesBackdropImageTags: [],
        SeriesPrimaryImageTag: 'tag-primary-888'
    };

    const html = CardRenderer.createCardHtml(episode, {
        isLandscape: true,
        type: 'resume',
        contextType: 'resume'
    });

    // Ensure it did not build a blind /Backdrop request that would 404
    assert.ok(
        !html.includes('/Images/Backdrop'),
        'Must not request Backdrop when backdrop tags array is empty'
    );

    // Ensure it properly resolved the series primary poster instead
    assert.ok(
        html.includes('/Items/series-888/Images/Primary'),
        'Must resolve Series Primary when backdrop is absent'
    );
});

test('Episode Landscape: prioritizes 16:9 Series Thumb when available', () => {
    storageMap.clear();
    CardRenderer._prefs = null;

    const episode = {
        Id: 'ep-003',
        Type: 'Episode',
        Name: 'Chapter Three',
        SeriesId: 'series-777',
        SeriesThumbImageTag: 'thumb-tag-777',
        SeriesPrimaryImageTag: 'poster-tag-777'
    };

    const html = CardRenderer.createCardHtml(episode, {
        isLandscape: true,
        type: 'resume',
        contextType: 'resume'
    });

    // 16:9 series thumb takes precedence over portrait poster
    assert.ok(
        html.includes('/Items/series-777/Images/Thumb'),
        'Widescreen 16:9 Series Thumb must take precedence over poster'
    );
});

test('Episode Landscape: spoiler prevention prefers Series Primary over revealing episode screenshot', () => {
    // Default: preferEpisodeImages is unset (false), spoiler prevention active for resume
    storageMap.clear();
    CardRenderer._prefs = null;

    const episode = {
        Id: 'ep-004',
        Type: 'Episode',
        Name: 'The Big Reveal',
        SeriesId: 'series-666',
        SeriesPrimaryImageTag: 'series-poster-666',
        ImageTags: {
            Primary: 'spoiler-screenshot-444'
        }
    };

    const html = CardRenderer.createCardHtml(episode, {
        isLandscape: true,
        type: 'resume',
        contextType: 'resume'
    });

    // In spoiler-free resume mode, show's primary poster is preferred over episode screenshot
    assert.ok(
        html.includes('/Items/series-666/Images/Primary'),
        'Spoiler prevention must prefer Series Primary poster over episode screenshot'
    );
});

test('Episode Landscape: uses episode screenshot when preferEpisodeImages is enabled', () => {
    storageMap.clear();
    CardRenderer._prefs = null;
    CardRenderer._prefs = null;
    // User explicitly turns on episode screenshots
    storage.setItem('pref:preferEpisodeImagesLocal', 'true');

    const episode = {
        Id: 'ep-005',
        Type: 'Episode',
        Name: 'Action Sequence',
        SeriesId: 'series-555',
        SeriesPrimaryImageTag: 'series-poster-555',
        ImageTags: {
            Primary: 'episode-shot-555'
        }
    };

    const html = CardRenderer.createCardHtml(episode, {
        isLandscape: true,
        type: 'resume',
        contextType: 'resume'
    });

    // When preferEpisodeImages is true, episode screenshot takes precedence
    assert.ok(
        html.includes('/Items/ep-005/Images/Primary'),
        'Episode screenshot must be rendered when preferEpisodeImages is true'
    );
});
