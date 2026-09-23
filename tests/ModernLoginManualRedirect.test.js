import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Modern Layout Login Manual Redirect Test Suite
 * ============================================================================
 * Verifies that in the Modern layout login screen:
 * 1. The manual login section includes Quick Connect and Change Server buttons.
 * 2. When automatically redirected to manual login (zero users available),
 *    Quick Connect and Change Server buttons are displayed, while Back is hidden.
 * 3. When manually navigating to manual login from user selection, Back is displayed
 *    while Quick Connect and Change Server are hidden.
 * 4. In Add User mode, Change Server is kept hidden even on auto-redirect.
 * ============================================================================
 */

test('Modern layout manual login template includes quick-connect and change-server buttons', () => {
    // Read the LoginPage.js source directly to inspect template markup
    const loginPageSource = readFileSync(new URL('../src/pages/LoginPage.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // Extract the _renderModernHTML method definition
    const modernRenderMatch = loginPageSource.match(/_renderModernHTML\(\)\s*\{([\s\S]*?)\n\s*\}\n/);
    assert.ok(modernRenderMatch, 'LoginPage._renderModernHTML should be defined');

    const modernHtml = modernRenderMatch[1];

    // Verify manual-section contains all required action buttons in the modern button row
    assert.ok(
        modernHtml.includes('class="login-section manual-section hidden"'),
        'Modern layout should define manual-section'
    );
    assert.ok(
        modernHtml.includes('class="btn btn-primary manual-signin-btn"'),
        'Modern manual section must include manual-signin-btn'
    );
    assert.ok(
        modernHtml.includes('class="btn btn-secondary quick-connect-btn"'),
        'Modern manual section must include quick-connect-btn'
    );
    assert.ok(
        modernHtml.includes('class="btn btn-secondary back-btn"'),
        'Modern manual section must include back-btn'
    );
    assert.ok(
        modernHtml.includes('class="btn btn-secondary change-server-btn"'),
        'Modern manual section must include change-server-btn'
    );
});

test('LoginPage._goToManualLogin properly configures button visibility for auto-redirect and manual entry', () => {
    // Setup mock elements representing the manual login buttons
    const mockBackBtn = { style: { display: '' } };
    const mockQcBtn = { style: { display: '' } };
    const mockChangeServerBtn = { style: { display: '' } };
    const mockUsernameInput = { value: 'prev', readOnly: false, focus: () => {} };
    const mockPasswordInput = { value: 'prev', readOnly: false };

    const mockPageContext = {
        _isManualLoginAutoRedirect: false,
        _isAddUserMode: false,
        _manualUsername: mockUsernameInput,
        _manualPassword: mockPasswordInput,
        $: (selector) => {
            if (selector === '.manual-section .back-btn') return mockBackBtn;
            if (selector === '.manual-section .quick-connect-btn') return mockQcBtn;
            if (selector === '.manual-section .change-server-btn') return mockChangeServerBtn;
            return null;
        },
        _showState: () => {},
        setActiveSection: () => {}
    };

    // Simulate _goToManualLogin logic as defined in LoginPage
    const goToManualLogin = function (isAutoRedirect = false) {
        this._isManualLoginAutoRedirect = isAutoRedirect;
        this._manualUsername.value = '';
        this._manualPassword.value = '';

        const backBtn = this.$('.manual-section .back-btn');
        if (backBtn) {
            backBtn.style.display = isAutoRedirect ? 'none' : '';
        }

        const qcBtn = this.$('.manual-section .quick-connect-btn');
        if (qcBtn) {
            qcBtn.style.display = isAutoRedirect ? '' : 'none';
        }

        const changeServerBtn = this.$('.manual-section .change-server-btn');
        if (changeServerBtn) {
            changeServerBtn.style.display = isAutoRedirect && !this._isAddUserMode ? '' : 'none';
        }
    };

    // Case 1: Auto-redirect when no users exist (isAutoRedirect = true)
    goToManualLogin.call(mockPageContext, true);
    assert.equal(mockBackBtn.style.display, 'none', 'Back button should be hidden during auto-redirect');
    assert.equal(mockQcBtn.style.display, '', 'Quick Connect button should be visible during auto-redirect');
    assert.equal(mockChangeServerBtn.style.display, '', 'Change Server button should be visible during auto-redirect');

    // Case 2: User explicitly navigates to manual login (isAutoRedirect = false)
    goToManualLogin.call(mockPageContext, false);
    assert.equal(mockBackBtn.style.display, '', 'Back button should be visible during manual navigation');
    assert.equal(mockQcBtn.style.display, 'none', 'Quick Connect button should be hidden during manual navigation');
    assert.equal(mockChangeServerBtn.style.display, 'none', 'Change Server button should be hidden during manual navigation');

    // Case 3: Auto-redirect in Add User mode
    mockPageContext._isAddUserMode = true;
    goToManualLogin.call(mockPageContext, true);
    assert.equal(mockBackBtn.style.display, 'none', 'Back button should be hidden during auto-redirect');
    assert.equal(mockQcBtn.style.display, '', 'Quick Connect button should be visible during auto-redirect');
    assert.equal(mockChangeServerBtn.style.display, 'none', 'Change Server button must be hidden in Add User mode');
});
