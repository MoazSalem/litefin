/**
 * ============================================================================
 * Litefin Tizen - seerrNormalize Check
 * ============================================================================
 * Run with: node scripts/check-seerr-normalize.mjs
 * ============================================================================
 */

import assert from 'node:assert/strict';
import { normalizeSeerrItem, seerrStatusKey, normalizeSeerrBaseUrl, SEERR_STATUS } from '../src/api/seerrNormalize.js';

// Base URL: an explicit scheme is kept, trailing slashes dropped
assert.equal(normalizeSeerrBaseUrl('https://seer.example.com/'), 'https://seer.example.com');
assert.equal(normalizeSeerrBaseUrl('  http://seer.example.com//  '), 'http://seer.example.com');

// A schemeless LAN address gets http, a schemeless hostname gets https
assert.equal(normalizeSeerrBaseUrl('192.168.1.20:5055'), 'http://192.168.1.20:5055');
assert.equal(normalizeSeerrBaseUrl('192.168.1.20'), 'http://192.168.1.20');
assert.equal(normalizeSeerrBaseUrl('seer.example.com'), 'https://seer.example.com');
assert.equal(normalizeSeerrBaseUrl('seer.example.com:5055'), 'http://seer.example.com:5055');

// Empty input clears the configuration rather than yielding a bare scheme
assert.equal(normalizeSeerrBaseUrl(''), '');
assert.equal(normalizeSeerrBaseUrl('   '), '');
assert.equal(normalizeSeerrBaseUrl(undefined), '');

// Movie
const movie = normalizeSeerrItem({
    id: 603,
    mediaType: 'movie',
    title: 'The Matrix',
    overview: 'A computer hacker learns...',
    releaseDate: '1999-03-30',
    posterPath: '/poster.jpg',
    backdropPath: '/backdrop.jpg',
    runtime: 136,
    voteAverage: 8.2,
    genres: [{ id: 28, name: 'Action' }],
    tagline: 'Welcome to the Real World.',
    mediaInfo: { status: 5 }
});

assert.equal(movie.Id, 'tmdb-movie-603');
assert.equal(movie.Name, 'The Matrix');
assert.equal(movie.Type, 'Movie');
assert.equal(movie.ProductionYear, 1999);
assert.equal(movie._imageUrl, 'https://image.tmdb.org/t/p/w300/poster.jpg');
assert.equal(movie._detailImageUrl, 'https://image.tmdb.org/t/p/w500/poster.jpg');
assert.equal(movie._backdropUrl, 'https://image.tmdb.org/t/p/w1280/backdrop.jpg');
assert.equal(movie._seerrStatus, 5);
assert.equal(movie._tmdbId, 603);
assert.equal(movie._mediaType, 'movie');
assert.equal(movie.Overview, 'A computer hacker learns...');
assert.equal(movie.RunTimeTicks, 136 * 600000000);
assert.equal(movie.CommunityRating, 8.2);
assert.deepEqual(movie.Genres, ['Action']);
assert.equal(movie.Tagline, 'Welcome to the Real World.');

// Series: title comes from `name`, year from `firstAirDate`
const tv = normalizeSeerrItem({
    id: 1396,
    mediaType: 'tv',
    name: 'Breaking Bad',
    firstAirDate: '2008-01-20',
    posterPath: '/bb.jpg',
    episodeRunTime: [47]
});

assert.equal(tv.Id, 'tmdb-tv-1396');
assert.equal(tv.Name, 'Breaking Bad');
assert.equal(tv.Type, 'Series');
assert.equal(tv.ProductionYear, 2008);
assert.equal(tv._mediaType, 'tv');
assert.equal(tv.RunTimeTicks, 47 * 600000000);

// No mediaInfo means never requested
assert.equal(tv._seerrStatus, 0);

// No posterPath: empty string, so CardRenderer falls back to its own placeholder
const noPoster = normalizeSeerrItem({ id: 7, mediaType: 'movie', title: 'X', posterPath: null });
assert.equal(noPoster._imageUrl, '');

// Missing or malformed date must yield undefined, never NaN
const noDate = normalizeSeerrItem({ id: 8, mediaType: 'movie', title: 'Y' });
assert.equal(noDate.ProductionYear, undefined);
assert.equal(noDate.Overview, '');
const badDate = normalizeSeerrItem({ id: 9, mediaType: 'movie', title: 'Z', releaseDate: '' });
assert.equal(badDate.ProductionYear, undefined);
// Truthy but unparseable date: exercises the isNaN branch, not just the falsy short-circuit
const malformedDate = normalizeSeerrItem({ id: 11, mediaType: 'movie', title: 'V', releaseDate: 'not-a-date' });
assert.equal(malformedDate.ProductionYear, undefined);

// Invalid input
assert.equal(normalizeSeerrItem(null), null);
assert.equal(normalizeSeerrItem({ mediaType: 'movie', title: 'No id' }), null);

// Missing mediaType falls back to movie unless tv indicators or fallback are present
const noType = normalizeSeerrItem({ id: 10, title: 'W' });
assert.equal(noType.Type, 'Movie');
assert.equal(noType.Id, 'tmdb-movie-10');

const tvWithoutMediaType = normalizeSeerrItem({ id: 125988, name: 'Silo', firstAirDate: '2023-05-04' });
assert.equal(tvWithoutMediaType._mediaType, 'tv');
assert.equal(tvWithoutMediaType.Type, 'Series');

const tvWithFallback = normalizeSeerrItem({ id: 125988, name: 'Silo' }, 'tv');
assert.equal(tvWithFallback._mediaType, 'tv');
assert.equal(tvWithFallback.Type, 'Series');

// Status table
assert.equal(seerrStatusKey(SEERR_STATUS.PENDING), 'SeerrStatusPending');
assert.equal(seerrStatusKey(SEERR_STATUS.PROCESSING), 'SeerrStatusPending');
assert.equal(seerrStatusKey(SEERR_STATUS.PARTIALLY_AVAILABLE), 'SeerrStatusPartial');
assert.equal(seerrStatusKey(SEERR_STATUS.AVAILABLE), 'SeerrStatusAvailable');
assert.equal(seerrStatusKey(0), 'SeerrStatusNotRequested');
assert.equal(seerrStatusKey(1), 'SeerrStatusNotRequested');
assert.equal(seerrStatusKey(6), 'SeerrStatusNotRequested');
assert.equal(seerrStatusKey(undefined), 'SeerrStatusNotRequested');

console.log('seerrNormalize: OK');
