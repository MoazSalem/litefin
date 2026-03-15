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
import BaseMenu from '../../player/osd/BaseMenu.js';
import { ICONS } from '../../player/osd/icons.js';

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
    margin: 0 0 28px;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.syncplay-group-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    background: var(--jf-action-btn-bg, rgba(255,255,255,0.04));
    border: 1px solid var(--jf-action-btn-border, rgba(255,255,255,0.08));
    border-radius: var(--jf-border-radius, 16px);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    outline: none;
}
.syncplay-group-item:focus,
.syncplay-group-item.focused {
    background: var(--jf-action-btn-active-bg, #fff);
    border-color: var(--jf-action-btn-active-border, #fff);
    transform: scale(1.02);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
}
.syncplay-group-item:focus .syncplay-group-name,
.syncplay-group-item.focused .syncplay-group-name {
    color: var(--jf-action-btn-active-color, #000);
}
.syncplay-group-item:focus .syncplay-group-members,
.syncplay-group-item.focused .syncplay-group-members {
    color: var(--jf-text-secondary, rgba(0,0,0,0.5));
    opacity: 0.7;
}
.syncplay-group-item:focus .syncplay-group-join-btn,
.syncplay-group-item.focused .syncplay-group-join-btn {
    color: var(--jf-accent, #007AFF);
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

export class SyncPlayGroupMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        
        /** @type {HTMLElement|null} */
        this._overlay = null;

        /** Whether the menu is currently open. @type {boolean} */
        this.isVisible = false;

        /** Handler reference for keyboard/remote navigation. */
        this._onSyncPlayEnabled  = null;
        this._onSyncPlayDisabled = null;
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

        // Set up Focus Trap for TV remote
        focusManager.pushTrap(this._overlay.querySelector('.syncplay-panel'));

        // Register as the active menu in OSD to intercept keys
        if (this.osd) {
            this.osd.activeMenu = this;
            this.osd._cacheFocusableElements(); // Force OSD to recognize new trap elements if needed
        }

        // Live-update status
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

        if (this.osd && this.osd.activeMenu === this) {
            this.osd.activeMenu = null;
            this.osd._cacheFocusableElements();
        }
        eventBus.off('syncplay:enabled',  this._onSyncPlayEnabled);
        eventBus.off('syncplay:disabled', this._onSyncPlayDisabled);

        // Animate out
        this._overlay.classList.remove('visible');
        setTimeout(() => {
            if (this._overlay && this._overlay.parentNode) {
                this._overlay.parentNode.removeChild(this._overlay);
            }
            this._overlay = null;
        }, 400); // Wait for longer spring-like transition
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
                        ${ICONS.group}
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
    // OSD BaseMenu Methods
    // ========================================================================

    handleKey(key) {
        // Since OSDController intercepts all arrow keys and routes them to activeMenu,
        // we must route them back to FocusManager to navigate inside our trap.
        if (['up', 'down', 'left', 'right'].includes(key)) {
            focusManager._handleKey(key);
            return true; // We handled it, don't let OSD navigate the background
        } else if (key === 'enter') {
            const activeEl = document.activeElement;
            if (activeEl && this._overlay.contains(activeEl)) {
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
