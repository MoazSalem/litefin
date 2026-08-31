/**
 * ============================================================================
 * Litefin Tizen - Jellyseerr Request Modal
 * ============================================================================
 * Detail sheet for a discovery item and request creation. For a series, loads
 * the season list and lets the viewer pick which seasons to request.
 * ============================================================================
 */

import { api } from '../api/ApiClient.js';
import { seerr } from '../api/seerrClient.js';
import { SEERR_STATUS, seerrStatusKey, seerrSeasonStatusKey } from '../api/seerrNormalize.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { toast } from '../ui/Toast.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SeerrRequestModal');

const OVERLAY_ID = 'seerr-request-modal';

function escapeHtml(value) {
    if (!value) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const DEFAULT_AVATAR_SVG = `<svg class="seerr-avatar-icon" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`;

function getUserAvatarUrl(user) {
    if (!user) return '';
    if (user.jellyfinUserId) {
        return api.getUserImageUrl(user.jellyfinUserId, { maxWidth: 64 });
    }
    if (user.avatar && (user.avatar.startsWith('http://') || user.avatar.startsWith('https://') || user.avatar.startsWith('//'))) {
        return user.avatar;
    }
    return '';
}

function renderUserAvatarHtml(user) {
    const avatarUrl = getUserAvatarUrl(user);
    if (avatarUrl) {
        return `<img class="seerr-user-avatar-img" src="${escapeHtml(avatarUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"/>
                <span style="display:none;">${DEFAULT_AVATAR_SVG}</span>`;
    }
    return DEFAULT_AVATAR_SVG;
}

class SeerrRequestModal {
    /**
     * @param {Object} item - Normalized item (see seerrNormalize)
     * @param {Function} [onRequested] - Called with the new status on success
     */
    static async show(item, onRequested) {
        const existing = document.getElementById(OVERLAY_ID);
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        const isTv = item._mediaType === 'tv';
        const isAvailable = item._seerrStatus === SEERR_STATUS.AVAILABLE;
        const statusKey = seerrStatusKey(item._seerrStatus);

        const isPartialOrPending =
            isTv &&
            (item._seerrStatus === SEERR_STATUS.PENDING ||
                item._seerrStatus === SEERR_STATUS.PROCESSING ||
                item._seerrStatus === SEERR_STATUS.PARTIALLY_AVAILABLE);
        const requestBtnLabel = i18n.t(isPartialOrPending ? 'SeerrRequestMore' : 'SeerrRequest');

        const itemTitle = `${item.Name}${item.ProductionYear ? ` (${item.ProductionYear})` : ''}`;
        const modalHeaderTitle = isTv ? `${i18n.t('SeerrRequestSeries')} - ${itemTitle}` : i18n.t('SeerrRequestMovie');

        overlay.innerHTML = `
            <div class="settings-modal seerr-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${modalHeaderTitle}</h2>
                </div>
                <div class="modal-options seerr-modal-body">
                    ${!isTv ? `<h3 class="seerr-item-title">${itemTitle}</h3>` : ''}
                    ${statusKey ? `<p class="seerr-modal-status">${i18n.t(statusKey)}</p>` : ''}
                    <div class="seerr-seasons" id="seerr-seasons"></div>
                    <div class="seerr-request-options" id="seerr-request-options"></div>
                </div>
                <div class="modal-actions">
                    ${isAvailable
                ? ''
                : `<button class="modal-action-btn" id="btn-seerr-request" tabindex="0">${requestBtnLabel}</button>`
            }
                    <button class="modal-action-btn" id="btn-seerr-close" tabindex="0">${i18n.t('ButtonBack')}</button>
                </div>
            </div>
        `;

        const panel = overlay.querySelector('.seerr-modal');
        // pushTrap locks focus inside the modal and remembers the previous
        // section and element; popTrap restores them.
        focusManager.pushTrap(panel);

        // The remote's hardware Back button is a separate event path from D-pad
        // navigation (FocusManager's trap only blocks Up/Down/Left/Right). Without
        // hijacking the current page's onBack, Back would fall through to page/router
        // navigation while this trap stays registered, stranding focus — the same
        // failure mode MediaInfoModal and DescriptionModal guard against.
        const currentPage = router.getCurrentPage();
        const oldOnBack = currentPage ? currentPage.onBack : null;

        const close = () => {
            if (currentPage && currentPage.onBack === myOnBack) currentPage.onBack = oldOnBack;
            focusManager.popTrap();
            overlay.remove();
        };

        const myOnBack = () => {
            close();
            return true;
        };
        if (currentPage) currentPage.onBack = myOnBack;

        overlay.querySelector('#btn-seerr-close').addEventListener('click', close);

        const requestBtn = overlay.querySelector('#btn-seerr-request');

        // Series: load the seasons
        let selectedSeasons = [];
        if (isTv && !isAvailable) {
            selectedSeasons = await SeerrRequestModal._renderSeasons(overlay, item, requestBtn);
        }

        const requestOptions = await SeerrRequestModal._renderRequestOptions(overlay, item);

        if (requestBtn) {
            requestBtn.addEventListener('click', async () => {
                if (isTv && selectedSeasons.length === 0) {
                    const errorEl = overlay.querySelector('#seerr-season-error');
                    if (errorEl) {
                        errorEl.classList.remove('hidden');
                        errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                    return;
                }
                requestBtn.disabled = true;
                try {
                    const res = await seerr.createRequest({
                        mediaType: item._mediaType,
                        tmdbId: item._tmdbId,
                        seasons: isTv ? selectedSeasons.slice() : undefined,
                        ...requestOptions()
                    });
                    toast.show(i18n.t('SeerrRequestSent'));
                    if (onRequested) onRequested(SEERR_STATUS.PENDING, res?.id);
                    close();
                } catch (err) {
                    requestBtn.disabled = false;
                    // 409 means Jellyseerr already knows about this request —
                    // not an error from the viewer's point of view.
                    if (err.status === 409) {
                        toast.show(i18n.t('SeerrAlreadyRequested'));
                        if (onRequested) onRequested(SEERR_STATUS.PENDING);
                        close();
                        return;
                    }
                    log.warn('Request failed', err);
                    toast.show(i18n.t('SeerrRequestFailed'));
                }
            });
        }
    }

    static async _renderRequestOptions(overlay, item) {
        const container = overlay.querySelector('#seerr-request-options');
        let options;
        let users = [];
        try {
            [options, users] = await Promise.all([
                seerr.requestOptions(item._mediaType),
                seerr.getUsers()
            ]);
        } catch (err) {
            log.warn('Could not load advanced request options or users', err);
            return () => ({});
        }

        const hasAdvancedOptions = options && options.servers && options.servers.length > 0;
        const hasUsers = Array.isArray(users) && users.length > 0;

        if (!hasAdvancedOptions && !hasUsers) return () => ({});

        let selectedUser = null;
        if (hasUsers) {
            selectedUser =
                users.find((u) => u.id === options?.user?.id) ||
                users[0];
        }

        let selectedServer = hasAdvancedOptions
            ? options.servers.find((server) => server.isDefault && !server.is4k) || options.servers[0]
            : null;
        let selectedProfile = null;
        let selectedRootFolder = null;

        let html = '';

        if (hasUsers) {
            html += `
                <div class="seerr-request-as-group">
                    <label class="seerr-option-label" data-i18n="SeerrRequestAs">${i18n.t('SeerrRequestAs')}</label>
                    <button class="modal-option-btn seerr-user-select-btn" id="seerr-user-select" tabindex="0">
                        <div class="seerr-user-preview">
                            <div class="seerr-user-avatar-wrap">
                                ${renderUserAvatarHtml(selectedUser)}
                            </div>
                            <div class="seerr-user-title">
                                <span class="seerr-user-name">${escapeHtml(selectedUser.displayName || selectedUser.jellyfinUsername || selectedUser.username || selectedUser.email)}</span>
                                ${selectedUser.email ? `<span class="seerr-user-email">(${escapeHtml(selectedUser.email)})</span>` : ''}
                            </div>
                        </div>
                        <span class="seerr-chevron-icon">⌵</span>
                    </button>
                </div>
            `;
        }

        if (hasAdvancedOptions) {
            html += `
                <button class="modal-option-btn seerr-option-select" id="seerr-server" tabindex="0">
                    <span>${i18n.t('SeerrServer')}</span><span class="seerr-option-value"></span>
                </button>
                <button class="modal-option-btn seerr-option-select" id="seerr-profile" tabindex="0">
                    <span>${i18n.t('SeerrQualityProfile')}</span><span class="seerr-option-value"></span>
                </button>
                <button class="modal-option-btn seerr-option-select" id="seerr-root-folder" tabindex="0">
                    <span>${i18n.t('SeerrRootFolder')}</span><span class="seerr-option-value"></span>
                </button>
            `;
        }

        container.innerHTML = html;

        const userButton = container.querySelector('#seerr-user-select');
        const serverButton = container.querySelector('#seerr-server');
        const profileButton = container.querySelector('#seerr-profile');
        const rootButton = container.querySelector('#seerr-root-folder');

        if (userButton) {
            userButton.addEventListener('click', async () => {
                const choice = await SeerrRequestModal._chooseUser(
                    i18n.t('SeerrRequestAs'),
                    users,
                    selectedUser
                );
                if (choice) {
                    selectedUser = choice;
                    const previewEl = userButton.querySelector('.seerr-user-preview');
                    if (previewEl) {
                        const disp = selectedUser.displayName || selectedUser.jellyfinUsername || selectedUser.username || selectedUser.email;
                        const sub = selectedUser.email;
                        previewEl.innerHTML = `
                            <div class="seerr-user-avatar-wrap">
                                ${renderUserAvatarHtml(selectedUser)}
                            </div>
                            <div class="seerr-user-title">
                                <span class="seerr-user-name">${escapeHtml(disp)}</span>
                                ${sub ? `<span class="seerr-user-email">(${escapeHtml(sub)})</span>` : ''}
                            </div>
                        `;
                    }
                }
            });
        }

        if (hasAdvancedOptions) {
            const sync = () => {
                const detail = options.details.find((entry) => entry.server.id === selectedServer.id);
                selectedProfile =
                    detail?.profiles?.find((profile) => profile.id === detail.server.activeProfileId) ||
                    detail?.profiles?.[0] ||
                    null;
                selectedRootFolder =
                    detail?.rootFolders?.find((folder) => folder.path === detail.server.activeDirectory) ||
                    detail?.rootFolders?.[0] ||
                    null;
                serverButton.querySelector('.seerr-option-value').textContent =
                    `${selectedServer.name}${selectedServer.is4k ? ' (4K)' : ''}`;
                profileButton.querySelector('.seerr-option-value').textContent = selectedProfile?.name || '-';
                rootButton.querySelector('.seerr-option-value').textContent = selectedRootFolder?.path || '-';
                profileButton.disabled = !selectedProfile;
                rootButton.disabled = !selectedRootFolder;
            };

            serverButton.addEventListener('click', async () => {
                const choice = await SeerrRequestModal._chooseOption(
                    i18n.t('SeerrServer'),
                    options.servers.map((server) => ({
                        value: server,
                        label: `${server.name}${server.is4k ? ' (4K)' : ''}`,
                        selected: server.id === selectedServer.id
                    }))
                );
                if (choice) {
                    selectedServer = choice;
                    sync();
                }
            });
            profileButton.addEventListener('click', async () => {
                const detail = options.details.find((entry) => entry.server.id === selectedServer.id);
                const choice = await SeerrRequestModal._chooseOption(
                    i18n.t('SeerrQualityProfile'),
                    (detail?.profiles || []).map((profile) => ({
                        value: profile,
                        label: profile.name,
                        selected: profile.id === selectedProfile?.id
                    }))
                );
                if (choice) {
                    selectedProfile = choice;
                    profileButton.querySelector('.seerr-option-value').textContent = choice.name;
                }
            });
            rootButton.addEventListener('click', async () => {
                const detail = options.details.find((entry) => entry.server.id === selectedServer.id);
                const choice = await SeerrRequestModal._chooseOption(
                    i18n.t('SeerrRootFolder'),
                    (detail?.rootFolders || []).map((folder) => ({
                        value: folder,
                        label: folder.path,
                        selected: folder.path === selectedRootFolder?.path
                    }))
                );
                if (choice) {
                    selectedRootFolder = choice;
                    rootButton.querySelector('.seerr-option-value').textContent = choice.path;
                }
            });
            sync();
        }

        focusManager.invalidateCache('__trap__');

        return () => {
            if (!hasAdvancedOptions) {
                return {
                    userId: selectedUser ? selectedUser.id : undefined
                };
            }
            const detail = options.details.find((entry) => entry.server.id === selectedServer.id);
            return {
                serverId: selectedServer.id,
                profileId: selectedProfile?.id,
                rootFolder: selectedRootFolder?.path,
                languageProfileId: detail?.server.activeLanguageProfileId,
                is4k: !!detail?.server.is4k,
                userId: selectedUser ? selectedUser.id : undefined
            };
        };
    }

    static _chooseUser(title, users, selectedUser) {
        return new Promise((resolve) => {
            const opener = document.activeElement;
            const subOverlay = document.createElement('div');
            subOverlay.className = 'modal-overlay visible';
            subOverlay.innerHTML = `
                <div class="settings-modal seerr-option-modal" role="dialog" aria-modal="true">
                    <div class="modal-header"><h2>${escapeHtml(title)}</h2></div>
                    <div class="modal-options">
                        ${users
                    .map((user, index) => {
                        const isSelected = selectedUser && selectedUser.id === user.id;
                        const displayName = user.displayName || user.jellyfinUsername || user.username || user.email || 'User';
                        const subText = user.email || (user.username && user.username !== displayName ? user.username : '');
                        return `
                            <button class="modal-option-btn seerr-user-choice-btn ${isSelected ? 'selected' : ''}"
                                    data-index="${index}" tabindex="0">
                                <span class="seerr-user-check">${isSelected ? '✓' : ''}</span>
                                <div class="seerr-user-avatar-wrap">
                                    ${renderUserAvatarHtml(user)}
                                </div>
                                <div class="seerr-user-info">
                                    <span class="seerr-user-name">${escapeHtml(displayName)}</span>
                                    ${subText ? `<span class="seerr-user-sub">(${escapeHtml(subText)})</span>` : ''}
                                </div>
                            </button>`;
                    })
                    .join('')}
                    </div>
                </div>`;
            document.body.appendChild(subOverlay);

            const currentPage = router.getCurrentPage();
            const oldOnBack = currentPage ? currentPage.onBack : null;
            const close = (value) => {
                if (currentPage && currentPage.onBack === onBack) currentPage.onBack = oldOnBack;
                focusManager.popTrap();
                subOverlay.remove();
                const parentPanel = document.querySelector(`#${OVERLAY_ID} .seerr-modal`);
                if (parentPanel) {
                    focusManager.register('__trap__', parentPanel, {
                        orientation: 'grid',
                        leaveUp: null,
                        leaveDown: null,
                        leaveLeft: null,
                        leaveRight: null
                    });
                    focusManager.setActiveSection('__trap__');
                }
                if (opener && document.body.contains(opener)) {
                    focusManager.focusElement(opener);
                }
                resolve(value);
            };
            const onBack = () => {
                close(null);
                return true;
            };
            if (currentPage) currentPage.onBack = onBack;

            focusManager.pushTrap(subOverlay.querySelector('.seerr-option-modal'));
            subOverlay.querySelectorAll('.seerr-user-choice-btn').forEach((button) => {
                button.addEventListener('click', () => close(users[parseInt(button.dataset.index, 10)]));
            });
            const initial = subOverlay.querySelector('.seerr-user-choice-btn.selected, .seerr-user-choice-btn');
            if (initial) focusManager.focusElement(initial);
        });
    }

    static _chooseOption(title, choices) {
        return new Promise((resolve) => {
            const opener = document.activeElement;
            const subOverlay = document.createElement('div');
            subOverlay.className = 'modal-overlay visible';
            subOverlay.innerHTML = `
                <div class="settings-modal seerr-option-modal" role="dialog" aria-modal="true">
                    <div class="modal-header"><h2></h2></div>
                    <div class="modal-options">
                        ${choices
                    .map(
                        (choice, index) => `
                            <button class="modal-option-btn ${choice.selected ? 'selected' : ''}"
                                    data-index="${index}" tabindex="0"></button>`
                    )
                    .join('')}
                    </div>
                </div>`;
            subOverlay.querySelector('h2').textContent = title;
            subOverlay.querySelectorAll('.modal-option-btn').forEach((button) => {
                button.textContent = choices[parseInt(button.dataset.index, 10)].label;
            });
            document.body.appendChild(subOverlay);

            const currentPage = router.getCurrentPage();
            const oldOnBack = currentPage ? currentPage.onBack : null;
            const close = (value) => {
                if (currentPage && currentPage.onBack === onBack) currentPage.onBack = oldOnBack;
                focusManager.popTrap();
                subOverlay.remove();
                const parentPanel = document.querySelector(`#${OVERLAY_ID} .seerr-modal`);
                if (parentPanel) {
                    focusManager.register('__trap__', parentPanel, {
                        orientation: 'grid',
                        leaveUp: null,
                        leaveDown: null,
                        leaveLeft: null,
                        leaveRight: null
                    });
                    focusManager.setActiveSection('__trap__');
                }
                if (opener && document.body.contains(opener)) {
                    focusManager.focusElement(opener);
                }
                resolve(value);
            };
            const onBack = () => {
                close(null);
                return true;
            };
            if (currentPage) currentPage.onBack = onBack;

            focusManager.pushTrap(subOverlay.querySelector('.seerr-option-modal'));
            subOverlay.querySelectorAll('.modal-option-btn').forEach((button) => {
                button.addEventListener('click', () => close(choices[parseInt(button.dataset.index, 10)].value));
            });
            const initial = subOverlay.querySelector('.modal-option-btn.selected, .modal-option-btn');
            if (initial) focusManager.focusElement(initial);
        });
    }

    /**
     * Loads and renders the season list. Returns the live array of selected
     * season numbers.
     * @returns {Promise<Array<number>>}
     * @private
     */
    static async _renderSeasons(overlay, item, requestBtn) {
        const container = overlay.querySelector('#seerr-seasons');
        const selected = [];

        let seasons = [];
        try {
            seasons = await seerr.tvSeasons(item._tmdbId);
        } catch (err) {
            log.warn('Could not load seasons', err);
            return selected;
        }

        if (seasons.length === 0) return selected;

        // A season already available or already requested cannot be re-requested
        const isLocked = (s) => s.status > SEERR_STATUS.NOT_REQUESTED && s.status !== SEERR_STATUS.DELETED;

        if (seasons.every((s) => isLocked(s)) && requestBtn) {
            requestBtn.classList.add('hidden');
            requestBtn.tabIndex = -1;
        }

        container.innerHTML = `
            <button class="seerr-season-row" id="seerr-season-all" tabindex="0">
                ${i18n.t('SeerrAllSeasons')}
            </button>
            ${seasons
                .map(
                    (s) => {
                        const locked = isLocked(s);
                        const statusKey = seerrSeasonStatusKey(s.status);
                        const statusText = i18n.t(statusKey);
                        return `
                <button class="seerr-season-row ${locked ? 'is-locked' : ''}"
                        data-season="${s.seasonNumber}" tabindex="0" ${locked ? 'disabled' : ''}>
                    <span class="seerr-season-name">${s.name}</span>
                    <span class="seerr-season-meta">
                        <span class="seerr-season-episodes">${i18n.t('SeerrSeasonEpisodes', [s.episodeCount])}</span>
                        <span class="seerr-season-badge seerr-season-badge--${s.status}">${statusText}</span>
                    </span>
                </button>
            `;
                    }
                )
                .join('')}
            <div class="seerr-season-error hidden" id="seerr-season-error">
                <span>${i18n.t('SeerrMustSelectSeason')}</span>
            </div>
        `;

        const syncRequestBtn = () => {
            const errorEl = container.querySelector('#seerr-season-error');
            if (errorEl && selected.length > 0) {
                errorEl.classList.add('hidden');
            }
        };

        const toggle = (btn, seasonNumber) => {
            const idx = selected.indexOf(seasonNumber);
            if (idx === -1) {
                selected.push(seasonNumber);
                btn.classList.add('is-selected');
            } else {
                selected.splice(idx, 1);
                btn.classList.remove('is-selected');
            }
            syncRequestBtn();
        };

        container.querySelectorAll('.seerr-season-row[data-season]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                toggle(btn, parseInt(btn.dataset.season, 10));
            });
        });

        const allBtn = container.querySelector('#seerr-season-all');
        allBtn.addEventListener('click', () => {
            const selectable = Array.prototype.slice
                .call(container.querySelectorAll('.seerr-season-row[data-season]'))
                .filter((b) => !b.disabled);
            const selectAll = selected.length !== selectable.length;

            selected.length = 0;
            selectable.forEach((b) => {
                b.classList.toggle('is-selected', selectAll);
                if (selectAll) selected.push(parseInt(b.dataset.season, 10));
            });
            syncRequestBtn();
        });

        // Seasons arrive after the initial pushTrap, so the trap has to pick up
        // the newly focusable elements.
        focusManager.invalidateCache('__trap__');

        return selected;
    }
}

export default SeerrRequestModal;
