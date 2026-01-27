/**
 * ============================================================================
 * Litefin Tizen - Base Page Class
 * ============================================================================
 * Base class for all pages. Extends Component with page-specific features:
 * - Route parameter handling
 * - Focus section registration
 * - Back navigation handling
 * ============================================================================
 */

import Component from '../core/Component.js';
import { eventBus } from '../core/EventBus.js';
import { focusManager } from '../ui/FocusManager.js';
import { api } from '../api/index.js';

class Page extends Component {
    /**
     * Create a page
     * @param {Object} [options] - Page options
     */
    constructor(options = {}) {
        super(options);

        // Route parameters
        this.params = {};

        // Page title
        this.title = '';

        // Registered focus sections for this page
        this._focusSections = [];

        // Back handler
        // REMOVED: App.js handles this directly
        // this._onBack = this._onBack.bind(this);
    }

    /**
     * Initialize the page with route params
     * Called by router after construction
     * @param {Object} params - Route parameters
     */
    init(params = {}) {
        this.params = params;

        // Get main container
        this.container = document.getElementById('app');

        // IMPORTANT: Clear the container (removes loading screen)
        this.container.innerHTML = '';

        // Mount the page
        this.mount();

        // Register back handler
        // REMOVED: App.js now coordinates back events
        // eventBus.on('key:back', this._onBack);

        // Set document title
        if (this.title) {
            document.title = `${this.title} - Litefin`;
        }

        // Call page-specific initialization
        this.onInit();
    }

    /**
     * Override in subclass for page-specific init
     */
    onInit() { }

    /**
     * Handle back button press
     * Override for custom behavior
     * @returns {boolean} True if handled, False to trigger default router back
     */
    onBack() {
        return false; // Not handled by default
    }

    /**
     * Register a focus section for this page
     * @param {string} name - Section name
     * @param {HTMLElement} container - Section container
     * @param {Object} [options] - Focus options
     */
    registerFocusSection(name, container, options = {}) {
        focusManager.register(name, container, options);
        this._focusSections.push(name);
    }

    /**
     * Set the active focus section
     * @param {string} name - Section name
     */
    setActiveSection(name) {
        focusManager.setActiveSection(name);
    }

    /**
     * Clean up the page
     */
    destroy() {
        // Unregister focus sections
        for (const name of this._focusSections) {
            focusManager.unregister(name);
        }
        this._focusSections = [];

        // Remove back handler
        eventBus.off('key:back', this._onBack);

        // Call parent destroy
        super.destroy();
    }

    /**
     * Show loading state
     * @param {boolean} show - Show or hide
     */
    setLoading(show) {
        if (show) {
            this.el?.classList.add('loading');
        } else {
            this.el?.classList.remove('loading');
        }
    }

    /**
     * Show error message
     * @param {string} message - Error message
     */
    showError(message) {
        const errorEl = this.$('.page-error');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }
    }

    /**
     * Hide error message
     */
    hideError() {
        const errorEl = this.$('.page-error');
        if (errorEl) {
            errorEl.style.display = 'none';
        }
    }
    /**
     * Render a standard media card
     * Unified method for Home and Details pages
     */
    _renderMediaCard(item, isLandscape = false, type = 'poster') {
        let imageUrl = '';
        let hasImage = false;
        let imageInnerHtml = '';

        // --- 1. Image Resolution Strategy ---

        if (type === 'person') {
            // Person Handling (SVG Fallback)
            let primaryTag = item.ImageTags?.Primary || item.PrimaryImageTag;
            if (primaryTag) {
                hasImage = true;
                imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 300, tag: primaryTag });
            } else {
                // SVG Placeholder
                imageInnerHtml = `
                    <div class="person-fallback">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                        </svg>
                    </div>
                `;
            }
        }
        else if (type === 'episode-primary') {
            // Force Episode Primary Image (for Person Page grid)
            if (item.ImageTags?.Primary) {
                imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 400, tag: item.ImageTags.Primary });
            } else if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                // Fallback to season thumb
                imageUrl = api.getImageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth: 400, tag: item.ParentThumbImageTag });
            } else if (item.SeriesThumbImageTag && item.SeriesId) {
                // Fallback to series thumb
                imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', { maxWidth: 400, tag: item.SeriesThumbImageTag });
            }
        }
        else if (isLandscape) {
            // Landscape (Thumb/Backdrop) Preference
            if (item.Type === 'Episode') {
                // Episodes: Primary (Episode Thumb) -> Series Thumb -> Parent Thumb -> Backdrop
                if (item.ImageTags && item.ImageTags.Primary) {
                    imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 400, tag: item.ImageTags.Primary });
                } else if (item.SeriesThumbImageTag && item.SeriesId) {
                    imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', { maxWidth: 400, tag: item.SeriesThumbImageTag });
                } else if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                    imageUrl = api.getImageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth: 400, tag: item.ParentThumbImageTag });
                } else if (item.ParentBackdropItemId) {
                    imageUrl = api.getImageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth: 400 });
                } else if (item.SeriesId) {
                    imageUrl = api.getImageUrl(item.SeriesId, 'Backdrop', { maxWidth: 400 });
                }
            } else {
                // Movies/Series Landscape: Thumb -> Backdrop -> Primary
                if (item.ImageTags && item.ImageTags.Thumb) {
                    imageUrl = api.getImageUrl(item.Id, 'Thumb', { maxWidth: 400, tag: item.ImageTags.Thumb });
                } else if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                    imageUrl = api.getImageUrl(item.Id, 'Backdrop', { maxWidth: 400 });
                } else {
                    imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 300, tag: item.ImageTags?.Primary });
                }
            }
        } else {
            // Portrait (Poster) Preference
            if (type === 'season') {
                // Season: Own Primary -> Series Primary
                if (item.ImageTags?.Primary) {
                    imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 300, tag: item.ImageTags.Primary });
                } else if (this._item && this._item.Id) { // Fallback if called from DetailsPage context
                    imageUrl = api.getImageUrl(this._item.Id, 'Primary', { maxWidth: 300 });
                }
            } else if (item.Type === 'Episode' && item.SeriesId) {
                // Episode as Poster: Use Series Poster
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth: 300 });
            } else {
                // Standard Item
                imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 300, tag: item.ImageTags?.Primary });
            }
        }

        // --- 2. Overlays (Progress & Badges) ---

        // Resume Progress Bar
        let progressHtml = '';
        if (item.UserData?.PlaybackPositionTicks && item.RunTimeTicks) {
            const progress = (item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100;
            progressHtml = `<div class="progress-bar" style="background: linear-gradient(to right, var(--jf-accent) ${progress}%, rgba(0,0,0,0.6) ${progress}%);"></div>`;
        }

        // Unplayed Count Badge
        let badgeHtml = '';
        if (item.UserData && item.UserData.UnplayedItemCount > 0) {
            badgeHtml = `<div class="count-badge">${item.UserData.UnplayedItemCount}</div>`;
        }

        // --- 3. Text Generation ---

        let titleText = item.Name;
        let subtitleText = '';

        if (type === 'person') {
            subtitleText = item.Role || item.Type;
        } else if (item.Type === 'Episode') {
            if (isLandscape) {
                // Next Up
                titleText = item.SeriesName || item.Name;
                subtitleText = `S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.Name}`;
            } else {
                // Poster
                subtitleText = `S${item.ParentIndexNumber}:E${item.IndexNumber}`;
            }
        } else if (item.ProductionYear) {
            subtitleText = item.ProductionYear;
        }

        // --- 4. HTML Assembly ---

        const cssClass = isLandscape ? 'media-card landscape' : 'media-card'; // Add specific class if needed
        const imagePart = imageUrl ? `<img src="${imageUrl}" alt="${item.Name}" loading="lazy" />` : imageInnerHtml;
        const itemId = item.Id;

        return `
            <button class="${cssClass}" data-item-id="${itemId}" tabindex="0">
                <div class="card-image">
                    ${imagePart}
                    ${progressHtml}
                    ${badgeHtml}
                </div>
                <div class="card-info">
                    <div class="card-title">${titleText}</div>
                    ${subtitleText ? `<div class="card-subtitle">${subtitleText}</div>` : ''}
                </div>
            </button>
        `;
    }
}

export default Page;
