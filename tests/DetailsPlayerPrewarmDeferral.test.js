import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * ============================================================================
 * DetailsPage Player Chunk Prewarm Deferral Test Suite
 * ============================================================================
 * Verifies that navigating to /details/:id:
 *   1. Does not fire loadPlayerModule() on an un-gated 600ms timer mid-render.
 *   2. Waits for DetailsPage to finish mounting its rows ('details:ready',
 *      backed by a bounded fallback timer) and then gates prewarmPlayerChunk()
 *      behind idleGate.runWhenIdle(..., 1500, 6000).
 *   3. Cancels any pending details prewarm task when navigating away from /details.
 * ============================================================================
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSrc = (relPath) => readFileSync(resolve(__dirname, '..', relPath), 'utf8');

test('App.js & DetailsPage.js: defer details-entry player chunk prewarm until rows mount and idleGate settles', () => {
    const appSrc = readSrc('src/core/App.js');
    const detailsSrc = readSrc('src/pages/DetailsPage.js');

    // Old un-gated 600ms timer must be gone so compilation cannot collide with row mounts
    assert.ok(!appSrc.includes('DETAILS_PREWARM_DELAY_MS'), 'Fixed 600ms details prewarm delay must be removed');

    // Verify idle-gate window parameters requested for details entry
    assert.match(appSrc, /const DETAILS_PREWARM_IDLE_MS\s*=\s*1500;/);
    assert.match(appSrc, /const DETAILS_PREWARM_MAX_WAIT_MS\s*=\s*6000;/);
    assert.match(
        appSrc,
        /armDetailsIdlePrewarm[\s\S]*idleGate\.markActivity\(\);[\s\S]*idleGate\.runWhenIdle\([\s\S]*prewarmPlayerChunk\('details entry'\)[\s\S]*DETAILS_PREWARM_IDLE_MS,\s*DETAILS_PREWARM_MAX_WAIT_MS/,
        'armDetailsIdlePrewarm must anchor activity and gate prewarmPlayerChunk behind idleGate.runWhenIdle(..., 1500, 6000)'
    );

    // Verify DetailsPage emits details:ready only after _loadDetails() and markReady() complete
    assert.match(
        detailsSrc,
        /await this\._loadDetails\(\);[\s\S]*?this\.markReady\(\);[\s\S]*?eventBus\.emit\('details:ready'/,
        'DetailsPage must emit details:ready after _loadDetails() and markReady() finish'
    );

    // Verify App wires details:ready and cancels pending details prewarm on route exit
    assert.match(appSrc, /eventBus\.on\('details:ready'/, 'App.js must listen for details:ready');
    assert.match(
        appSrc,
        /eventBus\.on\('router:navigate'[\s\S]*?scheduleDetailsPrewarm\(\);[\s\S]*?cancelDetailsPrewarm\(\);/,
        'App.js must cancel pending details prewarm when navigating away from /details'
    );
});
