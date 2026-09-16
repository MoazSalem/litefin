/**
 * ============================================================================
 * Litefin Tizen - Image Editor Modal (TV Adapted)
 * ============================================================================
 * Admin tool for viewing existing media images, deleting unwanted images,
 * and browsing / downloading high-resolution artwork from remote providers
 * (TMDB, Fanart.tv, TheTVDB, etc.).
 * Designed for 10-foot TV navigation with remote control D-pad.
 *
 * Uses dedicated focus sections ('image-editor-tabs' and 'image-editor-content')
 * with spatial 2D grid navigation and intelligent focus retention across updates.
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

const log = logger.create('ImageEditorModal');

// Available image types supported by Jellyfin
const SUPPORTED_IMAGE_TYPES = [
    { id: 'Primary', label: 'Primary' },
    { id: 'Backdrop', label: 'Backdrop' },
    { id: 'Logo', label: 'Logo' },
    { id: 'Thumb', label: 'Thumb' },
    { id: 'Art', label: 'Art' },
    { id: 'Banner', label: 'Banner' },
    { id: 'Disc', label: 'Disc' }
];

export class ImageEditorModal {
    /**
     * Display the Image Editor modal.
     * @param {string} itemId           - Target Jellyfin item ID
     * @param {Object} detailsPage      - Reference to parent DetailsPage instance
     * @param {Object} [transitionCtx]  - Navigation context from caller modal
     */
    static async show(itemId, detailsPage, transitionCtx = null) {
        const oldOnBack = transitionCtx?.oldOnBack || detailsPage.onBack;
        const prevFocus = transitionCtx?.prevFocus || focusManager.getFocused();
        const prevSection = transitionCtx?.prevSection || focusManager.getActiveSection();

        // ── Ensure Clean DOM Overlay ──────────────────────────────────────────
        let overlay = document.getElementById('details-image-editor-modal');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'details-image-editor-modal';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        const item = detailsPage._item || {};
        let activeType = 'Primary';
        let currentItemImages = [];
        let remoteImages = [];
        let hasModified = false;
        let isActionBusy = false;

        // ── Helper: Invalidate All Caches App-Wide ────────────────────────────
        const invalidateAllCaches = () => {
            log.info(`Invalidating all item caches for ${itemId}`);
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
        };

        // ── Helper: Cleanup & Close ───────────────────────────────────────────
        const _close = (restoreFocus = true) => {
            // Restore previous onBack handler on parent details page
            if (detailsPage.onBack === myOnBack) {
                detailsPage.onBack = oldOnBack;
            }

            // Animate overlay dismissal cleanly
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            // Unregister modal focus sections cleanly from FocusManager
            focusManager.unregister('image-editor-tabs');
            focusManager.unregister('image-editor-content');

            if (restoreFocus) {
                // Restore active section and focus to the previous element
                if (prevSection) {
                    focusManager.setActiveSection(prevSection, false);
                }

                // If previous focus target is still valid and connected, restore focus to it
                if (prevFocus && document.contains(prevFocus)) {
                    focusManager.focusElement(prevFocus);
                } else {
                    // Fallback to primary action buttons on the details page (Play, Resume, or More button)
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

            // If images were changed while modal was open and we are returning directly to DetailsPage (not sub-modal), refresh now
            if (restoreFocus && hasModified && typeof detailsPage._refreshItem === 'function') {
                detailsPage._refreshItem();
            }
        };

        const myOnBack = () => {
            if (transitionCtx?.fromMoreOptions) {
                detailsPage.onBack = oldOnBack;
                _close(false);
                // Return to More Options modal preserving the original caller focus context and modification flag
                detailsPage._showMoreOptionsModal(itemId, {
                    ...transitionCtx,
                    hasModified: hasModified || transitionCtx?.hasModified
                });
            } else {
                _close(true);
            }
            return true;
        };

        detailsPage.onBack = myOnBack;

        // ── Render: Base Layout Shell (Rendered once on open) ─────────────────
        const renderBaseShell = () => {
            // Build the Image Type Tabs HTML
            const tabsHtml = SUPPORTED_IMAGE_TYPES.map((t) => {
                const isActive = t.id === activeType;
                return `
                    <button class="image-tab-btn ${isActive ? 'active' : ''}" data-type="${t.id}" tabindex="0">
                        ${i18n.t(`ImageType${t.id}`) || t.label}
                    </button>
                `;
            }).join('');

            overlay.innerHTML = `
                <div class="settings-modal admin-tv-modal image-editor-modal" role="dialog" aria-modal="true">
                    <div class="modal-header">
                        <h2>${i18n.t('EditImages') || 'Edit Images'}</h2>
                        <span class="item-subtitle">${item.Name || ''}</span>
                    </div>
                    <div class="modal-body modal-options" id="image-modal-body">
                        <!-- Top Tabs Row -->
                        <div class="image-type-tabs" id="image-tabs-container">
                            ${tabsHtml}
                        </div>

                        <!-- Content Panels Area -->
                        <div id="image-content-container" style="display: flex; flex-direction: column; gap: 20px;">
                            <div class="admin-modal-loading">
                                <div class="loading-spinner-small"></div>
                                <span>${i18n.t('LoadingImages') || 'Fetching images from providers...'}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            // Query container elements for section registration
            const tabsContainer = overlay.querySelector('#image-tabs-container');
            const contentContainer = overlay.querySelector('#image-content-container');

            // Register Top Tabs and Content Area
            // Use enterTo: 'active-element' so navigating UP from content directly highlights the active tab
            focusManager.register('image-editor-tabs', tabsContainer, {
                orientation: 'horizontal',
                enterTo: 'active-element',
                leaveDown: 'image-editor-content'
            });

            focusManager.register('image-editor-content', contentContainer, {
                orientation: 'grid',
                leaveUp: 'image-editor-tabs'
            });

            // Set active section to tabs and immediately focus the first active tab button
            focusManager.setActiveSection('image-editor-tabs', false);
            const activeTabBtn = overlay.querySelector(`.image-tab-btn[data-type="${activeType}"]`);
            if (activeTabBtn) {
                focusManager.focusElement(activeTabBtn);
            }

            // Wire Tab Selection Click & Enter Handlers
            tabsContainer.querySelectorAll('.image-tab-btn').forEach((tabBtn) => {
                tabBtn.onclick = async (e) => {
                    e.stopPropagation();
                    const newType = tabBtn.dataset.type;
                    if (newType !== activeType) {
                        await switchTab(newType);
                    }
                };
            });
        };

        // ── Tab Switching Helper ──────────────────────────────────────────────
        const switchTab = async (newType) => {
            activeType = newType;

            // Update active visual styles on tabs without recreating elements
            overlay.querySelectorAll('.image-tab-btn').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.type === activeType);
            });

            // Show loading indicator in content area
            const contentContainer = overlay.querySelector('#image-content-container');
            if (contentContainer) {
                contentContainer.innerHTML = `
                    <div class="admin-modal-loading">
                        <div class="loading-spinner-small"></div>
                        <span>${i18n.t('LoadingImages') || 'Fetching images from providers...'}</span>
                    </div>
                `;
            }

            // Keep focus firmly locked on the active tab button
            focusManager.setActiveSection('image-editor-tabs', false);
            const activeTabBtn = overlay.querySelector(`.image-tab-btn[data-type="${activeType}"]`);
            if (activeTabBtn) {
                focusManager.focusElement(activeTabBtn);
            }

            await loadImagesForType(activeType);
        };

        // ── Data Fetching Helper ──────────────────────────────────────────────
        const loadImagesForType = async (type, focusOptions = null) => {
            try {
                // Fetch current item image metadata and remote candidate images in parallel
                const [allImagesRes, remoteRes] = await Promise.all([
                    api.getItemImages(itemId).catch((err) => {
                        log.warn('Failed to fetch item images:', err);
                        return [];
                    }),
                    api.getItemRemoteImages(itemId, { type: type, includeAllLanguages: true }).catch((err) => {
                        log.warn(`Failed to fetch remote images for ${type}:`, err);
                        return { Images: [] };
                    })
                ]);

                // Filter current images for the selected type
                currentItemImages = Array.isArray(allImagesRes)
                    ? allImagesRes.filter((img) => img.ImageType === type)
                    : [];

                // Extract remote candidates
                remoteImages = (remoteRes && Array.isArray(remoteRes.Images))
                    ? remoteRes.Images
                    : [];

                // Render content panels preserving focus where appropriate
                renderContentPanels(focusOptions);
            } catch (err) {
                // Log detailed error message
                log.error(`Error loading images for ${type}:`, err.message || err);
                // Display error toast notification using robust toast.show
                toast.show(i18n.t('ErrorLoadingImages') || 'Error loading images');
                renderContentPanels(focusOptions);
            }
        };

        // ── Render: Current & Remote Image Panels ─────────────────────────────
        const renderContentPanels = (focusOptions = null) => {
            const contentContainer = overlay.querySelector('#image-content-container');
            if (!contentContainer) return;

            const isBackdropOrBanner = ['Backdrop', 'Banner', 'Thumb'].includes(activeType);
            const gridClass = isBackdropOrBanner ? 'image-cards-grid backdrop-grid' : 'image-cards-grid';

            // ── Section 1: Current Server Images ──────────────────────────────
            let currentImagesHtml = '';
            if (currentItemImages.length > 0) {
                currentImagesHtml = `
                    <div class="image-section">
                        <div class="image-section-title">
                            <span>${i18n.t('CurrentServerImages') || 'Current Images'}</span>
                            <span class="admin-count-badge">${currentItemImages.length}</span>
                        </div>
                        <div class="${gridClass}" id="current-images-grid">
                            ${currentItemImages
                                .map((img, arrayIdx) => {
                                    // Construct image URL using Jellyfin image endpoint with cache buster
                                    const imgIndex = img.ImageIndex !== undefined ? img.ImageIndex : arrayIdx;
                                    const isPrimary = imgIndex === 0;
                                    const indexParam = img.ImageIndex !== undefined ? `/${img.ImageIndex}` : '';
                                    const tagParam = img.ImageTag ? `?tag=${img.ImageTag}` : '';
                                    const imgSrc = api.buildUrl(`/Items/${itemId}/Images/${activeType}${indexParam}${tagParam}`);
                                    const dimText = img.Width && img.Height ? `${img.Width} × ${img.Height}` : '';

                                    // Render prioritization / move buttons when multiple images exist for this type
                                    let reorderButtonsHtml = '';
                                    if (currentItemImages.length > 1) {
                                        const setPrimaryBtn = !isPrimary
                                            ? `<button class="image-card-action-btn prioritize-btn" data-index="${imgIndex}" data-new-index="0" tabindex="0">${i18n.t('SetAsPrimary') || 'Set as Primary'}</button>`
                                            : '';

                                        const moveLeftBtn = imgIndex > 0
                                            ? `<button class="image-card-action-btn move-btn move-left-btn" data-index="${imgIndex}" data-new-index="${imgIndex - 1}" tabindex="0">${i18n.t('MoveLeft') || 'Move Left'}</button>`
                                            : '';

                                        const moveRightBtn = imgIndex < currentItemImages.length - 1
                                            ? `<button class="image-card-action-btn move-btn move-right-btn" data-index="${imgIndex}" data-new-index="${imgIndex + 1}" tabindex="0">${i18n.t('MoveRight') || 'Move Right'}</button>`
                                            : '';

                                        reorderButtonsHtml = `
                                            ${setPrimaryBtn}
                                            <div class="image-card-actions-row">
                                                ${moveLeftBtn}
                                                ${moveRightBtn}
                                            </div>
                                        `;
                                    }

                                    return `
                                        <div class="image-card type-${activeType.toLowerCase()}">
                                            <div class="image-card-thumb-wrap">
                                                <img class="image-card-thumb cover" src="${imgSrc}" alt="${activeType}" loading="lazy" />
                                            </div>
                                            <div class="image-card-meta">
                                                <div class="image-card-tags">
                                                    ${currentItemImages.length > 1 ? `<span class="image-tag ${isPrimary ? 'tag-primary' : 'tag-dim'}">${isPrimary ? '#1 Primary' : `#${imgIndex + 1}`}</span>` : ''}
                                                    ${dimText ? `<span class="image-tag tag-dim">${dimText}</span>` : ''}
                                                    ${img.Size ? `<span class="image-tag tag-dim">${Math.round(img.Size / 1024)} KB</span>` : ''}
                                                </div>
                                                ${reorderButtonsHtml}
                                                <button class="image-card-action-btn delete-btn" data-index="${img.ImageIndex !== undefined ? img.ImageIndex : ''}" tabindex="0">
                                                    ${i18n.t('ButtonDelete') || 'Delete'}
                                                </button>
                                            </div>
                                        </div>
                                    `;
                                })
                                .join('')}
                        </div>
                    </div>
                `;
            } else {
                currentImagesHtml = `
                    <div class="image-section">
                        <div class="image-section-title">
                            <span>${i18n.t('CurrentServerImages') || 'Current Images'}</span>
                        </div>
                        <div class="admin-modal-empty" style="padding: 16px;">
                            <span>${i18n.t('NoCurrentImageSet') || 'No image currently set for this type.'}</span>
                        </div>
                    </div>
                `;
            }

            // ── Section 2: Remote Provider Images ─────────────────────────────
            let remoteImagesHtml = '';
            if (remoteImages.length > 0) {
                remoteImagesHtml = `
                    <div class="image-section">
                        <div class="image-section-title">
                            <span>${i18n.t('AvailableProviderImages') || 'Available Remote Images'}</span>
                            <span class="admin-count-badge">${remoteImages.length}</span>
                        </div>
                        <div class="${gridClass}" id="remote-images-grid">
                            ${remoteImages
                                .map((remote, idx) => {
                                    const thumbSrc = remote.ThumbnailUrl || remote.Url;
                                    const dimText = remote.Width && remote.Height ? `${remote.Width} × ${remote.Height}` : '';
                                    const provider = remote.ProviderName || 'Remote';
                                    const lang = remote.Language ? remote.Language.toUpperCase() : '';

                                    // Backdrop allows multiple images (Download), while other types update/replace the image (Update Image)
                                    const isBackdrop = activeType === 'Backdrop';
                                    const actionBtnText = isBackdrop
                                        ? (i18n.t('ButtonDownload') || i18n.t('Download') || 'Download')
                                        : (i18n.t('UpdateImage') || 'Update Image');

                                    return `
                                        <div class="image-card type-${activeType.toLowerCase()}">
                                            <div class="image-card-thumb-wrap">
                                                <img class="image-card-thumb cover" src="${thumbSrc}" alt="${provider}" loading="lazy" />
                                            </div>
                                            <div class="image-card-meta">
                                                <div class="image-card-tags">
                                                    <span class="image-tag tag-provider">${provider}</span>
                                                    ${dimText ? `<span class="image-tag tag-dim">${dimText}</span>` : ''}
                                                    ${lang ? `<span class="image-tag tag-lang">${lang}</span>` : ''}
                                                </div>
                                                <button class="image-card-action-btn download-btn" data-remote-index="${idx}" tabindex="0">
                                                    ${actionBtnText}
                                                </button>
                                            </div>
                                        </div>
                                    `;
                                })
                                .join('')}
                        </div>
                    </div>
                `;
            } else {
                remoteImagesHtml = `
                    <div class="image-section">
                        <div class="image-section-title">
                            <span>${i18n.t('AvailableProviderImages') || 'Available Remote Images'}</span>
                        </div>
                        <div class="admin-modal-empty" style="padding: 20px;">
                            <span>${i18n.t('NoRemoteImagesFound') || 'No remote provider images found for this type.'}</span>
                        </div>
                    </div>
                `;
            }

            contentContainer.innerHTML = `
                ${currentImagesHtml}
                ${remoteImagesHtml}
            `;

            const currentGrid = overlay.querySelector('#current-images-grid');
            const remoteGrid = overlay.querySelector('#remote-images-grid');

            // ── Rock-Solid Focus Target Resolution ────────────────────────────
            // Clear any stale memory and DOM caches from the destroyed previous panel elements
            focusManager.clearMemory('image-editor-content');
            focusManager.invalidateCache('image-editor-content');

            let resolvedTarget = null;
            let targetSection = 'image-editor-content';

            if (focusOptions?.targetIndex !== undefined && currentItemImages.length > 0) {
                // Target a specific current image card by index (e.g. after reordering or deleting)
                const safeTargetIndex = Math.min(Math.max(0, focusOptions.targetIndex), currentItemImages.length - 1);
                const targetCard = currentGrid?.children[safeTargetIndex];
                resolvedTarget = targetCard?.querySelector('.prioritize-btn') ||
                                 targetCard?.querySelector('.move-btn') ||
                                 targetCard?.querySelector('.image-card-action-btn') ||
                                 currentGrid?.querySelector('.image-card-action-btn');
            } else if (focusOptions?.remoteIndex !== undefined && remoteImages.length > 0) {
                // Target the remote candidate card that was just downloaded or updated
                const safeRemoteIndex = Math.min(Math.max(0, focusOptions.remoteIndex), remoteImages.length - 1);
                const targetRemoteCard = remoteGrid?.children[safeRemoteIndex];
                resolvedTarget = targetRemoteCard?.querySelector('.download-btn') ||
                                 remoteGrid?.querySelector('.download-btn');
            }

            // Fallback 1: If target was intended for content or content section was active, pick first available content button
            if (!resolvedTarget && (focusOptions?.focusSection === 'image-editor-content' || focusOptions?.remoteIndex !== undefined || focusOptions?.targetIndex !== undefined)) {
                resolvedTarget = currentGrid?.querySelector('.image-card-action-btn') ||
                                 remoteGrid?.querySelector('.download-btn');
            }

            // Fallback 2: If focus was already sitting on a valid modal tab button, keep it intact
            const currentFocused = focusManager.getFocused();
            const isTabFocused = currentFocused && document.contains(currentFocused) && currentFocused.classList.contains('image-tab-btn');

            if (!resolvedTarget && isTabFocused) {
                resolvedTarget = currentFocused;
                targetSection = 'image-editor-tabs';
            }

            // Fallback 3: Guarantee fallback to active tab button so focus is never lost to document.body
            if (!resolvedTarget) {
                resolvedTarget = overlay.querySelector(`.image-tab-btn[data-type="${activeType}"]`);
                targetSection = 'image-editor-tabs';
            }

            // Apply focus with absolute certainty via FocusManager without native focus loops
            if (resolvedTarget) {
                focusManager.setActiveSection(targetSection, false);
                focusManager.focusElement(resolvedTarget);
            }

            // ── Wire Delete Action Handlers ───────────────────────────────────
            overlay.querySelectorAll('.delete-btn').forEach((btn) => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const indexStr = btn.dataset.index;
                    const imageIndex = indexStr !== '' ? parseInt(indexStr, 10) : null;

                    await deleteImage(activeType, imageIndex);
                };
            });

            // ── Wire Prioritize / Move Handlers ───────────────────────────────
            overlay.querySelectorAll('.prioritize-btn, .move-btn').forEach((btn) => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const currentIndex = parseInt(btn.dataset.index, 10);
                    const targetIndex = parseInt(btn.dataset.newIndex, 10);
                    if (isNaN(currentIndex) || isNaN(targetIndex)) return;

                    await reorderImage(activeType, currentIndex, targetIndex);
                };
            });

            // ── Wire Download / Set Remote Image Handlers ─────────────────────
            overlay.querySelectorAll('.download-btn').forEach((btn) => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const remoteIdx = parseInt(btn.dataset.remoteIndex, 10);
                    const selectedRemote = remoteImages[remoteIdx];
                    if (!selectedRemote) return;

                    await downloadRemoteArtwork(activeType, selectedRemote, remoteIdx, btn);
                };
            });
        };

        // ── Reorder Image Handler ─────────────────────────────────────────────
        const reorderImage = async (type, currentIndex, targetIndex) => {
            if (isActionBusy) return;
            isActionBusy = true;
            log.info(`Reordering image for item ${itemId}, type ${type}: index ${currentIndex} -> ${targetIndex}`);
            try {
                // Update image index via Jellyfin API
                await api.updateItemImageIndex(itemId, type, currentIndex, targetIndex);

                // Mark modified and invalidate all caches across the app
                hasModified = true;
                invalidateAllCaches();

                // Confirm image reorder with toast feedback
                toast.show(i18n.t('ImageOrderUpdated') || 'Image order updated');

                // Reload active tab images and restore focus to target position
                await loadImagesForType(activeType, { targetIndex });
            } catch (err) {
                // Log failure details clearly
                log.error('Failed to update image order:', err.message || err);
                // Display error toast notification
                toast.show(i18n.t('ErrorUpdatingImageOrder') || 'Failed to update image order');
            } finally {
                isActionBusy = false;
            }
        };

        // ── Delete Image Handler ──────────────────────────────────────────────
        const deleteImage = async (type, imageIndex) => {
            if (isActionBusy) return;
            isActionBusy = true;
            log.info(`Deleting image for item ${itemId}, type ${type}, index ${imageIndex}`);
            try {
                await api.deleteItemImage(itemId, type, imageIndex);

                // Mark modified and invalidate all caches across the app
                hasModified = true;
                invalidateAllCaches();

                // Confirm image deletion with toast feedback
                toast.show(i18n.t('ImageDeletedSuccessfully') || 'Image deleted successfully');

                // Reload active tab images and focus nearest remaining image
                const targetIdx = imageIndex !== null && imageIndex > 0 ? imageIndex - 1 : 0;
                await loadImagesForType(activeType, { targetIndex: targetIdx });
            } catch (err) {
                // Log failure details clearly
                log.error('Failed to delete image:', err.message || err);
                // Display error toast notification
                toast.show(i18n.t('ErrorDeletingImage') || 'Failed to delete image');
            } finally {
                isActionBusy = false;
            }
        };

        // ── Download Remote Image Handler ─────────────────────────────────────
        const downloadRemoteArtwork = async (type, remoteCandidate, remoteIdx, triggerBtn) => {
            if (isActionBusy) return;
            isActionBusy = true;
            log.info(`Downloading remote image for item ${itemId}, type ${type}:`, remoteCandidate);

            // Give in-place visual feedback without disabling DOM element (which causes blur)
            if (triggerBtn) {
                triggerBtn.classList.add('loading');
                triggerBtn.textContent = i18n.t('DownloadingArtwork') || 'Downloading...';
            }

            try {
                const targetUrl = remoteCandidate.Url || remoteCandidate.url;
                const providerName = remoteCandidate.ProviderName || remoteCandidate.providerName || '';
                await api.downloadRemoteImage(itemId, type, targetUrl, providerName);

                // Mark modified and invalidate all caches across the app
                hasModified = true;
                invalidateAllCaches();

                // Confirm success with contextual toast feedback
                const successMsg = type === 'Backdrop'
                    ? (i18n.t('ImageDownloadedSuccessfully') || 'Artwork downloaded successfully')
                    : (i18n.t('ImageUpdatedSuccessfully') || 'Image updated successfully');
                toast.show(successMsg);

                // Reload active tab images and keep focus on the remote candidate card
                await loadImagesForType(activeType, { remoteIndex: remoteIdx });
            } catch (err) {
                // Log detailed error message
                log.error('Failed to download remote artwork:', err.message || err);
                // Display error toast notification using robust toast.show
                toast.show(i18n.t('ErrorDownloadingImage') || 'Failed to download image from provider');
                await loadImagesForType(activeType, { remoteIndex: remoteIdx });
            } finally {
                isActionBusy = false;
            }
        };

        // Click outside overlay to close
        overlay.onclick = (e) => {
            if (e.target === overlay) myOnBack();
        };

        // Initial render shell and trigger image fetch
        renderBaseShell();
        await loadImagesForType(activeType);
    }
}
