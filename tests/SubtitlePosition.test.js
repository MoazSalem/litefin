import assert from 'node:assert/strict';
import test from 'node:test';
import { updateSubtitlePosition } from '../src/utils/SubtitlePosition.js';

function overlay(bottom, hidden = false) {
    const element = {
        bottom,
        style: { bottom: '2vh', top: '', transform: '', webkitTransform: '' },
        classList: { contains: () => hidden },
        querySelector: () => ({
            getBoundingClientRect: () => ({
                width: 500,
                height: 60,
                bottom: element.bottom + (parseFloat(element.style.transform.replace('translateY(', '')) || 0)
            })
        })
    };
    return element;
}

function page(overlays, tops = [850, 960]) {
    return {
        getBoundingClientRect: () => ({ height: 1000 }),
        querySelectorAll: (selector) =>
            selector === '.subtitle-overlay'
                ? overlays
                : tops.map((top) => ({ getBoundingClientRect: () => ({ top, width: 1000, height: 40 }) }))
    };
}

test('moves bottom subtitles above controls and restores their configured position', () => {
    const primary = overlay(980);
    const root = page([primary]);
    updateSubtitlePosition(root, true);
    assert.equal(primary.style.transform, 'translateY(-150px)');
    assert.equal(primary.style.webkitTransform, primary.style.transform);
    assert.equal(primary.style.bottom, '2vh');
    updateSubtitlePosition(root, true);
    assert.equal(primary.style.transform, 'translateY(-150px)', 'updates must not accumulate offsets');
    updateSubtitlePosition(root, false);
    assert.equal(primary.style.transform, '');
    assert.equal(primary.style.webkitTransform, '');
    assert.equal(primary.style.bottom, '2vh');
});

test('preserves subtitles already above controls, including top secondary subtitles', () => {
    const primary = overlay(700);
    const secondary = overlay(160);
    updateSubtitlePosition(page([primary, secondary]), true);
    assert.equal(primary.style.transform, '');
    assert.equal(secondary.style.transform, '');
});

test('uses the highest control in either layout and handles new cues and appearance changes', () => {
    const primary = overlay(980);
    const secondary = overlay(950);
    const root = page([primary, secondary], [960, 800]);
    updateSubtitlePosition(root, true);
    assert.equal(primary.style.transform, 'translateY(-200px)');
    assert.equal(secondary.style.transform, 'translateY(-170px)');
    primary.bottom = 900;
    updateSubtitlePosition(root, true);
    assert.equal(primary.style.transform, 'translateY(-120px)');
});

test('ignores hidden cues and safely handles missing controls or a destroyed page', () => {
    const primary = overlay(980, true);
    updateSubtitlePosition(page([primary]), true);
    assert.equal(primary.style.transform, '');
    const secondary = overlay(980);
    updateSubtitlePosition(page([secondary], []), true);
    assert.equal(secondary.style.transform, '');
    updateSubtitlePosition(null, true);
});
