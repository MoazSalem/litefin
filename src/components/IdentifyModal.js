/**
 * ============================================================================
 * Litefin Tizen - Identify Modal (TV Adapted)
 * ============================================================================
 * Provides remote metadata provider lookup and identification for media items.
 * Allows searching by Title, Year, and External Provider IDs (TMDB, IMDb, TVDB).
 * Tailored specifically for 10-foot TV UI and remote control D-pad navigation.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { toast } from '../ui/Toast.js';
import { logger } from '../utils/Logger.js';
import { state } from '../core/StateManager.js';
import { imageCache } from '../utils/ImageCache.js';
import CardRenderer from '../utils/CardRenderer.js';

const log = logger.create('IdentifyModal');

export class IdentifyModal {
    /**
     * Show the Identify Modal.
     * @param {string} itemId           - Target Jellyfin item ID
     * @param {Object} detailsPage      - Reference to the parent DetailsPage instance
     * @param {Object} [transitionCtx]  - Navigation context from caller modal
     */
    static async show(itemId, detailsPage, transitionCtx = null) {
        const oldOnBack = transitionCtx?.oldOnBack || detailsPage.onBack;
        const prevFocus = transitionCtx?.prevFocus || focusManager.getFocused();
        const prevSection = transitionCtx?.prevSection || focusManager.getActiveSection();

        // ── Ensure Clean DOM Overlay ──────────────────────────────────────────
        let overlay = document.getElementById('details-identify-modal');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'details-identify-modal';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        // Extract initial values from the currently loaded media item
        const item = detailsPage._item || {};
        const itemType = item.Type || 'Movie';
        const providerIds = item.ProviderIds || {};

        // Track modal state
        let replaceAllImages = true;
        let isSearching = false;

        // ── Helper: Cleanup & Close ───────────────────────────────────────────
        const _close = (restoreFocus = true) => {
            if (detailsPage.onBack === myOnBack) {
                detailsPage.onBack = oldOnBack;
            }

            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            // Unregister all focus sections owned by this modal
            focusManager.unregister('identify-form-inputs');
            focusManager.unregister('identify-form-actions');
            focusManager.unregister('identify-results-list');
            focusManager.unregister('identify-results-actions');

            if (restoreFocus) {
                // Restore previous section
                if (prevSection) {
                    focusManager.setActiveSection(prevSection, false);
                }

                // If previous focus target is still connected in DOM, restore focus to it
                if (prevFocus && document.contains(prevFocus)) {
                    focusManager.focusElement(prevFocus);
                } else {
                    // Fallback to primary action buttons on the details page
                    const fallbackEl = detailsPage.$('.more-btn') ||
                                       detailsPage.$('.resume-btn') ||
                                       detailsPage.$('.play-btn') ||
                                       detailsPage.$('#actions button');
                    if (fallbackEl) {
                        focusManager.focusElement(fallbackEl);
                    } else {
                        focusManager.setActiveSection(prevSection || 'details-actions', true);
                    }
                }
            }
        };

        const myOnBack = () => {
            // Check if we are currently on the search results screen
            const resultsView = overlay.querySelector('.identify-results-view');
            if (resultsView && resultsView.style.display !== 'none') {
                // Navigate back to the search form panel instead of closing modal
                renderSearchForm();
                return true;
            }

            if (transitionCtx?.fromMoreOptions) {
                detailsPage.onBack = oldOnBack;
                _close(false);
                // Return to More Options modal preserving the original caller focus context
                detailsPage._showMoreOptionsModal(itemId, {
                    ...transitionCtx,
                    hasModified: transitionCtx?.hasModified
                });
            } else {
                _close(true);
            }
            return true;
        };

        detailsPage.onBack = myOnBack;

        // ── Render: Search Form Panel (Step 1) ─────────────────────────────────
        const renderSearchForm = () => {
            // Unregister existing result sections if navigating back
            focusManager.unregister('identify-results-list');
            focusManager.unregister('identify-results-actions');

            overlay.innerHTML = `
                <div class="settings-modal admin-tv-modal identify-modal" role="dialog" aria-modal="true">
                    <div class="modal-header">
                        <h2>${i18n.t('Identify') || 'Identify'}</h2>
                        <span class="item-subtitle">${item.Name || ''}</span>
                    </div>
                    <div class="modal-body identify-form-view">
                        <div class="identify-form-grid" id="identify-inputs-container">
                            <div class="identify-input-row">
                                <label for="identify-name">${i18n.t('LabelName') || 'Title'}</label>
                                <input type="text" id="identify-name" class="identify-input" value="${(item.Name || '').replace(/"/g, '&quot;')}" tabindex="0" />
                            </div>

                            <div class="identify-row-group">
                                <div class="identify-input-row">
                                    <label for="identify-year">${i18n.t('LabelYear') || 'Year'}</label>
                                    <input type="number" id="identify-year" class="identify-input" value="${item.ProductionYear || ''}" placeholder="YYYY" tabindex="0" />
                                </div>
                                <div class="identify-input-row">
                                    <label for="identify-tmdb">${i18n.t('LabelTmdbId') || 'TMDB ID'}</label>
                                    <input type="text" id="identify-tmdb" class="identify-input" value="${providerIds.Tmdb || ''}" placeholder="e.g. 550" tabindex="0" />
                                </div>
                            </div>

                            <div class="identify-row-group">
                                <div class="identify-input-row">
                                    <label for="identify-imdb">${i18n.t('LabelImdbId') || 'IMDb ID'}</label>
                                    <input type="text" id="identify-imdb" class="identify-input" value="${providerIds.Imdb || ''}" placeholder="e.g. tt0137523" tabindex="0" />
                                </div>
                                <div class="identify-input-row">
                                    <label for="identify-tvdb">${i18n.t('LabelTvdbId') || 'TVDB ID'}</label>
                                    <input type="text" id="identify-tvdb" class="identify-input" value="${providerIds.Tvdb || ''}" placeholder="e.g. 73545" tabindex="0" />
                                </div>
                            </div>

                            <div class="identify-input-row">
                                <button type="button" id="identify-toggle-images" class="identify-toggle-btn ${replaceAllImages ? 'active' : ''}" tabindex="0">
                                    <span>${i18n.t('ReplaceExistingImages') || 'Replace all existing images'}</span>
                                    <span class="identify-toggle-indicator">${replaceAllImages ? (i18n.t('On') || 'ON') : (i18n.t('Off') || 'OFF')}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="modal-actions" id="identify-actions-container">
                        <button class="modal-action-btn" id="btn-identify-cancel" tabindex="0">${i18n.t('ButtonCancel') || 'Cancel'}</button>
                        <button class="modal-action-btn btn-primary-action" id="btn-identify-search" tabindex="0">${i18n.t('Search') || i18n.t('ButtonSearch') || 'Search'}</button>
                    </div>
                </div>
            `;

            // ── Register Focus Sections for Form ──────────────────────────────
            const inputsContainer = overlay.querySelector('#identify-inputs-container');
            const actionsContainer = overlay.querySelector('#identify-actions-container');

            focusManager.register('identify-form-inputs', inputsContainer, {
                orientation: 'vertical',
                leaveDown: 'identify-form-actions'
            });

            focusManager.register('identify-form-actions', actionsContainer, {
                orientation: 'horizontal',
                leaveUp: 'identify-form-inputs'
            });

            // Set active section to the first input field
            focusManager.setActiveSection('identify-form-inputs', false);
            const firstInput = overlay.querySelector('#identify-name');
            if (firstInput) {
                focusManager.focusElement(firstInput);
                firstInput.focus?.();
            }

            // ── Wire Form Event Handlers ──────────────────────────────────────
            const toggleBtn = overlay.querySelector('#identify-toggle-images');
            if (toggleBtn) {
                toggleBtn.onclick = () => {
                    replaceAllImages = !replaceAllImages;
                    toggleBtn.classList.toggle('active', replaceAllImages);
                    const indicator = toggleBtn.querySelector('.identify-toggle-indicator');
                    if (indicator) {
                        indicator.textContent = replaceAllImages ? (i18n.t('On') || 'ON') : (i18n.t('Off') || 'OFF');
                    }
                };
            }

            const cancelBtn = overlay.querySelector('#btn-identify-cancel');
            if (cancelBtn) {
                cancelBtn.onclick = (e) => {
                    e.stopPropagation();
                    myOnBack();
                };
            }

            const searchBtn = overlay.querySelector('#btn-identify-search');
            if (searchBtn) {
                searchBtn.onclick = (e) => {
                    e.stopPropagation();
                    executeSearch();
                };
            }

            // Support pressing Enter key on input fields to initiate search
            inputsContainer.querySelectorAll('input').forEach((input) => {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        executeSearch();
                    }
                });
            });
        };

        // ── Execute Remote Search Request ─────────────────────────────────────
        const executeSearch = async () => {
            if (isSearching) return;
            isSearching = true;

            const nameInput = overlay.querySelector('#identify-name');
            const yearInput = overlay.querySelector('#identify-year');
            const tmdbInput = overlay.querySelector('#identify-tmdb');
            const imdbInput = overlay.querySelector('#identify-imdb');
            const tvdbInput = overlay.querySelector('#identify-tvdb');

            const queryName = nameInput ? nameInput.value.trim() : '';
            const queryYear = yearInput && yearInput.value ? parseInt(yearInput.value, 10) : null;

            const queryProviderIds = {};
            if (tmdbInput && tmdbInput.value.trim()) queryProviderIds.Tmdb = tmdbInput.value.trim();
            if (imdbInput && imdbInput.value.trim()) queryProviderIds.Imdb = imdbInput.value.trim();
            if (tvdbInput && tvdbInput.value.trim()) queryProviderIds.Tvdb = tvdbInput.value.trim();

            if (!queryName && Object.keys(queryProviderIds).length === 0) {
                toast.show(i18n.t('PleaseEnterSearchTerm') || 'Please enter a title or provider ID');
                isSearching = false;
                return;
            }

            // Render Loading State in Modal Body
            const modalBody = overlay.querySelector('.modal-body');
            if (modalBody) {
                modalBody.innerHTML = `
                    <div class="admin-modal-loading">
                        <div class="loading-spinner-small"></div>
                        <span>${i18n.t('Searching') || 'Searching remote metadata...'}</span>
                    </div>
                `;
            }

            try {
                const searchInfo = {
                    Name: queryName,
                    Year: queryYear || undefined,
                    ProviderIds: queryProviderIds
                };

                log.info(`Searching remote providers for ${itemType}:`, searchInfo);
                const results = await api.getRemoteSearchResults(itemType, searchInfo, itemId);
                isSearching = false;
                renderSearchResults(results || []);
            } catch (err) {
                log.error('Failed to execute remote identify search:', err.message || err);
                isSearching = false;
                toast.show(i18n.t('ErrorSearchingMetadata') || 'Error searching remote metadata');
                renderSearchForm();
            }
        };

        // ── Render: Search Results Panel (Step 2) ──────────────────────────────
        const renderSearchResults = (results) => {
            // Unregister form sections
            focusManager.unregister('identify-form-inputs');
            focusManager.unregister('identify-form-actions');

            const hasResults = Array.isArray(results) && results.length > 0;

            let resultsHtml = '';
            if (!hasResults) {
                resultsHtml = `
                    <div class="admin-modal-empty">
                        <span style="font-size: 1.1rem; font-weight: 600;">${i18n.t('NoResultsFound') || 'No matching results found.'}</span>
                        <span style="font-size: 0.9rem; opacity: 0.7;">${i18n.t('TryRefiningSearch') || 'Try refining the title, year, or provider ID.'}</span>
                    </div>
                `;
            } else {
                resultsHtml = `
                    <div class="identify-results-list" id="identify-results-container">
                        ${results
                            .map((res, idx) => {
                                const posterSrc = res.ImageUrl || res.PrimaryImageTag
                                    ? (res.ImageUrl || api.buildUrl(`/Items/${res.Id}/Images/Primary`))
                                    : '';
                                const posterImg = posterSrc
                                    ? `<img class="identify-result-poster" src="${posterSrc}" alt="" loading="lazy" />`
                                    : `<div class="identify-result-poster" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.06);"></div>`;

                                const providerName = res.SearchProviderName || res.ProviderIds?.Tmdb ? 'TMDB' : (res.ProviderIds?.Tvdb ? 'TVDB' : (res.ProviderIds?.Imdb ? 'IMDb' : 'Remote'));

                                return `
                                    <button class="identify-result-card" data-index="${idx}" tabindex="0">
                                        ${posterImg}
                                        <div class="identify-result-info">
                                            <div class="identify-result-title">${res.Name || 'Unknown Title'}</div>
                                            <div class="identify-result-meta">
                                                ${res.ProductionYear ? `<span class="image-tag tag-dim">${res.ProductionYear}</span>` : ''}
                                                <span class="image-tag tag-provider">${providerName}</span>
                                            </div>
                                            ${res.Overview ? `<div class="identify-result-overview">${res.Overview}</div>` : ''}
                                        </div>
                                    </button>
                                `;
                            })
                            .join('')}
                    </div>
                `;
            }

            overlay.innerHTML = `
                <div class="settings-modal admin-tv-modal identify-modal" role="dialog" aria-modal="true">
                    <div class="modal-header">
                        <h2>${i18n.t('IdentifyResults') || 'Search Results'}</h2>
                        <span class="item-subtitle">${hasResults ? `${results.length} ${i18n.t('Found') || 'matches found'}` : ''}</span>
                    </div>
                    <div class="modal-body identify-results-view">
                        ${resultsHtml}
                    </div>
                    <div class="modal-actions" id="identify-results-actions-container">
                        <button class="modal-action-btn" id="btn-results-refine" tabindex="0">${i18n.t('RefineSearch') || 'Refine Search'}</button>
                        <button class="modal-action-btn" id="btn-results-cancel" tabindex="0">${i18n.t('ButtonCancel') || 'Cancel'}</button>
                    </div>
                </div>
            `;

            // ── Register Focus Sections for Results ───────────────────────────
            const resultsContainer = overlay.querySelector('#identify-results-container');
            const actionsContainer = overlay.querySelector('#identify-results-actions-container');

            if (resultsContainer && hasResults) {
                focusManager.register('identify-results-list', resultsContainer, {
                    orientation: 'vertical',
                    leaveDown: 'identify-results-actions'
                });
            }

            focusManager.register('identify-results-actions', actionsContainer, {
                orientation: 'horizontal',
                leaveUp: hasResults ? 'identify-results-list' : null
            });

            // Set active section
            if (hasResults) {
                focusManager.setActiveSection('identify-results-list', false);
                const firstCard = overlay.querySelector('.identify-result-card');
                if (firstCard) {
                    focusManager.focusElement(firstCard);
                    firstCard.focus?.();
                }
            } else {
                focusManager.setActiveSection('identify-results-actions', false);
                const refineBtn = overlay.querySelector('#btn-results-refine');
                if (refineBtn) {
                    focusManager.focusElement(refineBtn);
                    refineBtn.focus?.();
                }
            }

            // ── Wire Candidate Selection ──────────────────────────────────────
            if (hasResults) {
                overlay.querySelectorAll('.identify-result-card').forEach((cardBtn) => {
                    cardBtn.onclick = async (e) => {
                        e.stopPropagation();
                        const idx = parseInt(cardBtn.dataset.index, 10);
                        const selectedResult = results[idx];
                        if (!selectedResult) return;

                        await applyIdentification(selectedResult);
                    };
                });
            }

            // ── Wire Action Buttons ───────────────────────────────────────────
            const refineBtn = overlay.querySelector('#btn-results-refine');
            if (refineBtn) {
                refineBtn.onclick = (e) => {
                    e.stopPropagation();
                    renderSearchForm();
                };
            }

            const cancelBtn = overlay.querySelector('#btn-results-cancel');
            if (cancelBtn) {
                cancelBtn.onclick = (e) => {
                    e.stopPropagation();
                    myOnBack();
                };
            }
        };

        // ── Apply Identification to Item ──────────────────────────────────────
        const applyIdentification = async (selectedResult) => {
            log.info(`Applying identification result for item ${itemId}:`, selectedResult);

            // Show loading overlay inside modal
            const modalBody = overlay.querySelector('.modal-body');
            if (modalBody) {
                modalBody.innerHTML = `
                    <div class="admin-modal-loading">
                        <div class="loading-spinner-small"></div>
                        <span>${i18n.t('ApplyingMetadata') || 'Applying metadata and images...'}</span>
                    </div>
                `;
            }

            try {
                await api.applyRemoteSearchResult(itemId, selectedResult, replaceAllImages);

                // Invalidate all related caches across the application
                api.clearEtagCache();
                state.clearByPrefix(`details:${itemId}`);
                state.clearByPrefix('details:');
                state.clearByPrefix('home:');
                state.clearByPrefix('library:');
                state.clearByPrefix('favorites:');
                state.clearByPrefix('search:');
                state.clearByPrefix('discover:');
                state.clearByPrefix('person:');
                CardRenderer.clearCache();
                imageCache.clear();
                focusManager.resetDOMCache();

                // Display identification confirmation
                toast.show(i18n.t('ItemIdentifiedSuccessfully') || 'Item identified successfully');

                // Close the modal cleanly and restore focus to previous element
                _close(true);

                // Refresh details page metadata and images
                if (typeof detailsPage._refreshItem === 'function') {
                    detailsPage._refreshItem();
                } else if (typeof detailsPage.init === 'function') {
                    detailsPage.init({ id: itemId });
                }
            } catch (err) {
                log.error('Failed to apply identification result:', err.message || err);
                toast.show(i18n.t('ErrorApplyingMetadata') || 'Failed to apply metadata to item');
                renderSearchForm();
            }
        };

        // Click outside modal overlay to close
        overlay.onclick = (e) => {
            if (e.target === overlay) myOnBack();
        };

        // Initial render of the search form
        renderSearchForm();
    }
}
