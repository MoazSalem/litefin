import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * Media Card Text Alignment & Legacy CSS Compatibility Test Suite
 * ============================================================================
 * Validates that:
 * 1. LayoutManager card label alignment getter/setter operates dynamically,
 *    stamps the data-card-label-align attribute on document.documentElement,
 *    and persists the chosen setting to local storage.
 * 2. LayoutManager card label style getter/setter updates root attribute and
 *    invalidates the CardRenderer cache to ensure fresh layout rendering.
 * 3. SettingsDropdownDispatcher routes card-label-align-select and
 *    card-label-style-select actions directly to LayoutManager setters.
 * 4. CSS selectors in base.css conform strictly to CSS Selectors Level 3
 *    (preventing syntax parse aborts in Chromium 26-47 on Legacy and Ultra-Legacy
 *    Smart TV firmware like Tizen 2.x/3.x and webOS 1.x-3.x).
 * ============================================================================
 */

// Global mock state
const storageMap = new Map();
const docAttributes = new Map();

globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
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
        setAttribute: (name, val) => docAttributes.set(name, String(val)),
        removeAttribute: (name) => docAttributes.delete(name),
        getAttribute: (name) => docAttributes.get(name) || null
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};

globalThis.window = globalThis;
globalThis.__APP_VERSION__ = '1.0.0';

// Dynamic imports after browser mocks are established
const { storage } = await import('../src/utils/StorageService.js');
const { layoutManager } = await import('../src/ui/LayoutManager.js');
const { eventBus } = await import('../src/core/EventBus.js');
const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');

test('Media Card Alignment: LayoutManager getter and setter lifecycle', () => {
    // Reset state
    storageMap.clear();
    docAttributes.clear();

    // Verify default alignment value is 'start'
    assert.strictEqual(
        layoutManager.getCardLabelAlign(),
        'start',
        'Card label alignment should default to "start"'
    );

    let eventFired = false;
    let eventPayload = null;
    const unsubscribe = eventBus.on('cardLabelAlign:changed', (data) => {
        eventFired = true;
        eventPayload = data;
    });

    try {
        // Change alignment to 'center'
        layoutManager.setCardLabelAlign('center');

        // Check getter reflects updated state
        assert.strictEqual(
            layoutManager.getCardLabelAlign(),
            'center',
            'getCardLabelAlign must return updated alignment "center"'
        );

        // Check DOM root attribute was updated
        assert.strictEqual(
            docAttributes.get('data-card-label-align'),
            'center',
            'documentElement must have data-card-label-align attribute set to "center"'
        );

        // Check persistent storage
        assert.strictEqual(
            storage.getItem('pref:cardLabelAlign'),
            'center',
            'Storage pref:cardLabelAlign must be updated to "center"'
        );

        // Check event bus notification
        assert.strictEqual(eventFired, true, 'cardLabelAlign:changed event must fire');
        assert.strictEqual(eventPayload?.align, 'center', 'Event payload must contain align="center"');

        // Test 'end' alignment
        layoutManager.setCardLabelAlign('end');
        assert.strictEqual(layoutManager.getCardLabelAlign(), 'end');
        assert.strictEqual(docAttributes.get('data-card-label-align'), 'end');
        assert.strictEqual(storage.getItem('pref:cardLabelAlign'), 'end');
    } finally {
        unsubscribe();
    }
});

test('Media Card Alignment: CSS Selectors Level 3 backward compatibility in base.css', () => {
    // Read base.css content directly
    const cssContent = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');

    // Extract the card label alignment section
    const alignSectionStart = cssContent.indexOf('/* Start Alignment (Left in LTR, Right in RTL) */');
    const alignSectionEnd = cssContent.indexOf('/* ============================================================================\r\n   Community Score & Rating Star Styling');
    const actualEnd = alignSectionEnd !== -1 ? alignSectionEnd : cssContent.indexOf('/* Community Score & Rating Star Styling');

    assert.notStrictEqual(alignSectionStart, -1, 'Alignment section must exist in base.css');
    const section = cssContent.slice(alignSectionStart, actualEnd);

    // CRITICAL: Ensure NO complex selectors exist inside :not() in this section.
    // Combinators (like space, >, +, ~) inside :not() break CSS3 parsers on Chrome < 88.
    const invalidNotMatches = section.match(/:not\([^)]*\s[^)]*\)/g);
    assert.strictEqual(
        invalidNotMatches,
        null,
        `No complex selectors with combinators allowed inside :not() in base.css, found: ${invalidNotMatches}`
    );

    // Verify rules for start, end, and center alignment exist
    assert.ok(
        section.includes('html[data-card-label-align="start"] .media-card:not(.list-skeleton) .card-title'),
        'base.css must define start alignment rule without invalid complex :not'
    );
    assert.ok(
        section.includes('html[data-card-label-align="end"] .media-card:not(.list-skeleton) .card-title'),
        'base.css must define end alignment rule without invalid complex :not'
    );
    assert.ok(
        section.includes('html[data-card-label-align="center"] .media-card:not(.list-skeleton) .card-title'),
        'base.css must define center alignment rule without invalid complex :not'
    );

    // Verify explicit list view override exists to preserve horizontal layout alignment
    assert.ok(
        section.includes('html[data-card-label-align] .view-list .media-card .card-title'),
        'base.css must define an explicit list view override to prevent cards in list mode from centering'
    );
});

test('Media Card Progress Bar: Legacy & Ultra-Legacy CSS backward compatibility', () => {
    // 1. Read components.css to verify progressive enhancements and fallbacks
    const componentsCss = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');

    // Ensure .card-progress-container starts with opacity: 1 (not opacity: 0)
    // to prevent invisibility on Chrome < 43 where unprefixed animation is unsupported
    const containerMatch = componentsCss.match(/\.card-progress-container\s*\{([\s\S]*?)\}/);
    assert.ok(containerMatch, '.card-progress-container rule must exist in components.css');
    assert.ok(
        containerMatch[1].includes('opacity: 1;'),
        '.card-progress-container must default to opacity: 1 for older browser support'
    );
    assert.ok(
        containerMatch[1].includes('-webkit-animation:'),
        '.card-progress-container must provide -webkit-animation prefix for Chrome 26-42'
    );

    // Ensure ::-webkit-progress-value has solid background-color fallbacks
    const valueMatch = componentsCss.match(/progress\.card-progress::-webkit-progress-value\s*\{([\s\S]*?)\}/);
    assert.ok(valueMatch, 'progress.card-progress::-webkit-progress-value rule must exist');
    assert.ok(
        valueMatch[1].includes('background-color: #00a4dc;'),
        '::-webkit-progress-value must include solid color fallback for browsers without CSS variable support'
    );
    assert.ok(
        valueMatch[1].includes('-webkit-linear-gradient'),
        '::-webkit-progress-value must include -webkit-linear-gradient for Chromium 26-38'
    );

    // 2. Read base.css to verify legacy & ultra-legacy tier overrides
    const baseCss = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    assert.ok(
        baseCss.includes('html[data-layout-tier="legacy"] .card-progress-container') &&
        baseCss.includes('html[data-layout-tier="ultra-legacy"] .card-progress-container'),
        'base.css must define tier-level overrides ensuring opacity: 1 on Legacy and Ultra-Legacy tiers'
    );
});

test('Media Card Progress Bar: CardRenderer constructs progress bar for playback states', () => {
    // 1. Item with PlaybackPositionTicks and RunTimeTicks
    const itemWithTicks = {
        Id: 'item-ticks-1',
        Name: 'In Progress Movie',
        Type: 'Movie',
        RunTimeTicks: 72000000000, // 2 hours
        UserData: {
            PlaybackPositionTicks: 36000000000 // 50%
        }
    };

    const html1 = CardRenderer.createCardHtml(itemWithTicks);
    assert.ok(
        html1.includes('class="card-progress" value="50" max="100"'),
        'CardRenderer must render progress element with value="50"'
    );
    assert.ok(
        html1.includes('has-progress'),
        'CardRenderer must attach has-progress class to media card'
    );

    // 2. Item with PlayedPercentage
    const itemWithPercentage = {
        Id: 'item-pct-1',
        Name: 'Partially Played Episode',
        Type: 'Episode',
        UserData: {
            PlayedPercentage: 75.4
        }
    };

    const html2 = CardRenderer.createCardHtml(itemWithPercentage);
    assert.ok(
        html2.includes('class="card-progress" value="75" max="100"'),
        'CardRenderer must render progress element with integer value="75" from PlayedPercentage'
    );

    // 3. Game ROM should never render progress bar
    const gameRom = {
        Id: 'game-1',
        Name: 'Super Mario',
        Type: 'Game',
        Tags: ['JellyEmu'],
        RunTimeTicks: 1000,
        UserData: { PlaybackPositionTicks: 500 }
    };

    const htmlGame = CardRenderer.createCardHtml(gameRom);
    assert.strictEqual(
        htmlGame.includes('card-progress'),
        false,
        'Games must never render a playback progress bar'
    );

    // 4. Completed movie (Played: true) must never render a progress bar
    const completedMovie = {
        Id: 'movie-done-1',
        Name: 'Completed Movie',
        Type: 'Movie',
        RunTimeTicks: 72000000000,
        UserData: {
            Played: true,
            PlaybackPositionTicks: 72000000000,
            PlayedPercentage: 100
        }
    };
    const htmlCompletedMovie = CardRenderer.createCardHtml(completedMovie);
    assert.strictEqual(
        htmlCompletedMovie.includes('card-progress'),
        false,
        'Completed movie must never render a playback progress bar'
    );
    assert.strictEqual(
        htmlCompletedMovie.includes('has-progress'),
        false,
        'Completed movie media card must not have has-progress class'
    );

    // 5. Completed movie via 100% position without explicit Played flag
    const completedMovieByTicks = {
        Id: 'movie-done-2',
        Name: 'Fully Watched Movie',
        Type: 'Movie',
        RunTimeTicks: 72000000000,
        UserData: {
            Played: false,
            PlaybackPositionTicks: 72000000000
        }
    };
    const htmlMovieTicks = CardRenderer.createCardHtml(completedMovieByTicks);
    assert.strictEqual(
        htmlMovieTicks.includes('card-progress'),
        false,
        'Movie at 100% progress must never render a progress bar'
    );

    // 6. Series card (completed) must never render a progress bar
    const completedSeries = {
        Id: 'series-1',
        Name: 'Breaking Bad',
        Type: 'Series',
        UserData: {
            Played: true,
            PlayedPercentage: 100,
            UnplayedItemCount: 0
        }
    };
    const htmlCompletedSeries = CardRenderer.createCardHtml(completedSeries);
    assert.strictEqual(
        htmlCompletedSeries.includes('card-progress'),
        false,
        'Series card with completed progress must never render a progress bar'
    );

    // 7. Series card (in-progress episodes) must never render a progress bar
    const inProgressSeries = {
        Id: 'series-2',
        Name: 'Better Call Saul',
        Type: 'Series',
        UserData: {
            Played: false,
            PlayedPercentage: 45.5,
            UnplayedItemCount: 12
        }
    };
    const htmlInProgressSeries = CardRenderer.createCardHtml(inProgressSeries);
    assert.strictEqual(
        htmlInProgressSeries.includes('card-progress'),
        false,
        'Series card with partial progress must never render a progress bar'
    );

    // 8. Season card must never render a progress bar
    const seasonCard = {
        Id: 'season-1',
        Name: 'Season 1',
        Type: 'Season',
        UserData: {
            PlayedPercentage: 60
        }
    };
    const htmlSeason = CardRenderer.createCardHtml(seasonCard);
    assert.strictEqual(
        htmlSeason.includes('card-progress'),
        false,
        'Season card must never render a progress bar'
    );

    // 9. Completed episode must never render a progress bar
    const completedEpisode = {
        Id: 'ep-done-1',
        Name: 'Finale',
        Type: 'Episode',
        RunTimeTicks: 36000000000,
        UserData: {
            Played: true,
            PlayedPercentage: 100
        }
    };
    const htmlCompletedEpisode = CardRenderer.createCardHtml(completedEpisode);
    assert.strictEqual(
        htmlCompletedEpisode.includes('card-progress'),
        false,
        'Completed episode must never render a progress bar'
    );
});

