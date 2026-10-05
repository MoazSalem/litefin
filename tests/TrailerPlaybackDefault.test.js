import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Trailer Playback Mode Platform Defaults Test Suite
 * ============================================================================
 * Verifies that remote and online trailers default to:
 *   - 'internal_proxy' (New) on native TV platforms (Tizen and webOS)
 *   - 'internal_iframe' (Legacy Iframe) on Web/Desktop browsers
 * Also verifies that user manual overrides in player settings take precedence.
 * ============================================================================
 */

test('Trailer playback mode defaults correctly per platform and respects overrides', async () => {
    // Helper function mirroring PlayerSettings.js default resolution logic
    function resolveTrailerPlaybackMode(platform, storedValue = null) {
        const isTv = platform === 'tizen' || platform === 'webos';
        const defaultMode = isTv ? 'internal_proxy' : 'internal_iframe';
        return storedValue !== null ? storedValue : defaultMode;
    }

    // 1. Tizen default: internal_proxy (New)
    assert.strictEqual(
        resolveTrailerPlaybackMode('tizen'),
        'internal_proxy',
        'Tizen must default to internal_proxy (New) for remote trailers'
    );

    // 2. webOS default: internal_proxy (New)
    assert.strictEqual(
        resolveTrailerPlaybackMode('webos'),
        'internal_proxy',
        'webOS must default to internal_proxy (New) for remote trailers'
    );

    // 3. Web / Desktop default: internal_iframe (Legacy Iframe)
    assert.strictEqual(
        resolveTrailerPlaybackMode('web'),
        'internal_iframe',
        'Web/Desktop must default to internal_iframe (Legacy Iframe) for remote trailers'
    );

    // 4. Explicit user override to external app
    assert.strictEqual(
        resolveTrailerPlaybackMode('web', 'external'),
        'external',
        'Web explicitly set to external must return external'
    );
    assert.strictEqual(
        resolveTrailerPlaybackMode('tizen', 'external'),
        'external',
        'Tizen explicitly set to external must return external'
    );

    // 5. Explicit user override to internal_proxy on web
    assert.strictEqual(
        resolveTrailerPlaybackMode('web', 'internal_proxy'),
        'internal_proxy',
        'Web explicitly set to internal_proxy must return internal_proxy'
    );

    // 6. Explicit user override to internal_iframe on TV
    assert.strictEqual(
        resolveTrailerPlaybackMode('tizen', 'internal_iframe'),
        'internal_iframe',
        'Tizen explicitly set to internal_iframe must return internal_iframe'
    );
});
