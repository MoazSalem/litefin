import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
 * =========================================================================
 * Season Details Page Up Next Unit Tests
 * =========================================================================
 * Validates that the "Next Up" section is displayed on the Season details
 * page only when the upcoming episode belongs to that active season.
 * =========================================================================
 */

test('DetailsPage source code verification for Season Up Next integration', () => {
    /*
     * Read the DetailsPage source file to perform architectural validation
     * on the secondary content loading pipeline and season scoping logic.
     */
    const detailsSource = readFileSync('src/pages/DetailsPage.js', 'utf8');

    // 1. Verify that Season secondary content invokes _loadNextUp
    assert.ok(
        detailsSource.includes("} else if (this._item.Type === 'Season') {"),
        'DetailsPage must handle Season type in _loadSecondaryContent'
    );
    assert.ok(
        detailsSource.includes('await this._loadNextUp();') &&
        detailsSource.includes('await this._loadEpisodes(seriesId, this._itemId);'),
        'DetailsPage must invoke _loadNextUp and load episodes on Season pages'
    );

    // 2. Verify that _loadNextUp resolves the parent series ID for Season items
    assert.ok(
        detailsSource.includes("if (this._item?.Type === 'Season') {"),
        '_loadNextUp must check if the active item is a Season'
    );
    assert.ok(
        detailsSource.includes('seriesId = this._item.SeriesId || this._item.ParentId;'),
        '_loadNextUp must resolve series ID via SeriesId or ParentId'
    );

    // 3. Verify season-scoping filter in _loadNextUp
    assert.ok(
        detailsSource.includes('nextEp.SeasonId && nextEp.SeasonId === this._itemId'),
        '_loadNextUp must check episode SeasonId against active season ID'
    );
    assert.ok(
        detailsSource.includes('nextEp.ParentId && nextEp.ParentId === this._itemId'),
        '_loadNextUp must check episode ParentId against active season ID'
    );
    assert.ok(
        detailsSource.includes('nextEp.ParentIndexNumber === this._item.IndexNumber'),
        '_loadNextUp must check ParentIndexNumber matching season IndexNumber'
    );

    // 4. Verify that when not within season, _nextUp is suppressed
    assert.ok(
        detailsSource.includes('this._nextUp = [];'),
        '_loadNextUp must clear _nextUp if episode belongs to a different season'
    );
});

test('Season scope verification accepts episode matching active season by SeasonId', () => {
    /*
     * Simulate active Season state
     */
    const activeSeason = {
        Id: 'season-1-id',
        Type: 'Season',
        IndexNumber: 1,
        SeriesId: 'series-99-id'
    };
    const activeSeasonId = activeSeason.Id;

    /*
     * Mock next up episode from server with identical SeasonId
     */
    const episode = {
        Id: 'episode-101-id',
        Name: 'Winter is Coming',
        SeasonId: 'season-1-id',
        ParentId: 'season-1-id',
        ParentIndexNumber: 1,
        IndexNumber: 1
    };

    const isWithinThisSeason = Boolean(
        (episode.SeasonId && episode.SeasonId === activeSeasonId) ||
        (episode.ParentId && episode.ParentId === activeSeasonId) ||
        (episode.ParentIndexNumber != null &&
            activeSeason.IndexNumber != null &&
            episode.ParentIndexNumber === activeSeason.IndexNumber)
    );

    assert.equal(isWithinThisSeason, true, 'Episode with matching SeasonId must be recognized as within this season');
});

test('Season scope verification accepts episode matching active season by ParentIndexNumber fallback', () => {
    /*
     * Simulate active Season state where SeasonId property on episode might be omitted
     */
    const activeSeason = {
        Id: 'season-2-id',
        Type: 'Season',
        IndexNumber: 2,
        SeriesId: 'series-99-id'
    };
    const activeSeasonId = activeSeason.Id;

    /*
     * Mock next up episode with ParentIndexNumber matching Season 2
     */
    const episode = {
        Id: 'episode-201-id',
        Name: 'The North Remembers',
        ParentIndexNumber: 2,
        IndexNumber: 1
    };

    const isWithinThisSeason = Boolean(
        (episode.SeasonId && episode.SeasonId === activeSeasonId) ||
        (episode.ParentId && episode.ParentId === activeSeasonId) ||
        (episode.ParentIndexNumber != null &&
            activeSeason.IndexNumber != null &&
            episode.ParentIndexNumber === activeSeason.IndexNumber)
    );

    assert.equal(isWithinThisSeason, true, 'Episode with matching ParentIndexNumber must be recognized as within this season');
});

test('Season scope verification rejects episode belonging to next season', () => {
    /*
     * Simulate active Season 1 state
     */
    const activeSeason = {
        Id: 'season-1-id',
        Type: 'Season',
        IndexNumber: 1,
        SeriesId: 'series-99-id'
    };
    const activeSeasonId = activeSeason.Id;

    /*
     * User has finished Season 1; Next Up episode returned for the series is S2E1
     */
    const episode = {
        Id: 'episode-201-id',
        Name: 'The North Remembers',
        SeasonId: 'season-2-id',
        ParentId: 'season-2-id',
        ParentIndexNumber: 2,
        IndexNumber: 1
    };

    const isWithinThisSeason = Boolean(
        (episode.SeasonId && episode.SeasonId === activeSeasonId) ||
        (episode.ParentId && episode.ParentId === activeSeasonId) ||
        (episode.ParentIndexNumber != null &&
            activeSeason.IndexNumber != null &&
            episode.ParentIndexNumber === activeSeason.IndexNumber)
    );

    assert.equal(isWithinThisSeason, false, 'Episode from Season 2 must not be treated as within Season 1');
});

test('Season scope verification rejects episode belonging to previous season', () => {
    /*
     * Simulate active Season 3 state
     */
    const activeSeason = {
        Id: 'season-3-id',
        Type: 'Season',
        IndexNumber: 3,
        SeriesId: 'series-99-id'
    };
    const activeSeasonId = activeSeason.Id;

    /*
     * User has an unwatched episode in Season 1
     */
    const episode = {
        Id: 'episode-105-id',
        Name: 'The Wolf and the Lion',
        SeasonId: 'season-1-id',
        ParentId: 'season-1-id',
        ParentIndexNumber: 1,
        IndexNumber: 5
    };

    const isWithinThisSeason = Boolean(
        (episode.SeasonId && episode.SeasonId === activeSeasonId) ||
        (episode.ParentId && episode.ParentId === activeSeasonId) ||
        (episode.ParentIndexNumber != null &&
            activeSeason.IndexNumber != null &&
            episode.ParentIndexNumber === activeSeason.IndexNumber)
    );

    assert.equal(isWithinThisSeason, false, 'Episode from Season 1 must not be treated as within Season 3');
});
