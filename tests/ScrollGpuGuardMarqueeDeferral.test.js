import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * ScrollController GPU scrollTop Guard & LazyLoader Marquee Deferral Tests
 * ============================================================================
 * Verifies that:
 * 1. The GPU scroll engines clamp `container.scrollTop` to 0 exactly ONCE at
 *    animation start; the per-frame RAF loops perform zero layout reads.
 * 2. Animation frames write a single transform property (feature-detected)
 *    instead of mutating both the `transform` and `webkitTransform` aliases.
 * 3. LazyLoader defers the marquee overflow measurement (scrollWidth /
 *    clientWidth reads force synchronous reflow) while a scroll transition is
 *    in flight, stashing the focused card in _pendingMarqueeTarget.
 * 4. Deferred marquee checks are flushed from BOTH scroll-settle paths:
 *    the native scroll debounce (150ms) and the 'scroll:finished' listener.
 * 5. The extracted _checkTextMarquee keeps the focus guard so stale targets
 *    are dropped instead of animating after focus has moved on.
 * ============================================================================
 */

test('ScrollController: GPU animation loop performs zero layout reads (single clamp at start)', () => {
    const source = readFileSync(new URL('../src/ui/ScrollController.js', import.meta.url), 'utf8');

    // 1. Each engine entry performs exactly one guarded scrollTop clamp, BEFORE
    //    the RAF loop starts. After that the container is guaranteed parked at 0.
    const clampPattern = /if \(isVertical && scrollMode === 'gpu' && container\.scrollTop !== 0\) \{/g;
    const clampCount = (source.match(clampPattern) || []).length;
    assert.strictEqual(
        clampCount,
        2,
        `Easing and spring engines must each clamp GPU scrollTop exactly once at entry (found ${clampCount})`
    );

    // 2. The easing RAF loop's GPU branches must contain no layout read at all.
    const animateMatch = source.match(
        /const animate = \(time\) => \{([\s\S]*?)\n {8}this\[animIdKey\] = requestAnimationFrame\(animate\);/m
    );
    assert.ok(animateMatch, 'GPU scroll animate loop must exist');
    const animateBody = animateMatch[1];

    const stripComments = (code) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const gpuBranches = [...animateBody.matchAll(/if \(scrollMode === 'gpu'\) \{([\s\S]*?)\n\s*\} else \{/g)].map(
        (m) => stripComments(m[1])
    );
    assert.strictEqual(gpuBranches.length >= 2, true, 'Easing loop must have per-frame and completion GPU branches');
    for (const branch of gpuBranches) {
        assert.strictEqual(
            /scrollTop|scrollHeight|getBoundingClientRect|offsetTop/.test(branch),
            false,
            'The per-frame easing GPU branch must perform zero layout reads'
        );
        assert.ok(
            branch.includes('writeTrackTransform('),
            'GPU branch must position the track with a single transform write'
        );
    }
    assert.ok(
        animateBody.includes('writeTrackTransform(state.track, newScroll)'),
        'GPU branch must position the track with the new scroll offset'
    );
    assert.ok(
        animateBody.includes('writeTrackTransform(state.track, state.target)'),
        'GPU completion branch must snap the track to the exact target'
    );

    // 3. The spring per-frame writer must not read scrollTop on the GPU branch.
    const springStart = source.indexOf('_springScrollTo({');
    const springEnd = source.indexOf('_springTrackHorizontal(', springStart);
    assert.ok(springStart !== -1 && springEnd > springStart, 'Spring engine must exist');
    const springBody = source.slice(springStart, springEnd);
    const writeMatch = springBody.match(/write = \(value\) => \{([\s\S]*?)\n {12}\};/);
    assert.ok(writeMatch, 'Spring per-frame writer must exist');
    const gpuWriteBody = stripComments(writeMatch[1].slice(0, writeMatch[1].indexOf('} else {')));
    assert.strictEqual(
        /scrollTop/.test(gpuWriteBody),
        false,
        'Spring GPU writer must not read scrollTop (single clamp happens before the loop)'
    );
    assert.ok(
        gpuWriteBody.includes('writeTrackTransform('),
        'Spring GPU writer must use the single-property transform helper'
    );

    // 4. The one-shot clamp must carry the layout-read rationale.
    assert.strictEqual(
        source.includes('ONE-SHOT GPU CLAMP'),
        true,
        'The clamp must document why the per-frame read was removed'
    );
});

test('LazyLoader: marquee measurement is deferred while scroll transitions are in flight', () => {
    const source = readFileSync(new URL('../src/utils/LazyLoader.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

    // 1. Pending target state is declared
    assert.strictEqual(
        source.includes('this._pendingMarqueeTarget = null;'),
        true,
        '_pendingMarqueeTarget must be initialized in the constructor'
    );

    // 2. The focus:changed RAF defers the layout query when scrolling is active.
    //    Extract the deferred marquee requestAnimationFrame block.
    const deferredMatch = source.match(
        /requestAnimationFrame\(\(\) => \{[\s\S]*?Guard against focus having already left the card[\s\S]*?\}\);\s*\}\s*\}/
    );
    assert.ok(deferredMatch, 'The deferred marquee RAF block must exist in the focus:changed handler');
    const rafBody = deferredMatch[0];
    assert.strictEqual(
        rafBody.includes('this._isScrolling()'),
        true,
        'The marquee RAF must check _isScrolling() before forcing layout'
    );
    assert.strictEqual(
        rafBody.includes('this._pendingMarqueeTarget = target;'),
        true,
        'The marquee RAF must stash the target when a scroll transition is active'
    );
    // The layout-forcing reads must NOT run inline in the deferred RAF anymore
    assert.strictEqual(
        rafBody.includes('span.scrollWidth'),
        false,
        'scrollWidth must not be read at frame 1 of a scroll transition'
    );

    // 3. Extracted measurement helper exists with focus + connectivity guards
    const checkMatch = source.match(/_checkTextMarquee\(target\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(checkMatch, '_checkTextMarquee must be defined');
    const checkBody = checkMatch[1];
    assert.strictEqual(
        checkBody.includes("target.classList.contains('focused')"),
        true,
        '_checkTextMarquee must guard against focus having left the card'
    );
    assert.strictEqual(
        checkBody.includes('scrollW = span.scrollWidth'),
        true,
        '_checkTextMarquee must read span.scrollWidth'
    );
    assert.strictEqual(
        checkBody.includes("el.classList.add('marquee-active')"),
        true,
        '_checkTextMarquee must engage the marquee class on overflow'
    );

    // 4. Flush helper exists and is invoked from BOTH settle paths
    assert.strictEqual(
        source.includes('_flushPendingMarquee() {\n        if (!this._pendingMarqueeTarget) return;'),
        true,
        '_flushPendingMarquee must exist and bail when nothing is pending'
    );
    const flushCalls = (source.match(/this\._flushPendingMarquee\(\);/g) || []).length;
    assert.strictEqual(
        flushCalls >= 2,
        true,
        `Deferred marquee flush must be wired into both scroll-settle paths (found ${flushCalls} call sites)`
    );

    // 5. One flush call must live in the native scroll debounce, the other
    //    inside the scroll:finished listener (both share the settle condition).
    const debounceBlock = source.match(/this\._scrollTimeout = setTimeout\(\(\) => \{[\s\S]*?\}, 150\);/);
    assert.ok(debounceBlock, 'native scroll debounce block must exist');
    assert.strictEqual(
        debounceBlock[0].includes('this._flushPendingMarquee()'),
        true,
        'Native scroll debounce (150ms) must flush deferred marquee checks'
    );
    const finishedBlock = source.match(/eventBus\.on\('scroll:finished', \(\) => \{[\s\S]*?\n        \}\);/);
    assert.ok(finishedBlock, 'scroll:finished listener must exist');
    assert.strictEqual(
        finishedBlock[0].includes('this._flushPendingMarquee()'),
        true,
        'scroll:finished listener must flush deferred marquee checks'
    );
});

test('ScrollController + CSS: no per-episode compositor toggling (GPU layer churn ban)', () => {
    // WHY: A per-episode gate that toggles will-change promotion on/off across
    // every keypress forces the compositor to tear down and rebuild ~40+ layers
    // twice per press on embedded Mali GPUs (on-device regression report:
    // single presses felt ~10x slower). The scroll path must stay toggle-free;
    // demotion wins must be achieved with static, scroll-state-independent CSS.
    const source = readFileSync(new URL('../src/ui/ScrollController.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');

    // 1. The scroll engine must never reference the scroll-active attribute
    //    or the reverted axis-gating helpers.
    assert.strictEqual(
        source.includes('data-scroll-active'),
        false,
        'ScrollController must not toggle data-scroll-active (per-episode layer churn regression)'
    );
    assert.strictEqual(
        source.includes('_activeScrollAxes') && source.includes('_beginScrollActivity'),
        false,
        'Reverted axis-gate helpers must not return to the scroll engine'
    );

    // 2. CSS must never gate styles on the scroll-state attribute.
    assert.strictEqual(
        css.includes('data-scroll-active'),
        false,
        'CSS must not gate styles on data-scroll-active (per-episode toggle regression)'
    );

    // 3. The static demotion that replaced the gate: .card-progress-container
    //    must NOT carry a permanent will-change promotion (9 extraneous layers
    //    at rest on HomePage, guarding only a one-shot 0.4s fade-in).
    const progressMatch = css.match(/\.card-progress-container \{([\s\S]*?)\n\}/);
    assert.ok(progressMatch, '.card-progress-container rule must exist in components.css');
    const hasPromotion = /will-change\s*:/.test(progressMatch[1]);
    assert.strictEqual(
        hasPromotion,
        false,
        '.card-progress-container must not carry a permanent will-change promotion'
    );
});
