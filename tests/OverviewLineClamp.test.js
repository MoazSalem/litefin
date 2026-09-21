import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Polyfill minimal browser DOM globals so Logger, StorageService, and Utils initialize cleanly in Node
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

const { getOverviewClampClass } = await import('../src/utils/Utils.js');
const { storage } = await import('../src/utils/StorageService.js');

/**
 * ============================================================================
 * Unit Tests: Overview & Biography Max Lines Customization
 * ============================================================================
 * Verifies that the overview line-clamp settings correctly resolve the CSS
 * utility classes across all supported limits and unconstrained mode.
 * Also asserts that the UI pages and stylesheet contain proper hooks.
 * ============================================================================
 */

test('getOverviewClampClass returns default line-clamp-6 when no preference is set', () => {
    // Clear storage state
    storageMap.clear();

    // Default should be 6 lines
    const clampClass = getOverviewClampClass();
    assert.equal(clampClass, 'line-clamp-6');
});

test('getOverviewClampClass returns proper class for configured numeric limits', () => {
    const limits = ['2', '3', '4', '5', '6', '7', '8', '10', '12'];

    for (const limit of limits) {
        storage.setItem('pref:detailsOverviewMaxLines', limit);
        assert.equal(getOverviewClampClass(), `line-clamp-${limit}`);
    }

    // Clean up
    storage.removeItem('pref:detailsOverviewMaxLines');
});

test('getOverviewClampClass returns line-clamp-none when set to none', () => {
    storage.setItem('pref:detailsOverviewMaxLines', 'none');
    assert.equal(getOverviewClampClass(), 'line-clamp-none');

    // Clean up
    storage.removeItem('pref:detailsOverviewMaxLines');
});

test('details.css defines all required line-clamp utility classes', () => {
    const cssContent = readFileSync('src/styles/details.css', 'utf8');

    const expectedClasses = [
        '.line-clamp-2',
        '.line-clamp-3',
        '.line-clamp-4',
        '.line-clamp-5',
        '.line-clamp-6',
        '.line-clamp-7',
        '.line-clamp-8',
        '.line-clamp-10',
        '.line-clamp-12',
        '.line-clamp-none'
    ];

    for (const cls of expectedClasses) {
        assert.ok(cssContent.includes(cls), `details.css must include ${cls}`);
    }
});

test('SettingsPage has details-overview-max-lines-select registered', () => {
    const settingsContent = readFileSync('src/pages/SettingsPage.js', 'utf8');

    assert.ok(
        settingsContent.includes('details-overview-max-lines-select'),
        'SettingsPage.js must include details-overview-max-lines-select dropdown'
    );
    assert.ok(
        settingsContent.includes("'details-overview-max-lines-select': { key: 'pref:detailsOverviewMaxLines', type: 'local' }"),
        'SettingsPage.js must map details-overview-max-lines-select to pref:detailsOverviewMaxLines'
    );
});

test('Details, Person, Seerr Details, and Seerr Person pages integrate getOverviewClampClass', () => {
    const detailsPage = readFileSync('src/pages/DetailsPage.js', 'utf8');
    const personPage = readFileSync('src/pages/PersonPage.js', 'utf8');
    const seerrDetailsPage = readFileSync('src/pages/SeerrDetailsPage.js', 'utf8');
    const seerrPersonPage = readFileSync('src/pages/SeerrPersonPage.js', 'utf8');

    assert.ok(detailsPage.includes('getOverviewClampClass'), 'DetailsPage.js must use getOverviewClampClass');
    assert.ok(personPage.includes('getOverviewClampClass'), 'PersonPage.js must use getOverviewClampClass');
    assert.ok(seerrDetailsPage.includes('getOverviewClampClass'), 'SeerrDetailsPage.js must use getOverviewClampClass');
    assert.ok(seerrPersonPage.includes('getOverviewClampClass'), 'SeerrPersonPage.js must use getOverviewClampClass');
});

test('en-us.json contains overview max lines and value lines translation keys', () => {
    const enUs = JSON.parse(readFileSync('src/locales/en-us.json', 'utf8'));

    assert.equal(enUs.LabelDetailsOverviewMaxLines, 'Overview Max Lines');
    assert.ok(enUs.DetailsOverviewMaxLinesDescription);
    assert.equal(enUs.ValueLines, '{0} lines');
    assert.equal(enUs.LinesValue, '{0} lines');
});
