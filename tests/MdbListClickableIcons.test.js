import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeWebClientSettings,
    buildProviderHref,
    isDigitsOnly,
    normalizeLeadingSlash
} from '../src/plugins/installed/mdblist-ratings/ratingsFormatter.js';

test('normalizeWebClientSettings parses clickable option from server response', () => {
    // 1. When enableWebClickableRatingIcons is true
    const settingsOn = normalizeWebClientSettings({
        enableWebClickableRatingIcons: true
    });
    assert.equal(settingsOn.clickable, true);

    // 2. When EnableWebClickableRatingIcons is true (PascalCase)
    const settingsPascal = normalizeWebClientSettings({
        EnableWebClickableRatingIcons: true
    });
    assert.equal(settingsPascal.clickable, true);

    // 3. When setting is false or omitted
    const settingsOff = normalizeWebClientSettings({
        enableWebClickableRatingIcons: false
    });
    assert.equal(settingsOff.clickable, false);

    const settingsEmpty = normalizeWebClientSettings({});
    assert.equal(settingsEmpty.clickable, false);
});

test('isDigitsOnly and normalizeLeadingSlash utility correctness', () => {
    assert.equal(isDigitsOnly('12345'), true);
    assert.equal(isDigitsOnly(' 999 '), true);
    assert.equal(isDigitsOnly('123a'), false);
    assert.equal(isDigitsOnly('/m/movie'), false);
    assert.equal(isDigitsOnly(null), false);
    assert.equal(isDigitsOnly(undefined), false);

    assert.equal(normalizeLeadingSlash('m/movie'), '/m/movie');
    assert.equal(normalizeLeadingSlash('/m/movie'), '/m/movie');
    assert.equal(normalizeLeadingSlash('https://example.com/test'), 'https://example.com/test');
    assert.equal(normalizeLeadingSlash(''), null);
    assert.equal(normalizeLeadingSlash(null), null);
});

test('buildProviderHref correctly resolves IMDb links', () => {
    // With IMDb ID
    const href1 = buildProviderHref('imdb', {}, { ids: { imdb: 'tt0137523' } });
    assert.equal(href1, 'https://www.imdb.com/title/tt0137523/');

    // With direct rating URL override
    const href2 = buildProviderHref('imdb', { url: 'https://www.imdb.com/title/tt0137523/' }, {});
    assert.equal(href2, 'https://www.imdb.com/title/tt0137523/');

    // Alias whatson_imdb
    const href3 = buildProviderHref('whatson_imdb', {}, { ids: { imdb: 'tt0137523' } });
    assert.equal(href3, 'https://www.imdb.com/title/tt0137523/');

    // Without ID or URL returns null
    const hrefNull = buildProviderHref('imdb', {}, {});
    assert.equal(hrefNull, null);
});

test('buildProviderHref correctly resolves TMDb links for movies, shows, seasons, and episodes', () => {
    // Movie link
    const movieHref = buildProviderHref('tmdb', {}, { ids: { tmdb: 550 }, contentType: 'movie' });
    assert.equal(movieHref, 'https://www.themoviedb.org/movie/550');

    // TV Show link
    const showHref = buildProviderHref('tmdb', {}, { ids: { tmdb: 1399 }, contentType: 'show' });
    assert.equal(showHref, 'https://www.themoviedb.org/tv/1399');

    // Season link
    const seasonHref = buildProviderHref('tmdb', {}, { ids: { tmdb: 1399 }, contentType: 'season', seasonNumber: 2 });
    assert.equal(seasonHref, 'https://www.themoviedb.org/tv/1399/season/2');

    // Episode link
    const episodeHref = buildProviderHref('tmdb', {}, { ids: { tmdb: 1399 }, contentType: 'episode', seasonNumber: 2, episodeNumber: 5 });
    assert.equal(episodeHref, 'https://www.themoviedb.org/tv/1399/season/2/episode/5');

    // Direct URL
    const directHref = buildProviderHref('tmdb', { url: '/movie/550-fight-club' }, {});
    assert.equal(directHref, 'https://www.themoviedb.org/movie/550-fight-club');
});

test('buildProviderHref correctly resolves Trakt links', () => {
    // Movie
    const traktMovie = buildProviderHref('trakt', {}, { ids: { imdb: 'tt0137523' }, contentType: 'movie' });
    assert.equal(traktMovie, 'https://trakt.tv/movies/tt0137523');

    // Show
    const traktShow = buildProviderHref('trakt', {}, { ids: { imdb: 'tt0944947' }, contentType: 'show' });
    assert.equal(traktShow, 'https://trakt.tv/shows/tt0944947');

    // Episode
    const traktEp = buildProviderHref('trakt', {}, { ids: { imdb: 'tt0944947' }, contentType: 'episode', seasonNumber: 1, episodeNumber: 1 });
    assert.equal(traktEp, 'https://trakt.tv/shows/tt0944947/seasons/1/episodes/1');
});

test('buildProviderHref correctly resolves Rotten Tomatoes links', () => {
    // Tomatoes critics
    const rtHref = buildProviderHref('tomatoes', { url: '/m/fight_club' }, {});
    assert.equal(rtHref, 'https://www.rottentomatoes.com/m/fight_club');

    // Popcorn audience
    const popcornHref = buildProviderHref('popcorn', { url: '/m/fight_club' }, {});
    assert.equal(popcornHref, 'https://www.rottentomatoes.com/m/fight_club');

    // Rejects digits only
    const invalidRt = buildProviderHref('tomatoes', { url: '12345' }, {});
    assert.equal(invalidRt, null);
});

test('buildProviderHref correctly resolves Metacritic links', () => {
    // Movie without prefix in url
    const mcMovie = buildProviderHref('metacritic', { url: 'fight-club' }, { contentType: 'movie' });
    assert.equal(mcMovie, 'https://www.metacritic.com/movie/fight-club');

    // Show with prefix in url
    const mcShow = buildProviderHref('metacritic', { url: '/tv/breaking-bad' }, { contentType: 'show' });
    assert.equal(mcShow, 'https://www.metacritic.com/tv/breaking-bad');

    // User ratings
    const mcUser = buildProviderHref('metacriticuser', { url: '/movie/fight-club' }, { contentType: 'movie' });
    assert.equal(mcUser, 'https://www.metacritic.com/movie/fight-club');
});

test('buildProviderHref correctly resolves Letterboxd and other providers', () => {
    // Letterboxd
    const lbHref = buildProviderHref('letterboxd', { url: '/film/fight-club/' }, {});
    assert.equal(lbHref, 'https://letterboxd.com/film/fight-club/');

    // MAL
    const malDigits = buildProviderHref('myanimelist', { url: '1' }, {});
    assert.equal(malDigits, 'https://myanimelist.net/anime/1');

    // AniList
    const anilistDigits = buildProviderHref('anilist', { url: '20' }, {});
    assert.equal(anilistDigits, 'https://anilist.co/anime/20');

    // Kinopoisk
    const kinopoiskHref = buildProviderHref('kinopoisk', { url: '361' }, {});
    assert.equal(kinopoiskHref, 'https://www.kinopoisk.ru/film/361/');

    // MDBList
    const mdbHref = buildProviderHref('mdblist', {}, { ids: { imdb: 'tt0137523' } });
    assert.equal(mdbHref, 'https://mdblist.com/item/tt0137523');
});

test('MDBList plugin HTML rendering creates non-focusable clickable links only when clickable setting is true, unifying icon and score as 1 entry', () => {
    const ratings = [
        { source: 'imdb', value: 8.8, score: 88, url: null },
        { source: 'tomatoes', value: 7.9, score: 79, url: '/m/fight_club' }
    ];
    const context = { ids: { imdb: 'tt0137523' }, contentType: 'movie' };

    // 1. Render with clickable = true (both icon and score wrapped together as 1 entry)
    const activeSettingsOn = { clickable: true };
    let htmlOn = '';
    for (const r of ratings) {
        const href = buildProviderHref(r.source, r, context);
        assert.ok(href, `Expected href for ${r.source}`);
        const itemInnerHtml = `<span class="provider-icon icon-${r.source}"><img src="${r.source}.png"/></span><span class="mdblist-value">${r.value}</span>`;
        htmlOn += `<div class="mdblist-item"><a href="${href}" class="mdblist-rating-link" target="_blank" rel="noopener noreferrer" tabindex="-1">${itemInnerHtml}</a></div>`;
    }

    // Verify tabindex="-1" exists so spatial navigation and keyboard tab strictly skip it
    assert.ok(htmlOn.includes('tabindex="-1"'));
    assert.ok(htmlOn.includes('class="mdblist-rating-link"'));
    assert.ok(htmlOn.includes('href="https://www.imdb.com/title/tt0137523/"'));
    assert.ok(htmlOn.includes('href="https://www.rottentomatoes.com/m/fight_club"'));

    // Verify both provider-icon AND mdblist-value are inside the single mdblist-rating-link anchor
    for (const r of ratings) {
        assert.ok(htmlOn.includes(`<span class="provider-icon icon-${r.source}"><img src="${r.source}.png"/></span>`));
        assert.ok(htmlOn.includes(`<span class="mdblist-value">${r.value}</span>`));
    }

    // 2. Render with clickable = false
    const activeSettingsOff = { clickable: false };
    let htmlOff = '';
    for (const r of ratings) {
        const href = activeSettingsOff.clickable ? buildProviderHref(r.source, r, context) : null;
        const itemInnerHtml = `<span class="provider-icon icon-${r.source}"><img src="${r.source}.png"/></span><span class="mdblist-value">${r.value}</span>`;
        if (href) {
            htmlOff += `<div class="mdblist-item"><a href="${href}" class="mdblist-rating-link" tabindex="-1">${itemInnerHtml}</a></div>`;
        } else {
            htmlOff += `<div class="mdblist-item">${itemInnerHtml}</div>`;
        }
    }
    assert.equal(htmlOff.includes('mdblist-rating-link'), false);
    assert.equal(htmlOff.includes('<a '), false);
    assert.ok(htmlOff.includes('provider-icon'));
    assert.ok(htmlOff.includes('mdblist-value'));
});
