/**
 * ============================================================================
 * Litefin Tizen - Card Renderer
 * ============================================================================
 * Shared utility for generating HTML media cards.
 * Replaces duplicate logic in Page.js and MediaGrid.js.
 * ============================================================================
 */

import { api } from '../api/index.js';

class CardRenderer {
    /**
     * Create HTML string for a media card
     * @param {Object} item - The Jellyfin item object
     * @param {Object} options - Rendering options
     * @param {boolean} [options.isLandscape=false] - Force landscape layout
     * @param {string} [options.type='poster'] - 'poster', 'episode', 'episode-primary', 'person', 'season', 'resume'
     * @returns {string} HTML string
     */
    static createCardHtml(item, options = {}) {
        const { isLandscape = false, type = 'poster', contextType = null } = options;

        let imageUrl = '';
        let imageInnerHtml = '';
        const itemId = item.Id;

        // --- 1. Image Resolution Strategy ---

        if (type === 'person') {
            // Person Handling (SVG Fallback)
            let primaryTag = item.ImageTags?.Primary || item.PrimaryImageTag;
            if (primaryTag) {
                imageUrl = api.getImageUrl(itemId, 'Primary', { maxWidth: 480, tag: primaryTag });
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
                imageUrl = api.getImageUrl(itemId, 'Primary', { maxWidth: 640, tag: item.ImageTags.Primary });
            } else if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                // Fallback to season thumb
                imageUrl = api.getImageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth: 640, tag: item.ParentThumbImageTag });
            } else if (item.SeriesThumbImageTag && item.SeriesId) {
                // Fallback to series thumb
                imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', { maxWidth: 640, tag: item.SeriesThumbImageTag });
            } else {
                // Final Fallback: Series Primary if nothing else
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth: 480 });
            }
        }
        else if (isLandscape) {
            // Landscape (Thumb/Backdrop) Preference
            if (item.Type === 'Episode') {
                // Episodes: Primary (Episode Thumb) -> Series Thumb -> Parent Thumb -> Backdrop
                if (item.ImageTags && item.ImageTags.Primary) {
                    imageUrl = api.getImageUrl(itemId, 'Primary', { maxWidth: 640, tag: item.ImageTags.Primary });
                } else if (item.SeriesThumbImageTag && item.SeriesId) {
                    imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', { maxWidth: 640, tag: item.SeriesThumbImageTag });
                } else if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                    imageUrl = api.getImageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth: 640, tag: item.ParentThumbImageTag });
                } else if (item.ParentBackdropItemId) {
                    imageUrl = api.getImageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth: 640 });
                } else if (item.SeriesId) {
                    imageUrl = api.getImageUrl(item.SeriesId, 'Backdrop', { maxWidth: 640 });
                }
            } else if (type === 'library') {
                // Libraries: Primary -> Thumb -> Backdrop
                if (item.ImageTags?.Primary) {
                    imageUrl = api.getImageUrl(itemId, 'Primary', { maxWidth: 640, tag: item.ImageTags.Primary });
                } else if (item.ImageTags?.Thumb) {
                    imageUrl = api.getImageUrl(itemId, 'Thumb', { maxWidth: 640, tag: item.ImageTags.Thumb });
                } else if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                    imageUrl = api.getImageUrl(itemId, 'Backdrop', { maxWidth: 640 });
                }
            } else {
                // Movies/Series Landscape: Thumb -> Backdrop -> Primary
                if (item.ImageTags && item.ImageTags.Thumb) {
                    imageUrl = api.getImageUrl(itemId, 'Thumb', { maxWidth: 640, tag: item.ImageTags.Thumb });
                } else if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                    imageUrl = api.getImageUrl(itemId, 'Backdrop', { maxWidth: 640 });
                } else {
                    imageUrl = api.getImageUrl(itemId, 'Primary', { maxWidth: 480, tag: item.ImageTags?.Primary });
                }
            }
        }
        else {
            // Portrait (Poster) Preference
            if (type === 'season') {
                // Season: Own Primary -> Series Primary
                if (item.ImageTags?.Primary) {
                    imageUrl = api.getImageUrl(itemId, 'Primary', { maxWidth: 480, tag: item.ImageTags.Primary });
                } else if (item.SeriesId) {
                    // Fallback to series primary if season has no image
                    imageUrl = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth: 480 });
                }
            } else if (item.Type === 'Episode' && item.SeriesId) {
                // Episode as Poster: Use Series Title/Poster usually, but if requested as poster
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth: 480 });
            } else {
                // Standard Item
                imageUrl = api.getImageUrl(itemId, 'Primary', { maxWidth: 480, tag: item.ImageTags?.Primary });
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
                // Next Up Style
                titleText = item.SeriesName || item.Name;
                subtitleText = `S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.Name}`;
            } else {
                // Poster Style
                subtitleText = `S${item.ParentIndexNumber}:E${item.IndexNumber}`;
            }
        } else if (type === 'season') {
            // For seasons, item.Name is "Season 1", usually fine.
        } else {
            // Movies/Shows - show year and role if available
            let parts = [];
            if (item.ProductionYear) parts.push(item.ProductionYear);

            // Support both standard Role and _roleName (from MediaGrid mapping)
            const role = item.Role || item._roleName;
            if (role) parts.push(`as ${role}`);

            subtitleText = parts.join(' · ');
        }

        // --- 4. HTML Assembly ---

        const cssClass = isLandscape ? 'media-card landscape' : 'media-card';
        const imagePart = imageUrl ? `<img src="${imageUrl}" alt="${item.Name}" loading="lazy" />` : imageInnerHtml;
        const finalContextType = contextType || item.Type;

        return `
            <button class="${cssClass}" data-item-id="${itemId}" data-context-type="${finalContextType}" tabindex="0">
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

export default CardRenderer;
