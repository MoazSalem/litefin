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
import { syncPlayManager } from './SyncPlayManager.js';
import { eventBus } from '../EventBus.js';
import { logger } from '../../utils/Logger.js';

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
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    opacity: 0;
    transition: opacity 0.25s ease;
}
.syncplay-overlay.visible {
    opacity: 1;
}
.syncplay-panel {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 20px;
    padding: 36px;
    min-width: 480px;
    max-width: 680px;
    width: 90%;
    color: #fff;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5);
    transform: scale(0.96) translateY(8px);
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
                opacity 0.25s ease;
    opacity: 0;
}
.syncplay-overlay.visible .syncplay-panel {
    transform: scale(1) translateY(0);
    opacity: 1;
}
.syncplay-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 28px;
}
.syncplay-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    opacity: 0.9;
}
.syncplay-title {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.3px;
}
.syncplay-subtitle {
    font-size: 13px;
    color: rgba(255,255,255,0.5);
    margin-top: 2px;
}
.syncplay-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(52, 199, 89, 0.18);
    border: 1px solid rgba(52, 199, 89, 0.35);
    border-radius: 20px;
    padding: 5px 12px;
    font-size: 13px;
    color: #34C759;
    margin-bottom: 20px;
}
.syncplay-status-badge.inactive {
    background: rgba(255,255,255,0.07);
    border-color: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.5);
}
.syncplay-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
}
.syncplay-status-dot.pulse {
    animation: syncplay-pulse 1.5s ease-in-out infinite;
}
@keyframes syncplay-pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
}
.syncplay-group-list {
    list-style: none;
    margin: 0 0 20px;
    padding: 0;
    max-height: 260px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.syncplay-group-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.12s;
    outline: none;
}
.syncplay-group-item:hover,
.syncplay-group-item:focus {
    background: rgba(255,255,255,0.10);
    border-color: rgba(255,255,255,0.20);
    transform: translateX(3px);
}
.syncplay-group-item.focused {
    border-color: rgba(10, 132, 255, 0.6);
    background: rgba(10, 132, 255, 0.12);
}
.syncplay-group-name {
    font-size: 15px;
    font-weight: 500;
}
.syncplay-group-members {
    font-size: 12px;
    color: rgba(255,255,255,0.45);
    margin-top: 2px;
}
.syncplay-group-join-btn {
    font-size: 13px;
    color: #0A84FF;
    font-weight: 600;
}
.syncplay-empty {
    text-align: center;
    padding: 32px;
    color: rgba(255,255,255,0.35);
    font-size: 14px;
}
.syncplay-actions {
    display: flex;
    gap: 10px;
}
.syncplay-btn {
    flex: 1;
    padding: 14px;
    border-radius: 12px;
    border: none;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.12s, opacity 0.12s;
    outline: none;
}
.syncplay-btn:focus,
.syncplay-btn:hover {
    transform: scale(1.03);
}
.syncplay-btn-primary {
    background: #0A84FF;
    color: #fff;
}
.syncplay-btn-secondary {
    background: rgba(255,255,255,0.10);
    color: #fff;
}
.syncplay-btn-danger {
    background: rgba(255,59,48, 0.18);
    border: 1px solid rgba(255,59,48,0.35);
    color: #FF3B30;
}
.syncplay-loading {
    text-align: center;
    padding: 40px;
    color: rgba(255,255,255,0.5);
    font-size: 14px;
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
    constructor() {
        /** @type {HTMLElement|null} */
        this._overlay = null;

        /** Whether the menu is currently open. @type {boolean} */
        this._isOpen = false;

        /** Handler reference for keyboard/remote navigation. */
        this._onKeyDown = null;
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
        if (this._isOpen) return;
        this._isOpen = true;

        _injectCSS();
        this._buildDOM();
        document.body.appendChild(this._overlay);

        // Animate in (next frame so transition fires)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._overlay.classList.add('visible');
            });
        });

        // Set up event listeners
        this._onKeyDown = (e) => this._handleKeyDown(e);
        document.addEventListener('keydown', this._onKeyDown);

        // Live-update the status badge when SyncPlay state changes
        this._onSyncPlayEnabled  = () => this._refreshStatus();
        this._onSyncPlayDisabled = () => this._refreshStatus();
        eventBus.on('syncplay:enabled',  this._onSyncPlayEnabled);
        eventBus.on('syncplay:disabled', this._onSyncPlayDisabled);

        // Load group list
        await this._loadGroups();
    }

    /**
     * Close and destroy the menu.
     */
    close() {
        if (!this._isOpen) return;
        this._isOpen = false;

        document.removeEventListener('keydown', this._onKeyDown);
        eventBus.off('syncplay:enabled',  this._onSyncPlayEnabled);
        eventBus.off('syncplay:disabled', this._onSyncPlayDisabled);

        // Animate out then remove from DOM
        this._overlay.classList.remove('visible');
        setTimeout(() => {
            if (this._overlay && this._overlay.parentNode) {
                this._overlay.parentNode.removeChild(this._overlay);
            }
            this._overlay = null;
        }, 300);
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
        this._overlay.innerHTML = `
            <div class="syncplay-panel">
                <div class="syncplay-header">
                    <!-- SyncPlay icon (two overlapping circles = sync) -->
                    <svg class="syncplay-icon" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="12" cy="18" r="8" stroke="rgba(255,255,255,0.7)" stroke-width="2"/>
                        <circle cx="24" cy="18" r="8" stroke="rgba(255,255,255,0.7)" stroke-width="2"/>
                        <path d="M16 14l5 4-5 4" stroke="#0A84FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <div>
                        <div class="syncplay-title">SyncPlay</div>
                        <div class="syncplay-subtitle">Watch together, in perfect sync</div>
                    </div>
                </div>

                ${this._renderStatusBadge()}

                <div id="syncplay-group-container">
                    <div class="syncplay-loading">Loading groups…</div>
                </div>

                <div class="syncplay-actions">
                    ${syncPlayManager.isEnabled
                        ? `<button class="syncplay-btn syncplay-btn-danger focusable" id="syncplay-leave-btn">Leave Group</button>`
                        : `<button class="syncplay-btn syncplay-btn-primary focusable" id="syncplay-create-btn">Create Group</button>`
                    }
                    <button class="syncplay-btn syncplay-btn-secondary focusable" id="syncplay-close-btn">Close</button>
                </div>
            </div>
        `;

        // Wire action buttons
        const createBtn = this._overlay.querySelector('#syncplay-create-btn');
        const leaveBtn  = this._overlay.querySelector('#syncplay-leave-btn');
        const closeBtn  = this._overlay.querySelector('#syncplay-close-btn');

        if (createBtn) createBtn.addEventListener('click', () => this._createGroup());
        if (leaveBtn)  leaveBtn.addEventListener('click',  () => this._leaveGroup());
        if (closeBtn)  closeBtn.addEventListener('click',  () => this.close());

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
        const isActive = syncPlayManager.isEnabled;
        const groupName = syncPlayManager.groupInfo?.GroupId || 'Not in a group';

        return `
            <div class="syncplay-status-badge ${isActive ? '' : 'inactive'}">
                <div class="syncplay-status-dot ${isActive ? 'pulse' : ''}"></div>
                ${isActive ? `In group — ${groupName}` : 'Not in a group'}
            </div>
        `;
    }

    /**
     * Re-render the status badge after SyncPlay state changes.
     * @private
     */
    _refreshStatus() {
        if (!this._overlay) return;

        // Replace the badge in-place
        const badge = this._overlay.querySelector('.syncplay-status-badge');
        if (badge) {
            badge.outerHTML = this._renderStatusBadge();
        }

        // Swap the action button (leave ↔ create)
        const actions = this._overlay.querySelector('.syncplay-actions');
        if (actions) {
            const btn = actions.querySelector('#syncplay-create-btn, #syncplay-leave-btn');
            if (syncPlayManager.isEnabled) {
                if (btn) btn.outerHTML = `<button class="syncplay-btn syncplay-btn-danger focusable" id="syncplay-leave-btn">Leave Group</button>`;
                actions.querySelector('#syncplay-leave-btn')?.addEventListener('click', () => this._leaveGroup());
            } else {
                if (btn) btn.outerHTML = `<button class="syncplay-btn syncplay-btn-primary focusable" id="syncplay-create-btn">Create Group</button>`;
                actions.querySelector('#syncplay-create-btn')?.addEventListener('click', () => this._createGroup());
            }
        }
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
    }

    // ========================================================================
    // Private — Group Actions
    // ========================================================================

    /** @private */
    async _createGroup() {
        try {
            await syncPlayManager.createGroup();
            // The server will emit a GroupUpdate via WebSocket → plugin handles it
            this.close();
        } catch (err) {
            log.error('Create group failed:', err);
        }
    }

    /** @private */
    async _joinGroup(groupId) {
        try {
            await syncPlayManager.joinGroup(groupId);
            this.close();
        } catch (err) {
            log.error('Join group failed:', err);
        }
    }

    /** @private */
    async _leaveGroup() {
        try {
            await syncPlayManager.leaveGroup();
            this.close();
        } catch (err) {
            log.error('Leave group failed:', err);
        }
    }

    // ========================================================================
    // Private — Keyboard / Remote Navigation
    // ========================================================================

    /**
     * @private
     * @param {KeyboardEvent} e
     */
    _handleKeyDown(e) {
        if (!this._isOpen) return;

        if (e.key === 'Escape' || e.key === 'Backspace') {
            e.preventDefault();
            this.close();
        }
    }
}
