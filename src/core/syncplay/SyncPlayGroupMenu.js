/**
 * ============================================================================
 * SyncPlayGroupMenu — Group management overlay
 * ============================================================================
 *
 * A modal overlay that lets users:
 *   - View available SyncPlay groups on the server
 *   - Join an existing group
 *   - Create a new group
 *   - Leave the current group
 *
 * Designed to match litefin's glass-card TV UI language.
 * Uses Apple HIG principles: clear hierarchy, large touch/focus targets,
 * clean state transitions, and spring-like CSS animations.
 *
 * Typical usage (e.g. from OSDController):
 *   import { SyncPlayGroupMenu } from '../../core/syncplay/SyncPlayGroupMenu.js';
 *   const menu = new SyncPlayGroupMenu();
 *   menu.open();
 * ============================================================================
 */

import { api } from '../../api/index.js';
import { eventBus } from '../EventBus.js';
import { logger } from '../../utils/Logger.js';
import { focusManager } from '../../ui/FocusManager.js';
import { ICONS } from '../../player/osd/icons.js';

// Note: no longer imports BaseMenu — SyncPlayGroupMenu is now a fully
// standalone overlay that can be opened from any context (sidebar, OSD, etc.)

function getSyncPlayManager() {
    return window.__syncPlayManager;
}

const log = logger.create('SyncPlayGroupMenu');

// ============================================================================
// CSS (injected into <head> once on first use)
// ============================================================================

const CSS = `
.syncplay-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.4);
    backdrop-filter: blur(25px);
    -webkit-backdrop-filter: blur(25px);
    opacity: 0;
    transition: opacity 0.4s cubic-bezier(0.25, 0.1, 0.25, 1);
}
.syncplay-overlay.visible {
    opacity: 1;
}
.syncplay-panel {
    background: var(--jf-background-alt, rgba(40, 40, 40, 0.75));
    background-image: linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 100%);
    border: 1px solid var(--jf-action-btn-border, rgba(255, 255, 255, 0.15));
    border-radius: var(--jf-border-radius-lg, 28px);
    padding: 40px;
    min-width: 520px;
    max-width: 720px;
    width: 90%;
    color: var(--jf-text-primary, #fff);
    box-shadow: 0 40px 100px rgba(0,0,0,0.6);
    transform: scale(0.9) translateY(20px);
    transition: transform 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275),
                opacity 0.4s ease;
    opacity: 0;
}
.syncplay-overlay.visible .syncplay-panel {
    transform: scale(1) translateY(0);
    opacity: 1;
}
.syncplay-header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 32px;
}
.syncplay-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
}
.syncplay-title {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.5px;
    color: var(--jf-text-primary, #fff);
}
.syncplay-subtitle {
    font-size: 14px;
    color: var(--jf-text-secondary, rgba(255,255,255,0.6));
    margin-top: 4px;
}
.syncplay-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(50, 215, 75, 0.12);
    border: 1px solid rgba(50, 215, 75, 0.2);
    border-radius: 20px;
    padding: 6px 14px;
    font-size: 14px;
    font-weight: 500;
    color: #32D74B;
    margin-bottom: 24px;
}
.syncplay-status-badge.inactive {
    background: var(--jf-action-btn-bg, rgba(255,255,255,0.06));
    border-color: var(--jf-action-btn-border, rgba(255,255,255,0.1));
    color: var(--jf-text-secondary, rgba(255,255,255,0.5));
}
.syncplay-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
}
.syncplay-status-dot.pulse {
    box-shadow: 0 0 8px currentColor;
    animation: syncplay-pulse 2s ease-in-out infinite;
}
@keyframes syncplay-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.5; transform: scale(1.1); }
}
.syncplay-group-list {
    list-style: none;
    margin: 0 -10px 28px; /* Negative margin to let scrollbar stay at edge */
    padding: 10px; /* Padding for items to scale into without clipping */
    max-height: 320px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.syncplay-group-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 24px;
    background: var(--jf-action-btn-bg, rgba(255,255,255,0.06));
    border: 1px solid var(--jf-action-btn-border, rgba(255,255,255,0.12));
    border-radius: var(--jf-border-radius-lg, 24px);
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    outline: none;
    box-sizing: border-box;
}
.syncplay-group-item:focus,
.syncplay-group-item.focused {
    background: var(--jf-accent, #007AFF);
    border-color: var(--jf-button-border-focus, #fff);
    transform: scale(1.03);
    box-shadow: 0 12px 32px rgba(0,0,0,0.5);
}
.syncplay-group-item:focus .syncplay-group-name,
.syncplay-group-item.focused .syncplay-group-name {
    color: var(--jf-primary-btn-color, #fff);
}
.syncplay-group-item:focus .syncplay-group-members,
.syncplay-group-item.focused .syncplay-group-members {
    color: var(--jf-primary-btn-color, #fff);
    opacity: 0.8;
}
.syncplay-group-item:focus .syncplay-group-join-btn,
.syncplay-group-item.focused .syncplay-group-join-btn {
    color: var(--jf-primary-btn-color, #fff);
}
.syncplay-group-name {
    font-size: 16px;
    font-weight: 600;
    color: var(--jf-text-primary, #fff);
}
.syncplay-group-members {
    font-size: 13px;
    color: var(--jf-text-secondary, rgba(255,255,255,0.5));
    margin-top: 2px;
}
.syncplay-group-join-btn {
    font-size: 14px;
    color: var(--jf-accent, #0A84FF);
    font-weight: 700;
}
.syncplay-empty {
    text-align: center;
    padding: 40px;
    color: var(--jf-text-secondary, rgba(255,255,255,0.4));
    font-size: 15px;
    background: var(--jf-action-btn-bg, rgba(255,255,255,0.02));
    border-radius: var(--jf-border-radius, 16px);
    margin-bottom: 28px;
}
.syncplay-actions {
    display: flex;
    gap: 12px;
}
.syncplay-btn {
    flex: 1;
    padding: 16px;
    border-radius: var(--jf-border-radius, 16px);
    border: none;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    outline: none;
    display: flex;
    align-items: center;
    justify-content: center;
}
.syncplay-btn-primary {
    background: var(--jf-primary-btn-color, #fff);
    color: var(--jf-accent, #007AFF);
}
.syncplay-btn-secondary {
    background: var(--jf-action-btn-bg, rgba(255,255,255,0.1));
    color: var(--jf-text-primary, #fff);
}
.syncplay-btn-danger {
    background: rgba(255, 69, 58, 0.15);
    border: 1px solid rgba(255, 69, 58, 0.3);
    color: #FF453A;
}
.syncplay-btn:focus,
.syncplay-btn.focused {
    background: var(--jf-action-btn-active-bg, #fff);
    color: var(--jf-action-btn-active-color, #000);
    transform: scale(1.05);
    box-shadow: 0 10px 30px rgba(0,0,0,0.4);
}
.syncplay-btn-danger:focus,
.syncplay-btn-danger.focused {
    background: #FF453A;
    border-color: #FF453A;
    color: #fff;
}
.syncplay-loading {
    text-align: center;
    padding: 48px;
    color: var(--jf-text-secondary, rgba(255,255,255,0.5));
    font-size: 15px;
}
`;

let cssInjected = false;

function _injectCSS() {
    if (cssInjected) return;
    cssInjected = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
}

// ============================================================================
// SyncPlayGroupMenu Class
// ============================================================================

export class SyncPlayGroupMenu {
    /**
     * @param {object} [osdController] - Optional OSD controller reference.
     *   When provided (opening from within the player), the menu registers
     *   itself as the OSD's active menu so key events route correctly.
     *   When omitted (opening from Sidebar), the menu handles keys directly
     *   via its global keydown listener.
     */
    constructor(osdController = null) {
        /** Optional reference to the OSD controller (player context). */
        this.osd = osdController;

        /** @type {HTMLElement|null} */
        this._overlay = null;

        /** Whether the menu is currently open. @type {boolean} */
        this.isVisible = false;

        /** Bound keydown handler so we can remove it on close. */
        this._onKeyDown = null;

        /** Handler reference for keyboard/remote navigation. */
        this._onSyncPlayEnabled  = null;
        this._onSyncPlayDisabled = null;

        /**
         * Marks this as a modal overlay so OSDController's _handleBack() treats
         * it as a full-screen takeover and doesn't pass through to the player.
         * Previously inherited from BaseMenu; now set explicitly.
         */
        this.isModal = true;
    }

    // ========================================================================
    // Public
    // ========================================================================

    /**
     * Open the SyncPlay group menu.
     * Fetches the current group list, renders the panel, and animates it in.
     */
    async open() {
        if (this.isVisible) return;
        this.isVisible = true;

        _injectCSS();
        this._buildDOM();
        document.body.appendChild(this._overlay);

        // Animate in
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._overlay.classList.add('visible');
            });
        });

        // Set up Focus Trap for TV remote navigation inside the panel
        focusManager.pushTrap(this._overlay.querySelector('.syncplay-panel'));

        // Register as the active menu in OSD (player context) or install
        // a global keydown listener (sidebar / non-player context)
        if (this.osd) {
            this.osd.activeMenu = this;
            this.osd._cacheFocusableElements();
        } else {
            // No OSD — handle keyboard navigation ourselves so TV remote
            // arrow keys and Back still work from the sidebar
            this._onKeyDown = (e) => {
                const key = e.key.toLowerCase();
                if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
                    e.preventDefault();
                    focusManager._handleKey(key.replace('arrow', ''));
                } else if (key === 'enter' || key === ' ') {
                    const active = document.activeElement;
                    if (active && this._overlay?.contains(active)) active.click();
                } else if (key === 'escape' || key === 'backspace' || key === 'goback') {
                    e.preventDefault();
                    this.close();
                }
            };
            document.addEventListener('keydown', this._onKeyDown);
        }

        // Live-update status badge when group membership changes
        this._onSyncPlayEnabled  = () => this._refreshStatus();
        this._onSyncPlayDisabled = () => this._refreshStatus();
        eventBus.on('syncplay:enabled',  this._onSyncPlayEnabled);
        eventBus.on('syncplay:disabled', this._onSyncPlayDisabled);

        // Initialize status (badge and buttons)
        this._refreshStatus();

        // Load group list
        await this._loadGroups();
    }

    /**
     * Close and destroy the menu.
     */
    close() {
        if (!this.isVisible) return;
        this.isVisible = false;

        // Release focus trap
        focusManager.popTrap();

        // De-register from whichever context we were registered with
        if (this.osd && this.osd.activeMenu === this) {
            this.osd.activeMenu = null;
            this.osd._cacheFocusableElements();
        }
        if (this._onKeyDown) {
            document.removeEventListener('keydown', this._onKeyDown);
            this._onKeyDown = null;
        }

        eventBus.off('syncplay:enabled',  this._onSyncPlayEnabled);
        eventBus.off('syncplay:disabled', this._onSyncPlayDisabled);

        // Animate out, then detach from DOM
        this._overlay.classList.remove('visible');
        setTimeout(() => {
            if (this._overlay && this._overlay.parentNode) {
                this._overlay.parentNode.removeChild(this._overlay);
            }
            this._overlay = null;
        }, 400);
    }

    // ========================================================================
    // Private — DOM Building
    // ========================================================================

    /**
     * Build the overlay DOM structure.
     * @private
     */
    _buildDOM() {
        this._overlay = document.createElement('div');
        this._overlay.className = 'syncplay-overlay';
        // To prevent ReferenceError in _renderStatusBadge, ensure CSS is requested
        let initialBadge = `
            <div class="syncplay-status-badge inactive">
                <div class="syncplay-status-dot"></div>
                Loading...
            </div>
        `;
        if (getSyncPlayManager()) {
            initialBadge = this._renderStatusBadge();
        }

        this._overlay.innerHTML = `
            <div class="syncplay-panel">
                <div class="syncplay-header">
                    <!-- SyncPlay icon (groups) -->
                    <div class="syncplay-icon">
                        ${(getSyncPlayManager()?.isEnabled) ? ICONS.groupFilled : ICONS.group}
                    </div>
                    <div>
                        <div class="syncplay-title">SyncPlay</div>
                        <div class="syncplay-subtitle">Watch together, in perfect sync</div>
                    </div>
                </div>

                ${initialBadge}

                <div id="syncplay-group-container">
                    <div class="syncplay-loading">Loading groups…</div>
                </div>

                <div class="syncplay-actions" id="syncplay-actions-container">
                    <!-- Buttons are populated dynamically by _refreshStatus -->
                    <button class="syncplay-btn syncplay-btn-secondary focusable" id="syncplay-close-btn">Close</button>
                </div>
            </div>
        `;

        // Wire static close button
        const closeBtn = this._overlay.querySelector('#syncplay-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', () => this.close());

        // Close on backdrop click
        this._overlay.addEventListener('click', (e) => {
            if (e.target === this._overlay) this.close();
        });
    }

    /**
     * Render the current SyncPlay status badge HTML.
     * @private
     */
    _renderStatusBadge() {
        const manager = getSyncPlayManager();
        if (!manager) {
            return `
                <div class="syncplay-status-badge inactive">
                    <div class="syncplay-status-dot"></div>
                    Loading...
                </div>
            `;
        }

        const isActive = manager.isEnabled;
        const info = manager.groupInfo;
        const groupName = manager.groupName || info?.Data?.GroupName || info?.GroupName || info?.GroupId || 'Not in a group';

        return `
            <div class="syncplay-status-badge ${isActive ? '' : 'inactive'}">
                <div class="syncplay-status-dot ${isActive ? 'pulse' : ''}"></div>
                ${isActive ? `In group — ${groupName}` : 'Not in a group'}
            </div>
        `;
    }

    _refreshStatus() {
        if (!this._overlay) return;

        const manager = getSyncPlayManager();
        if (!manager) return;

        // Replace the badge in-place
        const badge = this._overlay.querySelector('.syncplay-status-badge');
        if (badge) {
            badge.outerHTML = this._renderStatusBadge();
        }

        // Update the header icon
        const iconContainer = this._overlay.querySelector('.syncplay-icon');
        if (iconContainer) {
            iconContainer.innerHTML = manager.isEnabled ? ICONS.groupFilled : ICONS.group;
        }

        // Swap the action button (leave ↔ create)
        const actions = this._overlay.querySelector('.syncplay-actions');
        if (actions) {
            const oldBtn = actions.querySelector('#syncplay-create-btn, #syncplay-leave-btn');
            const wasFocused = oldBtn === document.activeElement || oldBtn?.classList.contains('focused');
            
            if (manager.isEnabled) {
                const html = `<button class="syncplay-btn syncplay-btn-danger focusable" id="syncplay-leave-btn">Leave Group</button>`;
                if (oldBtn) oldBtn.outerHTML = html;
                else actions.insertAdjacentHTML('afterbegin', html);
                
                const leaveBtn = actions.querySelector('#syncplay-leave-btn');
                if (leaveBtn) {
                    leaveBtn.addEventListener('click', () => this._leaveGroup());
                    if (wasFocused) focusManager.focusElement(leaveBtn);
                }
            } else {
                const html = `<button class="syncplay-btn syncplay-btn-primary focusable" id="syncplay-create-btn">Create Group</button>`;
                if (oldBtn) oldBtn.outerHTML = html;
                else actions.insertAdjacentHTML('afterbegin', html);
                
                const createBtn = actions.querySelector('#syncplay-create-btn');
                if (createBtn) {
                    createBtn.addEventListener('click', () => this._createGroup());
                    if (wasFocused) focusManager.focusElement(createBtn);
                }
            }
        }
        
        // Ensure FocusManager knows the DOM changed
        focusManager.invalidateCache('__trap__');
    }

    // ========================================================================
    // Private — Group List
    // ========================================================================

    /**
     * Fetch the available SyncPlay groups and render them.
     * @private
     */
    async _loadGroups() {
        const container = this._overlay?.querySelector('#syncplay-group-container');
        if (!container) return;

        try {
            const groups = await api.syncPlayList();
            this._renderGroupList(container, groups || []);
        } catch (err) {
            log.warn('Failed to load groups:', err);
            container.innerHTML = `<div class="syncplay-empty">Could not load groups. Check your connection.</div>`;
        }
    }

    /**
     * Render the group list inside the container element.
     * @private
     * @param {HTMLElement} container
     * @param {Array} groups
     */
    _renderGroupList(container, groups) {
        const manager = getSyncPlayManager();

        // -----------------------------------------------------------------
        // If the user is already in a group, hide the group list entirely.
        // There is no point showing other groups when you are already in one,
        // and you must leave your current group to join another.
        // -----------------------------------------------------------------
        if (manager?.isEnabled) {
            container.innerHTML = `<div class="syncplay-empty">You are currently in a SyncPlay group.<br>Leave your group to join another.</div>`;
            return;
        }

        if (groups.length === 0) {
            container.innerHTML = `<div class="syncplay-empty">No groups found — create one to get started.</div>`;
            return;
        }

        const ul = document.createElement('ul');
        ul.className = 'syncplay-group-list';

        groups.forEach((group) => {
            const li = document.createElement('li');
            li.className = 'syncplay-group-item focusable';
            li.tabIndex = 0;
            li.dataset.groupId = group.GroupId;

            // Member count
            const memberCount = group.Participants?.length ?? 0;
            const memberLabel = memberCount === 1 ? '1 member' : `${memberCount} members`;

            li.innerHTML = `
                <div>
                    <div class="syncplay-group-name">${group.GroupName || group.GroupId}</div>
                    <div class="syncplay-group-members">${memberLabel}</div>
                </div>
                <div class="syncplay-group-join-btn">Join →</div>
            `;

            li.addEventListener('click', () => this._joinGroup(group.GroupId));
            li.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this._joinGroup(group.GroupId);
                }
            });

            ul.appendChild(li);
        });

        container.innerHTML = '';
        container.appendChild(ul);
        
        // Focus the first group or the Close button if no groups
        requestAnimationFrame(() => {
            const firstGroup = ul.querySelector('.syncplay-group-item');
            if (firstGroup) {
                focusManager.focusElement(firstGroup);
            } else {
                const closeBtn = this._overlay.querySelector('#syncplay-close-btn');
                if (closeBtn) focusManager.focusElement(closeBtn);
            }
        });
        
        focusManager.invalidateCache('__trap__');
    }

    // ========================================================================
    // Private — Group Actions
    // ========================================================================

    /** @private */
    async _createGroup() {
        try {
            const manager = getSyncPlayManager();
            if (manager) await manager.createGroup();
            // The server will emit a GroupUpdate via WebSocket → plugin handles it
            this.close();
        } catch (err) {
            log.error('Create group failed:', err);
        }
    }

    /** @private */
    async _joinGroup(groupId) {
        try {
            const manager = getSyncPlayManager();
            if (manager) await manager.joinGroup(groupId);
            this.close();
        } catch (err) {
            log.error('Join group failed:', err);
        }
    }

    /** @private */
    async _leaveGroup() {
        try {
            const manager = getSyncPlayManager();
            if (manager) await manager.leaveGroup();
            this.close();
        } catch (err) {
            log.error('Leave group failed:', err);
        }
    }

    // ========================================================================
    // OSD BaseMenu Compatibility — called by OSDController when this is the activeMenu
    // ========================================================================

    /**
     * Called by OSDController to route key events through us when we are
     * the active menu inside the player. Arrows are forwarded to FocusManager
     * so TV remote navigation works inside the panel.
     * @param {string} key - Normalised key name ('up' | 'down' | ... | 'back' | 'enter')
     * @returns {boolean} true if the key was handled and OSD should stop processing it
     */
    handleKey(key) {
        // Route directional keys back to FocusManager so the focus trap works
        if (['up', 'down', 'left', 'right'].includes(key)) {
            focusManager._handleKey(key);
            return true;
        } else if (key === 'enter') {
            const activeEl = document.activeElement;
            if (activeEl && this._overlay?.contains(activeEl)) {
                activeEl.click();
            }
            return true;
        } else if (key === 'back') {
            this.close();
            return true;
        }

        return false;
    }
}

// ============================================================================
// Global singleton — importable anywhere without constructing a new instance
// ============================================================================

/**
 * A shared SyncPlayGroupMenu instance.
 * Open it from the Sidebar with `syncPlayGroupMenu.open()`.
 * Open it from the OSD with `syncPlayGroupMenu.osd = osdController; syncPlayGroupMenu.open()`.
 */
export const syncPlayGroupMenu = new SyncPlayGroupMenu();
