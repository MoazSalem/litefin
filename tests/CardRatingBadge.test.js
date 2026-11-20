import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Polyfill the browser globals CardRenderer touches at import/render time.
if (typeof globalThis.window === 'undefined') {
    globalThis.window = { location: { origin: 'http://localhost' } };
}
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        createElement: () => ({ canPlayType: () => '', setAttribute: () => {} }),
        querySelector: () => null,
        querySelectorAll: () => [],
        documentElement: {
            getAttribute: () => 'classic',
            setAttribute: () => {},
            style: {}
        },
        head: { appendChild: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.0.0';
}

const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');
const { storage } = await import('../src/utils/StorageService.js');

/**
 * Enable the badge and optionally set its source/icon preferences.
 * Preferences are snapshotted per render pass, so the HTML cache is cleared.
 */
function enable({ source = 'community', icon = 'star', scoreVisibility = 'all' } = {}) {
    storage.setItem('pref:cardRatingsEnabled', 'true');
    storage.setItem('pref:cardRatingSource', source);
    storage.setItem('pref:cardRatingIcon', icon);
    if (scoreVisibility) storage.setItem('pref:scoreVisibility', scoreVisibility);
    else storage.removeItem('pref:scoreVisibility');
    CardRenderer.clearCache();
}

const movie = {
    Id: 'movie-1',
    Type: 'Movie',
    Name: 'Example Movie',
    CommunityRating: 8.7,
    CriticRating: 92
};

test('CardRatingBadge: hidden by default until the preference is enabled', () => {
    storage.removeItem('pref:cardRatingsEnabled');
    CardRenderer.clearCache();
    assert.equal(CardRenderer.getCardRatingBadgeHtml(movie), '');
});

test('CardRatingBadge: renders community score with a star by default', () => {
    enable();
    const html = CardRenderer.getCardRatingBadgeHtml(movie);
    assert.ok(html.includes('card-rating-badge--community'));
    assert.ok(html.includes('card-rating-value'));
    assert.ok(html.includes('8.7'));
    assert.ok(html.includes('data-rating-for="movie-1"'));
    assert.ok(html.includes('rating-star-icon'));
});

test('CardRatingBadge: renders critic score as a rounded percentage', () => {
    enable({ source: 'critic' });
    const html = CardRenderer.getCardRatingBadgeHtml(movie);
    assert.ok(html.includes('card-rating-badge--critic'));
    assert.ok(html.includes('92%'));
});

test('CardRatingBadge: source icon mode uses the tomato for critic ratings', () => {
    enable({ source: 'critic', icon: 'source' });
    const html = CardRenderer.getCardRatingBadgeHtml(movie);
    assert.ok(html.includes('seerr-rating-icon'));
    assert.ok(!html.includes('rating-star-icon'));
});

test('CardRatingBadge: none icon mode omits all SVG glyphs', () => {
    enable({ icon: 'none' });
    const html = CardRenderer.getCardRatingBadgeHtml(movie);
    assert.ok(html.includes('8.7'));
    assert.ok(!html.includes('<svg'));
});

test('CardRatingBadge: respects mystery score visibility', () => {
    enable({ scoreVisibility: 'mystery' });
    assert.equal(CardRenderer.getCardRatingBadgeHtml(movie), '');
});

test('CardRatingBadge: respects watched-only score visibility', () => {
    enable({ scoreVisibility: 'watched' });
    assert.equal(CardRenderer.getCardRatingBadgeHtml(movie), '');
    assert.ok(CardRenderer.getCardRatingBadgeHtml({ ...movie, UserData: { Played: true } }).includes('8.7'));
});

test('CardRatingBadge: skipped in list view (meta row already shows a score)', () => {
    enable();
    assert.equal(CardRenderer.getCardRatingBadgeHtml(movie, { showMeta: true }), '');
});

test('CardRatingBadge: skipped for items without a meaningful rating', () => {
    enable();
    assert.equal(CardRenderer.getCardRatingBadgeHtml({ Id: 'x', Type: 'Person' }), '');
    assert.equal(CardRenderer.getCardRatingBadgeHtml({ Id: 'x', Type: 'TvChannel' }), '');
    assert.equal(CardRenderer.getCardRatingBadgeHtml({ Id: 'x', Type: 'Movie', _isGenreCard: true }), '');
    assert.equal(CardRenderer.getCardRatingBadgeHtml({ Id: 'x', Type: 'Movie' }), '');
});

test('CardRatingBadge: isRatingEligible covers rated media types only', () => {
    assert.equal(CardRenderer.isRatingEligible({ Id: 'x', Type: 'Movie' }), true);
    assert.equal(CardRenderer.isRatingEligible({ Id: 'x', Type: 'Series' }), true);
    assert.equal(CardRenderer.isRatingEligible({ Id: 'x', Type: 'Episode' }), true);
    assert.equal(CardRenderer.isRatingEligible({ Id: 'x', Type: 'Season' }), true);
    assert.equal(CardRenderer.isRatingEligible({ Id: 'x', Type: 'BoxSet' }), true);
    assert.equal(CardRenderer.isRatingEligible({ Id: 'x', Type: 'Person' }), false);
    assert.equal(CardRenderer.isRatingEligible({ Id: 'x', Type: 'TvChannel' }), false);
    assert.equal(CardRenderer.isRatingEligible({ Type: 'Movie' }), false);
});

test('CardRenderer.createCardHtml includes the badge when enabled', () => {
    enable();
    const html = CardRenderer.createCardHtml(movie, { type: 'poster' });
    assert.ok(html.includes('card-rating-badge'));
    assert.ok(html.includes('8.7'));
});

test('Settings: rating controls live in Layout (Media Rows), not Details', () => {
    const layout = readFileSync(new URL('../src/pages/settings/tabs/LayoutTab.js', import.meta.url), 'utf8');
    const details = readFileSync(new URL('../src/pages/settings/tabs/DetailsTab.js', import.meta.url), 'utf8');

    const mediaRowsIndex = layout.indexOf('data-i18n="MediaRows"');
    for (const token of ['toggle-card-ratings', 'card-rating-source-select', 'card-rating-icon-select']) {
        assert.ok(layout.includes(token), `LayoutTab is missing ${token}`);
        assert.ok(layout.indexOf(token) > mediaRowsIndex, `${token} must be inside the Media Rows section`);
        assert.ok(!details.includes(token), `DetailsTab must not contain ${token}`);
    }
});

test('CSS: rating badge shares the badge skins and anchors top-left', () => {
    const base = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const rating = readFileSync(new URL('../src/styles/card-ratings.css', import.meta.url), 'utf8');
    const modern = readFileSync(new URL('../src/styles/modern/home.css', import.meta.url), 'utf8');

    assert.ok(base.includes('html[data-badge-style="tinted"] .card-rating-badge'));
    assert.ok(base.includes('html[data-badge-style="dark"] .card-rating-badge'));
    assert.ok(modern.includes('.media-card:focus .card-rating-badge'));
    assert.ok(rating.includes('top: 12px;'));
    assert.ok(rating.includes('right: 12px;'));
    assert.ok(rating.includes('html[data-media-rows-family="modern"] .card-rating-badge'));
    assert.ok(rating.includes('top: 22px;'));
    // Rating shares a top-left flex row with the SxxExx / rank badge.
    assert.ok(rating.includes('.card-top-left-badges {'));
    assert.ok(rating.includes('html[data-media-rows-family="modern"] .card-top-left-badges'));
    assert.ok(rating.includes('left: 12px;'));
    assert.ok(rating.includes('left: 22px;'));
    // Same height as the quality badge in both classic and modern layouts.
    assert.equal((rating.match(/height: 40px;/g) || []).length, 2);
});

test('CardRenderer: rating shares the top-left row with the episode badge', () => {
    enable();
    storage.setItem('pref:showQualityBadges', 'true');
    CardRenderer.clearCache();

    const item = {
        ...movie,
        Type: 'Episode',
        ParentIndexNumber: 1,
        IndexNumber: 3,
        SeriesName: 'Test Show',
        Width: 3840,
        Height: 2160
    };
    const html = CardRenderer.createCardHtml(item, { type: 'poster' });
    const leftStart = html.indexOf('<div class="card-top-left-badges">');
    const rightStart = html.indexOf('<div class="card-top-right-badges">');
    assert.ok(leftStart >= 0);
    assert.ok(rightStart >= 0);
    const leftRow = html.slice(leftStart, rightStart);
    assert.ok(leftRow.includes('episode-badge'));
    assert.ok(leftRow.includes('card-rating-badge'));
    const rightRow = html.slice(rightStart, rightStart + 1500);
    assert.ok(rightRow.includes('quality-badge'));
    assert.ok(!rightRow.includes('card-rating-badge'));
    storage.removeItem('pref:showQualityBadges');
    CardRenderer.clearCache();
});
