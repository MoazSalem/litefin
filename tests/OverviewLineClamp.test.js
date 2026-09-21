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

const { i18n } = await import('../src/utils/i18n.js');
i18n.dictionary = JSON.parse(readFileSync('src/locales/en-us.json', 'utf8'));

const { getOverviewClampClass, shouldAlwaysShowOverviewButton, getOverviewButtonText } = await import(
    '../src/utils/Utils.js'
);
const { storage } = await import('../src/utils/StorageService.js');

/**
 * ============================================================================
 * Unit Tests: Overview & Biography Max Lines & Detailed View Button
 * ============================================================================
 * Verifies that:
 * 1. Line-clamp settings resolve CSS classes properly.
 * 2. pref:detailsAlwaysShowSeeMore toggle correctly drives button visibility
 *    and switches the label between 'Show More' (default) and 'Detailed View'.
 * 3. Stylesheet, localization files, and page implementations are wired up.
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

test('shouldAlwaysShowOverviewButton and getOverviewButtonText default off', () => {
    storageMap.clear();

    assert.equal(shouldAlwaysShowOverviewButton(), false);
    assert.equal(getOverviewButtonText(), 'Show more');
});

test('shouldAlwaysShowOverviewButton and getOverviewButtonText switch to Detailed View when enabled', () => {
    storage.setItem('pref:detailsAlwaysShowSeeMore', 'true');

    assert.equal(shouldAlwaysShowOverviewButton(), true);
    assert.equal(getOverviewButtonText(), 'Detailed View');

    // Clean up
    storage.removeItem('pref:detailsAlwaysShowSeeMore');
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

test('SettingsPage has details-overview-max-lines-select and toggle-details-always-show-see-more registered', () => {
    const settingsContent = readFileSync('src/pages/SettingsPage.js', 'utf8');

    assert.ok(
        settingsContent.includes('details-overview-max-lines-select'),
        'SettingsPage.js must include details-overview-max-lines-select dropdown'
    );
    assert.ok(
        settingsContent.includes("'details-overview-max-lines-select': { key: 'pref:detailsOverviewMaxLines', type: 'local' }"),
        'SettingsPage.js must map details-overview-max-lines-select to pref:detailsOverviewMaxLines'
    );
    assert.ok(
        settingsContent.includes('toggle-details-always-show-see-more'),
        'SettingsPage.js must include toggle-details-always-show-see-more toggle switch'
    );
    assert.ok(
        settingsContent.includes('pref:detailsAlwaysShowSeeMore'),
        'SettingsPage.js must reference pref:detailsAlwaysShowSeeMore'
    );
});

test('Details, Person, Seerr Details, and Seerr Person pages integrate getOverviewClampClass and Detailed View helpers', () => {
    const detailsPage = readFileSync('src/pages/DetailsPage.js', 'utf8');
    const personPage = readFileSync('src/pages/PersonPage.js', 'utf8');
    const seerrDetailsPage = readFileSync('src/pages/SeerrDetailsPage.js', 'utf8');
    const seerrPersonPage = readFileSync('src/pages/SeerrPersonPage.js', 'utf8');

    for (const [name, content] of Object.entries({
        DetailsPage: detailsPage,
        PersonPage: personPage,
        SeerrDetailsPage: seerrDetailsPage,
        SeerrPersonPage: seerrPersonPage
    })) {
        assert.ok(content.includes('getOverviewClampClass'), `${name} must use getOverviewClampClass`);
        assert.ok(content.includes('shouldAlwaysShowOverviewButton'), `${name} must use shouldAlwaysShowOverviewButton`);
        assert.ok(content.includes('getOverviewButtonText'), `${name} must use getOverviewButtonText`);
    }
});

test('en-us.json contains overview max lines, value lines, and Detailed View translation keys', () => {
    const enUs = JSON.parse(readFileSync('src/locales/en-us.json', 'utf8'));

    assert.equal(enUs.LabelDetailsOverviewMaxLines, 'Overview Max Lines');
    assert.ok(enUs.DetailsOverviewMaxLinesDescription);
    assert.equal(enUs.ValueLines, '{0} lines');
    assert.equal(enUs.LinesValue, '{0} lines');
    assert.equal(enUs.LabelDetailsAlwaysShowSeeMore, 'Always Show Detailed View Button');
    assert.ok(enUs.DetailsAlwaysShowSeeMoreDescription);
    assert.equal(enUs.DetailedView, 'Detailed View');
});
