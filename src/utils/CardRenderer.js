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
import { i18n } from './i18n.js';
import { storage } from './StorageService.js';

class CardRenderer {
    /**
     * Create HTML string for a media card
     * @param {Object} item - The Jellyfin item object
     * @param {Object} options - Rendering options
     * @param {boolean} [options.isLandscape=false] - Force landscape layout
     * @param {string} [options.type='poster'] - 'poster', 'landscape', 'square', 'episode', 'episode-primary', 'person', 'season', 'resume'
     * @returns {string} HTML string
     */
    static createCardHtml(item, options = {}) {
        const { isLandscape = false, type = 'poster', contextType = null } = options;

        let imageUrl = '';
        let imageInnerHtml = '';
        const itemId = item.Id;

        // --- 1. Image Resolution Strategy ---
        // By default, we expect an image. We DO NOT render the fallback DOM yet to save memory.
        imageInnerHtml = '';

        if (type === 'person') {
            const primaryTag = item.ImageTags?.Primary || item.PrimaryImageTag;
            const isArtist = item.Type === 'MusicArtist' || item.Type === 'Artist';

            if (primaryTag || (itemId && isArtist)) {
                const params = imageService.getParams('poster'); // People usually have poster-like images
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    ...(primaryTag ? { tag: primaryTag } : {})
                });
            }
        } else if (type === 'episode-primary') {
            // Force Episode Primary Image (for Person Page grid)
            const params = imageService.getParams('card-backdrop');
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
        } else if (type === 'banner') {
            // Banner Optimization: Look for horizontal branding first
            const params = imageService.getParams('banner');
            
            // Priority: Banner -> Backdrop -> Thumb -> Primary
            if (item.ImageTags && item.ImageTags.Banner) {
                imageUrl = api.getImageUrl(itemId, 'Banner', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ImageTags.Banner
                });
            } else if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                imageUrl = api.getImageUrl(itemId, 'Backdrop', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.BackdropImageTags[0]
                });
            } else if (item.ImageTags && item.ImageTags.Thumb) {
                imageUrl = api.getImageUrl(itemId, 'Thumb', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ImageTags.Thumb
                });
            } else if (item.ImageTags && item.ImageTags.Primary) {
                // Last Resort: Poster (will be object-fit: cover in CSS to fill gaps)
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ImageTags.Primary
                });
            }
        } else if (isLandscape) {
            // Landscape (Thumb/Backdrop) Preference
            //
            // PERFORMANCE: Use 'card-backdrop' instead of 'backdrop' for card-sized images.
            // A landscape card slot is 400px wide — requesting a full 'backdrop' image
            // (1080px at medium quality) is a 3× scale overshoot that wastes network
            // bandwidth, JPEG decode time, and GPU texture memory on Tizen hardware.
            // 'card-backdrop' caps the request at the card's actual rendered size.
            const params = imageService.getParams('card-backdrop');

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
                // Dynamic Library Thumbs (from HomePage pre-fetch)
                if (item._dynamicThumbUrl) {
                    imageUrl = item._dynamicThumbUrl;

                    // Add modern overlay label and tint directly to the image area
                    // This provides a premium "streaming service" aesthetic
                    imageInnerHtml = `
                        <div class="card-overlay-tint"></div>
                        <div class="card-overlay-label">${i18n.ensureBiDi(item.Name)}</div>
                    `;
                }
                // Libraries: Primary -> Thumb -> Backdrop
                else if (item.ImageTags?.Primary) {
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
            } else if (
                item.ImageTags?.Primary ||
                (itemId &&
                    (item.Type === 'MusicArtist' ||
                        item.Type === 'Artist' ||
                        item.Type === 'MusicAlbum' ||
                        item.Type === 'Audio'))
            ) {
                // Standard Item (allow ID fallback for Music items where stubs are common)
                const params = imageService.getParams('poster');

                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    ...(item.ImageTags?.Primary ? { tag: item.ImageTags.Primary } : {})
                });
            }
        }

        // --- 1.5 Premium Fallbacks for Missing Images ---
        if (!imageUrl) {
            imageInnerHtml = CardRenderer.getFallbackHtml(item, isLandscape);
        }

        // --- 2. Overlays (Progress & Badges) ---

        // Resume Progress Bar
        let progressHtml = '';
        if (item.UserData?.PlaybackPositionTicks && item.RunTimeTicks) {
            const progress = (item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100;
            progressHtml = `
                <div class="card-progress-container">
                    <progress class="card-progress" value="${progress}" max="100"></progress>
                </div>
            `;
        }

        // Unplayed Count Badge
        let badgeHtml = '';
        if (item.UserData && item.UserData.UnplayedItemCount > 0) {
            badgeHtml = `<div class="count-badge">${item.UserData.UnplayedItemCount}</div>`;
        }

        // Played Badge (Check Mark)
        let playedBadgeHtml = '';
        const isMusic = item.Type === 'MusicArtist' || item.Type === 'Artist' || item.Type === 'MusicAlbum' || item.Type === 'Audio';
        
        if (item.UserData && item.UserData.Played && !isMusic) {
            playedBadgeHtml = `
                <div class="played-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
            `;
        }

        // --- 3. Text Generation ---

        let titleText = i18n.ensureBiDi(item.Name);
        let subtitleText = '';

        if (type === 'person') {
            subtitleText = i18n.ensureBiDi(item.Role || item.Type);
        } else if (item.Type === 'Episode') {
            const s = (item.ParentIndexNumber || 0).toString().padStart(2, '0');
            const e = (item.IndexNumber || 0).toString().padStart(2, '0');
            const episodeCode = `S${s}E${e}`;

            if (isLandscape) {
                if (contextType === 'season-grid') {
                    titleText = i18n.ensureBiDi(`${e} - ${item.Name}`);
                    subtitleText = '';
                } else {
                    // Next Up Style (Keep Series Name)
                    titleText = i18n.ensureBiDi(item.SeriesName || item.Name);
                    subtitleText = i18n.ensureBiDi(`${episodeCode} - ${item.Name} `);
                }
            } else {
                // Poster Style
                subtitleText = i18n.ensureBiDi(`${episodeCode} `);
            }
        } else if (type === 'season') {
            if (item.IndexNumber === 0) {
                titleText = i18n.t('Specials');
            } else {
                titleText = i18n.t('SeasonValue', [item.IndexNumber]);
            }
        } else {
            // Movies/Shows - show year and role if available
            const parts = [];

            if (item.Type === 'MusicAlbum' || item.Type === 'Audio') {
                // Music: Prioritize Artist Name
                const artist = item.AlbumArtist || (item.Artists && item.Artists[0]) || item.Artist;
                if (artist) parts.push(artist);
                else if (item.ProductionYear) parts.push(item.ProductionYear);
            } else {
                // Movies/Shows/Others - skip year here in List View as it's handled in metaParts
                if (item.ProductionYear && !options.showMeta) parts.push(item.ProductionYear);

                // Support both standard Role and _roleName (from MediaGrid mapping)
                const role = item.Role || item._roleName;
                if (role) {
                    parts.push(i18n.t('LabelAsRole', [role]));
                }
            }

            subtitleText = parts.join(' · ');
        }

        // --- 3.5. List View Override ---
        // In list-view, we want the Title on the left and EVERY other piece of info 
        // (Year, Role, Rating, Score) on the right. We move subtitle parts to metaHtml.
        let listExtraInfo = '';
        if (options.showMeta && subtitleText) {
            listExtraInfo = `<span class="card-meta-extra">${subtitleText}</span>`;
            subtitleText = ''; // Clear it so it doesn't stay on the left with the title
        }

        // --- 4. HTML Assembly ---

        let cssClass = isLandscape ? 'media-card landscape' : 'media-card';
        // 'artist' is an alias for the square type — same 1:1 aspect ratio card
        if (type === 'square' || type === 'artist') cssClass = 'media-card square';
        // LAZY LOAD: Use data-src and 1x1 transparent gif placeholder
        const placeholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        // Attach fallback data for LazyLoader to use on error
        const fbData = CardRenderer.getFallbackData(item.Name);
        const hideInitials = type === 'library';
        const dataAttributes = `data-src="${imageUrl}" data-fb-name="${fbData.name}" data-fb-init="${fbData.initials}" data-fb-grad="${fbData.gradNum}" ${hideInitials ? 'data-fb-hide-initials="true"' : ''}`;

        const imagePart = imageUrl
            ? `${imageInnerHtml}<img src="${placeholder}" ${dataAttributes} alt="${item.Name}" class="lazy" />`
            : CardRenderer.getFallbackHtml(item, isLandscape, { hideInitials });
        const finalContextType = contextType || item.Type;

        const isHiddenLibraryLabel = type === 'library' && storage.getItem('pref:hideLibraryLabels') === 'true';

        // --- 5. Optional Meta Row (list view) ---
        // showMeta injects an additional row with rating + year + runtime for
        // dense list-view cards. Only requested by _renderGrid() in list mode.
        let metaHtml = '';
        if (options.showMeta) {
            const metaParts = [];
            if (item.OfficialRating) metaParts.push(`<span class="card-meta-rating">${item.OfficialRating}</span>`);
            if (item.CommunityRating) metaParts.push(`<span class="card-meta-score">★ ${item.CommunityRating.toFixed(1)}</span>`);
            if (item.ProductionYear) metaParts.push(`<span class="card-meta-year">${item.ProductionYear}</span>`);
            if (item.RunTimeTicks) {
                const mins = Math.round(item.RunTimeTicks / 600000000);
                const hrs = Math.floor(mins / 60);
                const rem = mins % 60;
                const timeStr = hrs > 0 ? `${hrs}h ${rem}m` : `${mins}m`;
                metaParts.push(`<span class="card-meta-runtime">${timeStr}</span>`);
            }
            if (metaParts.length > 0 || listExtraInfo) {
                metaHtml = `<div class="card-meta">${listExtraInfo}${metaParts.join('')}</div>`;
            }
        }

        const badgeContainer = `
            ${badgeHtml}
            ${playedBadgeHtml}
        `;

        return `
            <button class="${cssClass}" data-item-id="${itemId}" data-type="${item.Type}" data-item-type="${item.Type}" data-context-type="${finalContextType}" tabindex="0">
                <div class="card-image ${imageUrl ? 'skeleton-shimmer' : ''}">
                    ${imagePart}
                    ${progressHtml}
                    ${!options.showMeta ? badgeContainer : ''}
                </div>
                ${
                    !isHiddenLibraryLabel
                        ? `
                <div class="card-info">
                    ${
                        options.showMeta
                            ? `
                    <div class="card-title-row">
                        <div class="card-title">${titleText}</div>
                        ${badgeContainer}
                    </div>
                    `
                            : `<div class="card-title">${titleText}</div>`
                    }
                    ${subtitleText ? `<div class="card-subtitle">${subtitleText}</div>` : ''}
                    ${metaHtml}
                </div>
                `
                        : ''
                }
            </button>
        `;
    }

    /**
     * Helper to get raw fallback data (for lazy generation on error)
     * @public
     */
    static getFallbackData(itemName) {
        const name = itemName || 'Unknown';

        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const gradNum = (Math.abs(hash) % 6) + 1;

        const words = name.split(/[\s_-]+/);
        let initials = words[0] ? words[0][0] : '?';
        if (words.length > 1 && words[1]) initials += words[1][0];
        initials = initials.toUpperCase();

        return { name, initials, gradNum };
    }

    /**
     * Helper to load a fallback gradient card with initials
     * @public
     * @param {Object} item - The item
     * @param {boolean} isLandscape - Layout mode
     * @param {Object} [options] - Options
     * @param {boolean} [options.hideInitials=false] - Whether to hide initials
     */
    static getFallbackHtml(item, isLandscape, options = {}) {
        const data = CardRenderer.getFallbackData(item.Name);
        const hideInitials = options.hideInitials || false;

        return `
            <div class="media-fallback grad-${data.gradNum}">
                ${!hideInitials ? `<div class="media-fallback-initials">${data.initials}</div>` : ''}
                <div class="media-fallback-name">${data.name}</div>
            </div>
        `;
    }

    /**
     * Create generic skeleton loader HTML.
     * Adapts the card shape to match the active view mode so skeletons
     * visually match what the real cards will look like.
     *
     * @param {number}  count      - Number of skeleton cards to generate
     * @param {boolean} isLandscape - Whether the content is landscape (episodes/networks)
     * @param {string}  [viewMode='poster'] - Active view mode identifier
     * @returns {string} HTML string
     */
    static createSkeletonHtml(count = 10, isLandscape = false, viewMode = 'poster') {
        // Determine the CSS class suffix that matches the real card's layout
        let cardClass = 'media-card skeleton';
        if (isLandscape || viewMode === 'thumb') {
            cardClass += ' landscape';
        } else if (viewMode === 'square') {
            cardClass += ' square';
        } else if (viewMode === 'banner') {
            // Banner = landscape image at fixed height — use landscape card class
            cardClass += ' landscape';
        } else if (viewMode === 'list') {
            // List skeletons are horizontal strips with a small image + text block
            cardClass += ' list-skeleton';
        }
        // 'poster' and 'small-poster' both use the default portrait shape

        let html = '';
        for (let i = 0; i < count; i++) {
            if (viewMode === 'list') {
                // List skeleton: horizontal strip
                html += `
                <div class="${cardClass}">
                    <div class="card-image skeleton-image skeleton-shimmer"></div>
                    <div class="card-info">
                        <div class="card-title skeleton-line skeleton-shimmer w-80"></div>
                        <div class="card-subtitle skeleton-line skeleton-shimmer w-50 mt-8"></div>
                    </div>
                </div>
            `;
            } else {
                html += `
                <div class="${cardClass}">
                    <div class="card-image skeleton-image skeleton-shimmer">
                        <!-- Space reserved by aspect-ratio padding -->
                    </div>
                    <div class="card-info">
                        <div class="card-title skeleton-line skeleton-shimmer w-80 m-auto"></div>
                        <div class="card-subtitle skeleton-line skeleton-shimmer w-50 m-auto mt-8"></div>
                    </div>
                </div>
            `;
            }
        }
        return html;
    }
}

export default CardRenderer;
