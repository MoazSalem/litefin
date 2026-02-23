/**
 * ============================================================================
 * Litefin Tizen - Card Renderer
 * ============================================================================
 * Shared utility for generating HTML media cards.
 * Replaces duplicate logic in Page.js and MediaGrid.js.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { imageService } from './ImageService.js';

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
            const primaryTag = item.ImageTags?.Primary || item.PrimaryImageTag;
            if (primaryTag) {
                const params = imageService.getParams('poster');
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: primaryTag
                });
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
        } else if (type === 'episode-primary') {
            // Force Episode Primary Image (for Person Page grid)
            const params = imageService.getParams('thumb');
            if (item.ImageTags?.Primary) {
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ImageTags.Primary
                });
            } else if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                // Fallback to season thumb
                imageUrl = api.getImageUrl(item.ParentThumbItemId, 'Thumb', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ParentThumbImageTag
                });
            } else if (item.SeriesThumbImageTag && item.SeriesId) {
                // Fallback to series thumb
                imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.SeriesThumbImageTag
                });
            } else if (item.SeriesId) {
                // Final Fallback: Series Primary if nothing else (only if SeriesId exists)
                const seriesParams = imageService.getParams('poster'); // Series primary is usually a poster
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', {
                    maxWidth: seriesParams.maxWidth,
                    quality: seriesParams.quality
                });
            }
        } else if (isLandscape) {
            // Landscape (Thumb/Backdrop) Preference
            const params = imageService.getParams('backdrop');

            if (item.Type === 'Episode') {
                // Spoiler Prevention: For NextUp/Upcoming/Resume, prefer Series Thumb/Backdrop
                const isSpoilerFree = ['nextUp', 'upcoming', 'resume'].includes(contextType);

                // Episodes: Primary (Episode Thumb) -> Series Thumb -> Parent Thumb -> Backdrop
                // If spoiler free, skip Primary logic unless nothing else exists
                if (!isSpoilerFree && item.ImageTags && item.ImageTags.Primary) {
                    imageUrl = api.getImageUrl(itemId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Primary
                    });
                } else if (item.SeriesThumbImageTag && item.SeriesId) {
                    imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.SeriesThumbImageTag
                    });
                } else if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                    imageUrl = api.getImageUrl(item.ParentThumbItemId, 'Thumb', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ParentThumbImageTag
                    });
                } else if (item.ParentBackdropItemId) {
                    imageUrl = api.getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
                        maxWidth: params.maxWidth,
                        quality: params.quality
                    });
                } else if (item.SeriesId) {
                    imageUrl = api.getImageUrl(item.SeriesId, 'Backdrop', {
                        maxWidth: params.maxWidth,
                        quality: params.quality
                    });
                } else if (isSpoilerFree && item.ImageTags && item.ImageTags.Primary) {
                    // Fallback to primary if forced but nothing else found
                    imageUrl = api.getImageUrl(itemId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Primary
                    });
                }
            } else if (type === 'library') {
                // Libraries: Primary -> Thumb -> Backdrop
                if (item.ImageTags?.Primary) {
                    imageUrl = api.getImageUrl(itemId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Primary
                    });
                } else if (item.ImageTags?.Thumb) {
                    imageUrl = api.getImageUrl(itemId, 'Thumb', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Thumb
                    });
                } else if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                    imageUrl = api.getImageUrl(itemId, 'Backdrop', {
                        maxWidth: params.maxWidth,
                        quality: params.quality
                    });
                }
            } else {
                // Movies/Series Landscape: Thumb -> Backdrop -> Primary
                if (item.ImageTags && item.ImageTags.Thumb) {
                    imageUrl = api.getImageUrl(itemId, 'Thumb', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Thumb
                    });
                } else if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                    imageUrl = api.getImageUrl(itemId, 'Backdrop', {
                        maxWidth: params.maxWidth,
                        quality: params.quality
                    });
                } else if (item.ImageTags?.Primary) {
                    imageUrl = api.getImageUrl(itemId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Primary
                    });
                }
            }
        } else {
            // Portrait (Poster) Preference
            if (type === 'season') {
                // Season: Own Primary -> Series Primary
                const params = imageService.getParams('poster');
                if (item.ImageTags && item.ImageTags.Primary) {
                    imageUrl = api.getImageUrl(itemId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Primary
                    });
                } else if (item.SeriesPrimaryImageTag) {
                    imageUrl = api.getImageUrl(item.SeriesId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.SeriesPrimaryImageTag
                    });
                } else if (item.SeriesId) {
                    // Fallback without tag
                    imageUrl = api.getImageUrl(item.SeriesId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality
                    });
                }
            } else if (type === 'resume') {
                // Resume cards
                const params = imageService.getParams('thumb');

                // Spoiler Prevention for Episodes
                if (item.Type === 'Episode' && item.SeriesId) {
                    // Prefer Series Primary/Thumb for Resume episodes to avoid spoilers
                    if (item.SeriesPrimaryImageTag) {
                        imageUrl = api.getImageUrl(item.SeriesId, 'Primary', {
                            maxWidth: params.maxWidth,
                            quality: params.quality,
                            tag: item.SeriesPrimaryImageTag
                        });
                    } else if (item.SeriesThumbImageTag) {
                        imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', {
                            maxWidth: params.maxWidth,
                            quality: params.quality,
                            tag: item.SeriesThumbImageTag
                        });
                    } else {
                        // Fallback
                        imageUrl = api.getImageUrl(itemId, 'Primary', {
                            maxWidth: params.maxWidth,
                            quality: params.quality,
                            tag: item.ImageTags.Primary
                        });
                    }
                } else {
                    imageUrl = api.getImageUrl(itemId, 'Primary', {
                        maxWidth: params.maxWidth,
                        quality: params.quality,
                        tag: item.ImageTags.Primary
                    });
                }
            } else if (item.Type === 'Episode' && item.SeriesId) {
                // Episode as Poster: Use Series Title/Poster usually, but if requested as poster
                const params = imageService.getParams('poster');
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality
                });
            } else if (item.ImageTags?.Primary) {
                // Standard Item
                const params = imageService.getParams('poster');
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ImageTags.Primary
                });
            }
        }

        // --- 1.5 Premium Fallbacks for Missing Images ---
        if (!imageUrl) {
            imageInnerHtml = CardRenderer._getFallbackHtml(item, isLandscape);
        }

        // --- 2. Overlays (Progress & Badges) ---

        // Resume Progress Bar
        let progressHtml = '';
        if (item.UserData?.PlaybackPositionTicks && item.RunTimeTicks) {
            const progress = (item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100;
            // TIZEN FIX: Simple ES5 string concatenation
            progressHtml =
                '<div style="position: absolute; bottom: 0; left: 0; width: 100%; height: 6px; background-color: rgba(0,0,0,0.7); z-index: 100; border-radius: 0 0 8px 8px; overflow: hidden;">' +
                '<div style="width: ' +
                progress +
                '%; height: 100%; background-color: #00a4dc;"></div>' +
                '</div>';
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
            const s = (item.ParentIndexNumber || 0).toString().padStart(2, '0');
            const e = (item.IndexNumber || 0).toString().padStart(2, '0');
            const episodeCode = `S${s}E${e}`;

            if (isLandscape) {
                if (contextType === 'season-grid') {
                    titleText = `${e} - ${item.Name}`;
                    subtitleText = '';
                } else {
                    // Next Up Style (Keep Series Name)
                    titleText = item.SeriesName || item.Name;
                    subtitleText = `${episodeCode} - ${item.Name} `;
                }
            } else {
                // Poster Style
                subtitleText = `${episodeCode} `;
            }
        } else if (type === 'season') {
            // For seasons, item.Name is "Season 1", usually fine.
        } else {
            // Movies/Shows - show year and role if available
            const parts = [];
            if (item.ProductionYear) parts.push(item.ProductionYear);

            // Support both standard Role and _roleName (from MediaGrid mapping)
            const role = item.Role || item._roleName;
            if (role) parts.push(`as ${role} `);

            subtitleText = parts.join(' · ');
        }

        // --- 4. HTML Assembly ---

        const cssClass = isLandscape ? 'media-card landscape' : 'media-card';
        // LAZY LOAD: Use data-src and 1x1 transparent gif placeholder
        const placeholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const imagePart = imageUrl
            ? `<img src="${placeholder}" data-src="${imageUrl}" alt="${item.Name}" class="lazy" />`
            : imageInnerHtml;
        const finalContextType = contextType || item.Type;

        return `
            <button class="${cssClass}" data-item-id="${itemId}" data-context-type="${finalContextType}" tabindex="0">
                <div class="card-image ${imageUrl ? 'skeleton-shimmer' : ''}">
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

    /**
     * Helper to load a fallback gradient card with initials
     * @private
     */
    static _getFallbackHtml(item, isLandscape) {
        const name = item.Name || 'Unknown';

        // Simple hash to consistently pick a gradient (1-6)
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const gradNum = (Math.abs(hash) % 6) + 1;

        // Get Initials (up to 2 characters)
        const words = name.split(/[\s_-]+/);
        let initials = words[0] ? words[0][0] : '?';
        if (words.length > 1 && words[1]) initials += words[1][0];
        initials = initials.toUpperCase();

        return `
            <div class="media-fallback grad-${gradNum}">
                <div class="media-fallback-initials">${initials}</div>
                <div class="media-fallback-name">${name}</div>
            </div>
        `;
    }

    /**
     * Create generic skeleton loader HTML
     * @param {number} count - Number of items to generate
     * @param {boolean} isLandscape - Layout mode
     * @returns {string} HTML string
     */
    static createSkeletonHtml(count = 10, isLandscape = false) {
        let html = '';
        for (let i = 0; i < count; i++) {
            html += `
                <div class="media-card skeleton ${isLandscape ? 'landscape' : ''}">
                    <div class="card-image skeleton-image skeleton-shimmer">
                        <!-- Space reserved by .card-image padding -->
                    </div>
                    <div class="card-info">
                        <div class="card-title skeleton-line skeleton-shimmer" style="width: 80%; margin: 0 auto; height: 20px;"></div>
                        <div class="card-subtitle skeleton-line skeleton-shimmer" style="width: 50%; margin: 8px auto 0 auto; height: 14px;"></div>
                    </div>
                </div>
            `;
        }
        return html;
    }
}

export default CardRenderer;
