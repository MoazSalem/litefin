import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill minimal browser DOM globals for Node test environment
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' })
};

const { parseSubtitleMetadata, formatProviderName } = await import('../src/utils/Utils.js');

/**
 * ============================================================================
 * Subtitle Plugins Support Test Suite (SubBuzz & Bazarr)
 * ============================================================================
 * Validates rich metadata extraction and edge cases for:
 * 1. Bazarr plugin: movie/episode IDs, comment score & uploader, async placeholders
 * 2. SubBuzz plugin: multi-provider IDs, [AI]/[MT] tags, HTML stripping, comments
 * 3. Standard Jellyfin subtitle providers
 * ============================================================================
 */

test('formatProviderName maps keys to clean, branded display names', () => {
    assert.equal(formatProviderName('opensubtitlescom'), 'OpenSubtitles');
    assert.equal(formatProviderName('subsource.net'), 'SubSource');
    assert.equal(formatProviderName('SubDl'), 'SubDL');
    assert.equal(formatProviderName('yifysubtitles'), 'YIFY Subtitles');
    assert.equal(formatProviderName('addic7ed'), 'Addic7ed');
    assert.equal(formatProviderName('subssabbz'), 'Subs.sab.bz');
    assert.equal(formatProviderName('CustomProvider'), 'CustomProvider');
});

test('parseSubtitleMetadata handles Bazarr movie and episode subtitle entries', () => {
    // 1. Bazarr movie with score, uploader, provider in ID, and forced flag
    const bazarrMovie = {
        Id: 'movie|142|opensubtitles|False|True|sub_binary_data',
        Name: 'Chainsaw_Man_The_Movie_Reze_Arc_(2025).ar.srt',
        ProviderName: 'Bazarr',
        Format: 'srt',
        Comment: 'opensubtitles - Score: 98% - by GoldenBeard',
        DownloadCount: 30983,
        HearingImpaired: false,
        Forced: true
    };

    const parsedMovie = parseSubtitleMetadata(bazarrMovie);
    assert.equal(parsedMovie.isPlaceholder, false);
    assert.equal(parsedMovie.name, 'Chainsaw_Man_The_Movie_Reze_Arc_(2025).ar.srt');
    assert.equal(parsedMovie.displayProvider, 'OpenSubtitles');
    assert.equal(parsedMovie.uploader, 'GoldenBeard');
    assert.equal(parsedMovie.score, 98);
    assert.equal(parsedMovie.isForced, true);
    assert.equal(parsedMovie.isHearingImpaired, false);
    assert.match(parsedMovie.matchBadge, /98% Match/);
    assert.equal(parsedMovie.downloads, '↓ 30,983');

    // 2. Bazarr episode with Hearing Impaired in ID and 100% hash match
    const bazarrEpisode = {
        Id: 'episode|981|subdl|True|False|data_content',
        Name: 'Show.S01E05.1080p.WEB-DL.srt',
        ProviderName: 'Bazarr',
        Format: 'ass',
        Comment: 'subdl - Score: 100%',
        IsHashMatch: true
    };

    const parsedEpisode = parseSubtitleMetadata(bazarrEpisode);
    assert.equal(parsedEpisode.isHearingImpaired, true);
    assert.equal(parsedEpisode.displayProvider, 'SubDL');
    assert.equal(parsedEpisode.format, 'ASS');
    assert.match(parsedEpisode.matchBadge, /100% Match/);
});

test('parseSubtitleMetadata identifies Bazarr search in-progress placeholders', () => {
    const placeholder = {
        Id: 'placeholder_in_progress',
        Name: 'Search in progress - results typically ready in 5-15 minutes',
        ProviderName: 'Bazarr',
        Comment: 'Bazarr is searching multiple providers in the background. Click Search again later.'
    };

    const parsed = parseSubtitleMetadata(placeholder);
    assert.equal(parsed.isPlaceholder, true);
    assert.equal(parsed.name, 'Search in progress - results typically ready in 5-15 minutes');
    assert.equal(parsed.placeholderComment, 'Bazarr is searching multiple providers in the background. Click Search again later.');
});

test('parseSubtitleMetadata extracts SubBuzz sub-providers, AI/MT tags, and cleans HTML', () => {
    // 1. SubBuzz entry with HTML in Name, [AI] tag, and SubBuzzProviderName
    const subbuzzAi = {
        Id: 'SubSource12345',
        Name: "<a href='https://subsource.net/sub/123'>[AI] [HI/SDH] Movie.2025.1080p.srt</a>",
        ProviderName: 'subbuzz',
        SubBuzzProviderName: 'SubSource',
        Format: 'srt',
        Comment: '[SubSource] Movie (2025) - High Quality | Score: 92.50 %',
        DownloadCount: 1540
    };

    const parsedAi = parseSubtitleMetadata(subbuzzAi);
    assert.equal(parsedAi.displayProvider, 'SubSource');
    // HTML tags and duplicate bracket prefixes should be cleanly stripped
    assert.equal(parsedAi.name, 'Movie.2025.1080p.srt');
    assert.equal(parsedAi.isAiTranslated, true);
    assert.equal(parsedAi.isHearingImpaired, true);
    assert.equal(parsedAi.score, 93);
    assert.match(parsedAi.matchBadge, /93% Match/);
    assert.equal(parsedAi.downloads, '↓ 1,540');

    // 2. SubBuzz entry with Machine Translated [MT] tag and ID prefix
    const subbuzzMt = {
        Id: 'Addic7ed998877',
        Name: '[MT] Episode.Release.Title.srt',
        ProviderName: 'subbuzz',
        Comment: '[Addic7ed] Translated via automated tool'
    };

    const parsedMt = parseSubtitleMetadata(subbuzzMt);
    assert.equal(parsedMt.displayProvider, 'Addic7ed');
    assert.equal(parsedMt.name, 'Episode.Release.Title.srt');
    assert.equal(parsedMt.isAiTranslated, true);
    assert.equal(parsedMt.isMachineTranslated, true);
});
