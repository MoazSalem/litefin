/**
 * ============================================================================
 * Bootstrap Background Service Gating - Test Suite
 * ============================================================================
 * Verifies that the early Tizen/webOS background service launch is deferred
 * through idleGate instead of spawning an OS process while HomePage is still
 * fetching and rendering its initial rows.
 * ============================================================================
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('Bootstrap: background service launch is gated behind idleGate(6000ms)', () => {
    const source = fs.readFileSync(path.resolve('src/index.js'), 'utf8');

    assert.ok(
        source.includes("import { idleGate } from './utils/IdleGate.js';"),
        'Bootstrap entry must import idleGate'
    );

    const gateIdx = source.indexOf('idleGate.runWhenIdle(');
    assert.ok(gateIdx !== -1, 'Background service launch must be routed through idleGate.runWhenIdle');

    const gateBody = source.slice(gateIdx, gateIdx + 4000);

    assert.ok(
        /\},\s*6000,\s*0\s*\)/.test(gateBody),
        'Background service launch must wait for a 6000ms idle window with no max-wait cap'
    );
    assert.ok(
        gateBody.includes('tizen.application.launch('),
        'Tizen service launch must live inside the idle callback'
    );
    assert.ok(
        gateBody.includes('Tizen background service launched successfully'),
        'Launch success telemetry must remain intact'
    );

    // The Tizen launch must never appear before the idle gate registration
    const launchIdx = source.indexOf('tizen.application.launch(');
    assert.ok(launchIdx > gateIdx, 'Tizen launch must be registered after the idle gate');
});
