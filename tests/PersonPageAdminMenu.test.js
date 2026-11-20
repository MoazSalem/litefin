import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Unit Tests: Person Page Administrator Contextual Menu
 * ============================================================================
 * Verifies that the PersonPage component surfaces the 3-dots More Options button
 * for administrator accounts with both Update Metadata and Replace/Edit Images options,
 * and ensures the filled and outlined dynamic icon variants toggle properly.
 * ============================================================================
 */

test('PersonPage source contains administrator verification for 3-dots action button', () => {
    const personSource = readFileSync('src/pages/PersonPage.js', 'utf8');

    // Verify session retrieval and administrator policy check
    assert.ok(personSource.includes("state.get('user:data')"), 'Should retrieve active user data from StateManager');
    assert.ok(personSource.includes('this._currentUser?.Policy?.IsAdministrator'), 'Should verify Policy.IsAdministrator');

    // Verify creation and configuration of 3-dots more button
    assert.ok(personSource.includes("moreBtn.className = 'btn btn-icon more-btn focusable'"), 'Should set standard action button classes');
    assert.ok(personSource.includes("moreBtn.id = 'btn-person-more'"), 'Should set button id');
    assert.ok(personSource.includes('moreBtn.innerHTML = detailsIcons.more'), 'Should render more icon');
    assert.ok(personSource.includes("moreBtn.setAttribute('data-tooltip', i18n.t('MoreOptions')"), 'Should configure tooltip text');

    // Verify placement in favContainer before tooltip bar
    assert.ok(personSource.includes('favContainer.insertBefore(moreBtn, tooltipBar)'), 'Should insert more button before tooltip bar');
});

test('PersonPage implements _showMoreOptionsModal with Refresh Metadata and Edit Images options', () => {
    const personSource = readFileSync('src/pages/PersonPage.js', 'utf8');

    // Verify method existence
    assert.ok(personSource.includes('_showMoreOptionsModal(itemId, transitionContext = null)'), 'Should declare _showMoreOptionsModal');

    // Verify admin options list
    assert.ok(personSource.includes("id: 'refresh'"), 'Should have refresh option');
    assert.ok(personSource.includes("id: 'edit-images'"), 'Should have edit-images option');
    assert.ok(personSource.includes("i18n.t('RefreshMetadata')"), 'Should localize RefreshMetadata');
    assert.ok(personSource.includes("i18n.t('EditImages')"), 'Should localize EditImages');

    // Verify action dispatch handlers
    assert.ok(personSource.includes('this._showRefreshMetadataModal(itemId'), 'Should trigger refresh metadata modal');
    assert.ok(personSource.includes('ImageEditorModal.show(itemId, this'), 'Should invoke ImageEditorModal');
});

test('PersonPage implements _showRefreshMetadataModal and calls api.refreshItem', () => {
    const personSource = readFileSync('src/pages/PersonPage.js', 'utf8');

    // Verify method declaration
    assert.ok(personSource.includes('_showRefreshMetadataModal(itemId, transitionContext = null)'), 'Should declare _showRefreshMetadataModal');

    // Verify standard refresh scan options
    assert.ok(personSource.includes("id: 'scan'"), 'Should support Default scan');
    assert.ok(personSource.includes("id: 'missing'"), 'Should support Missing metadata scan');
    assert.ok(personSource.includes("id: 'all'"), 'Should support Full refresh');

    // Verify API call and cache purge
    assert.ok(personSource.includes('await api.refreshItem(itemId'), 'Should dispatch refreshItem to ApiClient');
    assert.ok(personSource.includes('api.clearEtagCache()'), 'Should invalidate ETag cache');
    assert.ok(personSource.includes("state.clearByPrefix('person:')"), 'Should purge person state cache');
});

test('PersonPage provides compatibility getters and _refreshItem lifecycle method', () => {
    const personSource = readFileSync('src/pages/PersonPage.js', 'utf8');

    // Verify compatibility getters for modals
    assert.ok(personSource.includes('get _item()'), 'Should provide _item getter returning _person');
    assert.ok(personSource.includes('get _itemId()'), 'Should provide _itemId getter returning _personId');

    // Verify _refreshItem re-fetches person details
    assert.ok(personSource.includes('async _refreshItem()'), 'Should implement _refreshItem');
    assert.ok(personSource.includes('await api.getPerson(this._personId)'), 'Should re-fetch person from api');
    assert.ok(personSource.includes('await this._renderPersonInfo()'), 'Should re-render person info');
    assert.ok(personSource.includes('this._setSmartBackdrop()'), 'Should re-apply smart backdrop');
});

test('PersonPage destroy cleans up modal overlays and focus sections', () => {
    const personSource = readFileSync('src/pages/PersonPage.js', 'utf8');

    // Verify modal overlay teardown
    assert.ok(personSource.includes("focusManager.unregister('person-more-menu')"), 'Should unregister person-more-menu');
    assert.ok(personSource.includes("focusManager.unregister('person-refresh-menu')"), 'Should unregister person-refresh-menu');
});

test('details.css defines outlined and filled icon variant rules for more-btn and person actions', () => {
    const detailsCss = readFileSync('src/styles/details.css', 'utf8');

    // Verify default state hides filled icon
    assert.ok(detailsCss.includes('.more-btn .icon-filled'), 'Should target .more-btn .icon-filled');
    assert.ok(detailsCss.includes('.person-actions-row .btn-icon .icon-filled'), 'Should target .person-actions-row .btn-icon .icon-filled');

    // Verify hover, focus, and active states reveal filled icon
    assert.ok(detailsCss.includes('.more-btn:focus .icon-filled'), 'Should reveal filled icon on focus');
    assert.ok(detailsCss.includes('.more-btn.focused .icon-filled'), 'Should reveal filled icon when focused class applied');
    assert.ok(detailsCss.includes('.more-btn:hover .icon-filled'), 'Should reveal filled icon on hover');
    assert.ok(detailsCss.includes('.more-btn.active .icon-filled'), 'Should reveal filled icon when active');

    // Verify outline icon is hidden on focus, hover, and active states
    assert.ok(detailsCss.includes('.more-btn:focus .icon-outline'), 'Should hide outline icon on focus');
    assert.ok(detailsCss.includes('.more-btn.focused .icon-outline'), 'Should hide outline icon when focused class applied');
    assert.ok(detailsCss.includes('.more-btn:hover .icon-outline'), 'Should hide outline icon on hover');
    assert.ok(detailsCss.includes('.more-btn.active .icon-outline'), 'Should hide outline icon when active');
});
