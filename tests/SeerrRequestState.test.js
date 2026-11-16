import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SEERR_STATUS,
    getSeerrRequestActions,
    hasUnrequestedSeerrSeasons,
    isSeerrSeasonCovered,
    seerrCardState
} from '../src/api/seerrNormalize.js';

/**
 * ============================================================================
 * Unit Tests: Seerr Request State
 * ============================================================================
 * The rules shared by the Seerr details page, the request modal and the
 * card renderer: season coverage, request/cancel actions and card state.
 * ============================================================================
 */

const item = (fields) => ({ _mediaType: 'tv', _seerrStatus: SEERR_STATUS.NOT_REQUESTED, ...fields });

test('a season counts as covered once available or requested', () => {
    assert.equal(isSeerrSeasonCovered(SEERR_STATUS.AVAILABLE), true);
    assert.equal(isSeerrSeasonCovered(SEERR_STATUS.PENDING), true);
    assert.equal(isSeerrSeasonCovered(SEERR_STATUS.PROCESSING), true);
    for (const open of [0, SEERR_STATUS.UNKNOWN, SEERR_STATUS.PARTIALLY_AVAILABLE, SEERR_STATUS.DELETED]) {
        assert.equal(isSeerrSeasonCovered(open), false);
    }
    assert.equal(hasUnrequestedSeerrSeasons([{ status: 5 }, { status: 3 }]), false);
    assert.equal(hasUnrequestedSeerrSeasons([{ status: 5 }, { status: 4 }]), true);
    assert.equal(hasUnrequestedSeerrSeasons(null), false);
});

test('request actions: who may request, who may cancel, and the button label', () => {
    const movie = (fields) => item({ _mediaType: 'movie', ...fields });
    assert.equal(getSeerrRequestActions(movie({})).requestable, true);
    assert.equal(getSeerrRequestActions(movie({ _seerrStatus: SEERR_STATUS.PROCESSING })).requestable, false);
    assert.equal(getSeerrRequestActions(movie({ _seerrStatus: SEERR_STATUS.DELETED })).labelKey, 'SeerrRequest');

    const partial = item({ _seerrStatus: SEERR_STATUS.PARTIALLY_AVAILABLE });
    assert.deepEqual(getSeerrRequestActions(partial, { hasUnrequestedSeasons: true }), {
        requestable: true,
        canCancel: false,
        labelKey: 'SeerrRequestMore'
    });
    assert.equal(getSeerrRequestActions(partial, { hasUnrequestedSeasons: false }).requestable, false);
    // An unknown season answer must not hide the button
    assert.equal(getSeerrRequestActions(partial).requestable, true);
    assert.equal(getSeerrRequestActions(item({ _seerrStatus: SEERR_STATUS.AVAILABLE })).requestable, false);

    const pending = item({ _seerrStatus: SEERR_STATUS.PENDING, _requestId: 7 });
    assert.equal(getSeerrRequestActions(pending).canCancel, true);
    assert.equal(getSeerrRequestActions(pending).labelKey, 'SeerrViewRequest');
    const approved = item({ _seerrStatus: SEERR_STATUS.PROCESSING, _requestId: 7 });
    assert.equal(getSeerrRequestActions(approved).canCancel, false);
    assert.equal(getSeerrRequestActions(approved, { isAdmin: true }).canCancel, true);
    assert.equal(
        getSeerrRequestActions(item({ _seerrStatus: SEERR_STATUS.AVAILABLE, _requestId: 7 }), { isAdmin: true })
            .canCancel,
        false
    );
});

test('card state: requested, partial, available', () => {
    assert.equal(seerrCardState(item({ _seerrStatus: SEERR_STATUS.PENDING })), 'requested');
    assert.equal(seerrCardState(item({ _seerrStatus: SEERR_STATUS.UNKNOWN, _requestId: 3 })), 'requested');
    assert.equal(seerrCardState(item({ _seerrStatus: SEERR_STATUS.PARTIALLY_AVAILABLE, _requestId: 3 })), 'partial');
    assert.equal(seerrCardState(item({ _seerrStatus: SEERR_STATUS.AVAILABLE })), 'available');
    assert.equal(seerrCardState(item({})), null);
    assert.equal(seerrCardState({ Id: 'jellyfin-item' }), null);
});
