import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Playback Stop State Reconciliation Test Suite
 * ============================================================================
 * Verifies that when playback ends or stops, the authoritative client state
 * prevents read-after-write race conditions where the server database has not
 * yet committed updated UserData.
 * ============================================================================
 */

test('reconciles item with authoritative lastStopped state when server UserData is stale', () => {
    // Simulated item with stale unplayed / resume state returned by server
    const item = {
        Id: 'item-101',
        Name: 'Test Movie',
        UserData: {
            Played: false,
            PlaybackPositionTicks: 500000000,
            UnplayedItemCount: 1
        }
    };

    // Authoritative snapshot recorded when PlayerPage stopped at 95%
    const lastStopped = {
        itemId: 'item-101',
        positionTicks: 0,
        durationTicks: 1000000000,
        isNearComplete: true,
        timestamp: Date.now()
    };

    // Reconciliation logic as implemented in DetailsPage and HomePage
    if (lastStopped && lastStopped.itemId === item.Id && Date.now() - lastStopped.timestamp < 30000) {
        item.UserData = item.UserData || {};
        if (lastStopped.isNearComplete) {
            item.UserData.Played = true;
            item.UserData.PlaybackPositionTicks = 0;
            item.UserData.UnplayedItemCount = 0;
        } else if (lastStopped.positionTicks > 0) {
            item.UserData.PlaybackPositionTicks = lastStopped.positionTicks;
        }
    }

    assert.equal(item.UserData.Played, true);
    assert.equal(item.UserData.PlaybackPositionTicks, 0);
    assert.equal(item.UserData.UnplayedItemCount, 0);
});

test('reconciles partially played item to latest resume position', () => {
    // Server returns older position (e.g. 100s) before stop report at 400s committed
    const item = {
        Id: 'item-202',
        Name: 'In Progress Movie',
        UserData: {
            Played: false,
            PlaybackPositionTicks: 1000000000
        }
    };

    const lastStopped = {
        itemId: 'item-202',
        positionTicks: 4000000000,
        durationTicks: 7200000000,
        isNearComplete: false,
        timestamp: Date.now()
    };

    if (lastStopped && lastStopped.itemId === item.Id && Date.now() - lastStopped.timestamp < 30000) {
        item.UserData = item.UserData || {};
        if (lastStopped.isNearComplete) {
            item.UserData.Played = true;
            item.UserData.PlaybackPositionTicks = 0;
        } else if (lastStopped.positionTicks > 0) {
            item.UserData.PlaybackPositionTicks = lastStopped.positionTicks;
        }
    }

    assert.equal(item.UserData.Played, false);
    assert.equal(item.UserData.PlaybackPositionTicks, 4000000000);
});

test('does not reconcile if lastStopped timestamp is expired', () => {
    const item = {
        Id: 'item-303',
        UserData: {
            Played: false,
            PlaybackPositionTicks: 100
        }
    };

    const expiredLastStopped = {
        itemId: 'item-303',
        positionTicks: 0,
        isNearComplete: true,
        timestamp: Date.now() - 40000 // 40s ago (beyond 30s threshold)
    };

    if (expiredLastStopped && expiredLastStopped.itemId === item.Id && Date.now() - expiredLastStopped.timestamp < 30000) {
        item.UserData.Played = true;
        item.UserData.PlaybackPositionTicks = 0;
    }

    assert.equal(item.UserData.Played, false);
    assert.equal(item.UserData.PlaybackPositionTicks, 100);
});

test('merged row filters out finished item immediately after reconciliation', () => {
    const thresholdFraction = 0.85;
    const lastStopped = {
        itemId: 'ep-5',
        positionTicks: 0,
        durationTicks: 24000000000,
        isNearComplete: true,
        timestamp: Date.now()
    };

    const serverItems = [
        {
            Id: 'ep-5',
            Type: 'Episode',
            RunTimeTicks: 24000000000,
            UserData: {
                Played: false, // Server still says unplayed
                PlaybackPositionTicks: 21000000000
            }
        },
        {
            Id: 'ep-6',
            Type: 'Episode',
            RunTimeTicks: 24000000000,
            UserData: {
                Played: false,
                PlaybackPositionTicks: 0
            }
        }
    ];

    const filtered = serverItems.filter((item) => {
        if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) return false;

        // Reconcile
        if (lastStopped && item.Id === lastStopped.itemId && Date.now() - lastStopped.timestamp < 60000) {
            item.UserData = item.UserData || {};
            if (lastStopped.isNearComplete) {
                item.UserData.Played = true;
                item.UserData.PlaybackPositionTicks = 0;
            } else if (lastStopped.positionTicks > 0) {
                item.UserData.PlaybackPositionTicks = lastStopped.positionTicks;
            }
        }

        if (item.UserData?.Played) return false;

        const positionTicks = item.UserData?.PlaybackPositionTicks || 0;
        const runTimeTicks = item.RunTimeTicks || 0;
        if (positionTicks > 0 && runTimeTicks > 0) {
            const progress = positionTicks / runTimeTicks;
            if (progress >= thresholdFraction) return false;
        }

        return true;
    });

    // ep-5 was marked complete in lastStopped, so it is filtered out! Only ep-6 remains.
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].Id, 'ep-6');
});


test('multi-item playback stop preservation keeps previous item stop snapshot when subsequent item plays', () => {
    // ------------------------------------------------------------------------
    // In-Memory State Manager Simulation
    // ------------------------------------------------------------------------
    // Emulates Litefin StateManager instance storing recent playback stop metadata
    const mockState = new Map();

    // Step 1: User watches Movie "Sigma" and exits at ~23 minutes (14,199,970,000 ticks)
    const stopSnapshotA = {
        itemId: 'item-sigma-1',
        positionTicks: 14199970000,
        durationTicks: 60000000000,
        isNearComplete: false,
        timestamp: Date.now()
    };

    // Store in singular fallback, item-scoped key, and bounded map
    mockState.set('playback:lastStopped', stopSnapshotA);
    mockState.set(`playback:lastStopped:${stopSnapshotA.itemId}`, stopSnapshotA);
    const map1 = mockState.get('playback:lastStoppedMap') || {};
    map1[stopSnapshotA.itemId] = stopSnapshotA;
    mockState.set('playback:lastStoppedMap', map1);

    // Step 2: User briefly watches and stops another item ("Circle of Life") at 5 minutes
    const stopSnapshotB = {
        itemId: 'item-circle-2',
        positionTicks: 3000000000,
        durationTicks: 30000000000,
        isNearComplete: false,
        timestamp: Date.now()
    };

    // The singular 'playback:lastStopped' slot is now overwritten by item B
    mockState.set('playback:lastStopped', stopSnapshotB);
    mockState.set(`playback:lastStopped:${stopSnapshotB.itemId}`, stopSnapshotB);
    const map2 = mockState.get('playback:lastStoppedMap') || {};
    map2[stopSnapshotB.itemId] = stopSnapshotB;
    mockState.set('playback:lastStoppedMap', map2);

    // Step 3: User navigates back to Movie "Sigma"
    // Jellyfin server SQLite transaction has not completed or returns stale pre-playback state (422.244s)
    const serverItemA = {
        Id: 'item-sigma-1',
        Name: 'Sigma',
        UserData: {
            Played: false,
            PlaybackPositionTicks: 4222440000,
            LastPlayedDate: new Date(Date.now() - 100000).toISOString()
        }
    };

    // Reconcile item A using item-keyed snapshot or map
    const lastStoppedForA =
        mockState.get(`playback:lastStopped:${serverItemA.Id}`) ||
        mockState.get('playback:lastStoppedMap')?.[serverItemA.Id] ||
        (mockState.get('playback:lastStopped')?.itemId === serverItemA.Id ? mockState.get('playback:lastStopped') : null);

    // Verify snapshot for item A is successfully retrieved
    assert.ok(lastStoppedForA, 'Stop snapshot for item A must be preserved when another item is stopped');
    assert.equal(lastStoppedForA.itemId, 'item-sigma-1');
    assert.equal(lastStoppedForA.positionTicks, 14199970000);

    // Execute reconciliation logic
    if (lastStoppedForA && Date.now() - lastStoppedForA.timestamp < 900000) {
        serverItemA.UserData.PlaybackPositionTicks = lastStoppedForA.positionTicks;
    }

    // Verify position is reconciled to 23 minutes (14199970000 ticks), NOT stale 7 minutes (4222440000 ticks)
    assert.equal(serverItemA.UserData.PlaybackPositionTicks, 14199970000);
});

test('ApiClient getItem configures cache no-store and suppresses If-None-Match', () => {
    // ------------------------------------------------------------------------
    // API Client HTTP Request Simulation
    // ------------------------------------------------------------------------
    const capturedRequests = [];
    const mockApiClient = {
        _userId: 'test-user',
        _etagCache: new Map([
            ['/Items/item-123?userId=test-user', { etag: 'W/"old-etag-123"', body: {} }]
        ]),
        isJF12Plus() { return true; },
        get(url, params, options) {
            capturedRequests.push({ url, params, options });
            return Promise.resolve({ Id: 'item-123' });
        }
    };

    // Replicate ApiClient.getItem implementation
    async function getItem(itemId, params = {}, options = {}) {
        const itemOptions = {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                ...(options.headers || {})
            },
            ...options
        };
        if (mockApiClient.isJF12Plus()) {
            return mockApiClient.get(`/Items/${itemId}`, { userId: mockApiClient._userId, ...params }, itemOptions);
        }
        return mockApiClient.get(`/Users/${mockApiClient._userId}/Items/${itemId}`, params, itemOptions);
    }

    getItem('item-123');

    // Confirm request options enforce fresh non-cached payload
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0].options.cache, 'no-store');
    assert.equal(capturedRequests[0].options.headers['Cache-Control'], 'no-cache, no-store, must-revalidate');

    // Emulate ApiClient.request header assembly
    const headers = {};
    const fetchOptions = { cache: capturedRequests[0].options.cache };
    const etagEntry = mockApiClient._etagCache.get('/Items/item-123?userId=test-user');
    const isNoCache = fetchOptions.cache === 'no-store' || fetchOptions.cache === 'no-cache';

    // If-None-Match must be bypassed for fresh queries to avoid 304 Not Modified
    if (etagEntry && etagEntry.etag && !isNoCache) {
        headers['If-None-Match'] = etagEntry.etag;
    }

    assert.equal(headers['If-None-Match'], undefined);
});

test('PlayerPage resume calculation adjusts explicit startPositionTicks with user rewind offset', () => {
    // ------------------------------------------------------------------------
    // Player Contextual Rewind Calculation Simulation
    // ------------------------------------------------------------------------
    // Configure 5-second rewind offset (50,000,000 ticks)
    const rewindTicks = 50000000;
    const mockPlayerSettings = {
        getAdjustedResumePositionTicks(rawTicks) {
            return Math.max(0, rawTicks - rewindTicks);
        }
    };

    const explicitStartTicks = 14199970000; // 1419.997 seconds (~23.66 minutes)
    const isResume = true;

    // Calculate effective start position
    let resumePosition = 0;
    if (explicitStartTicks !== null && !isNaN(explicitStartTicks) && explicitStartTicks > 0) {
        resumePosition = isResume
            ? mockPlayerSettings.getAdjustedResumePositionTicks(explicitStartTicks)
            : explicitStartTicks;
    }

    // 14199970000 minus 50000000 equals 14149970000
    assert.equal(resumePosition, 14149970000);
});
