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
import { shouldShowScore } from './visibility.js';

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
        const { isLandscape = false, type = 'poster', contextType = null, isGrid = false } = options;
        const isModern = document.documentElement.getAttribute('data-layout') === 'modern';

        let imageUrl = '';
        let imageInnerHtml = '';
        const itemId = item.Id;

        // Spy on getImageUrl to capture the exact image type and tag resolved during execution
        let resolvedImageType = '';
        let resolvedImageTag = '';
        const originalGetImageUrl = api.getImageUrl;
        api.getImageUrl = function (id, imageType, options = {}) {
            resolvedImageType = imageType;
            resolvedImageTag = options.tag || '';
            return originalGetImageUrl.call(api, id, imageType, options);
        };

        // --- 1. Image Resolution Strategy ---
        // By default, we expect an image. We DO NOT render the fallback DOM yet to save memory.
        imageInnerHtml = '';

        if (type === 'person') {
            const primaryTag = item.ImageTags?.Primary || item.PrimaryImageTag;
            const isArtist = item.Type === 'MusicArtist' || item.Type === 'Artist';

            if (primaryTag || (itemId && isArtist)) {
                const params = imageService.getParams('poster', contextType); // People usually have poster-like images
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    ...(primaryTag ? { tag: primaryTag } : {})
                });
            }
        } else if (type === 'episode-primary') {
            // Force Episode Primary Image (for Person Page grid)
            const params = imageService.getParams('card-backdrop', contextType);
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
                const seriesParams = imageService.getParams('poster', contextType); // Series primary is usually a poster
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', {
                    maxWidth: seriesParams.maxWidth,
                    quality: seriesParams.quality
                });
            }
        } else if (type === 'banner') {
            // Banner Optimization: Look for horizontal branding first
            const params = imageService.getParams('banner', contextType);

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
            const params = imageService.getParams('card-backdrop', contextType);

            if (item.Type === 'Episode') {
                // Spoiler Prevention: For NextUp/Upcoming/Resume, prefer Series Thumb/Backdrop
                const preferEpisodeImages = storage.getItem('pref:preferEpisodeImagesLocal') === 'true';
                const isSpoilerFree = !preferEpisodeImages && ['nextUp', 'upcoming', 'resume'].includes(contextType);

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

                // Add modern overlay label directly to the image area
                // This provides a premium "streaming service" aesthetic
                if (isModern || item._dynamicThumbUrl) {
                    imageInnerHtml = `
                        <div class="card-overlay-label">${i18n.ensureBiDi(item.Name)}</div>
                    `;
                }
            } else {
                // Movies/Series Landscape: Thumb -> Backdrop -> Primary
                if (item.ImageTags?.Thumb) {
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
        } else if (item.Type === 'TvChannel') {
            // Live TV Channel: Primary (Logo) -> Thumb
            const params = imageService.getParams('square', contextType); // Channels are usually square logos
            if (item.ImageTags && item.ImageTags.Primary) {
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ImageTags.Primary
                });
            }
        } else if (item.Type === 'Program') {
            // Live TV Program: Primary (usually backdrop) -> Channel Primary (Logo)
            const params = isLandscape
                ? imageService.getParams('card-backdrop', contextType)
                : imageService.getParams('poster', contextType);
            if (item.ImageTags && item.ImageTags.Primary) {
                imageUrl = api.getImageUrl(itemId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    tag: item.ImageTags.Primary
                });
            } else if (item.ChannelPrimaryImageTag && item.ChannelId) {
                // Use Channel Logo as fallback
                const logoParams = imageService.getParams('square', contextType);
                imageUrl = api.getImageUrl(item.ChannelId, 'Primary', {
                    maxWidth: logoParams.maxWidth,
                    quality: logoParams.quality,
                    tag: item.ChannelPrimaryImageTag
                });
            }
        } else {
            // Portrait (Poster) Preference
            if (type === 'season') {
                // Season: Own Primary -> Series Primary
                const params = imageService.getParams('poster', contextType);
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
                const params = imageService.getParams('thumb', contextType);

                // Spoiler Prevention for Episodes
                const preferEpisodeImages = storage.getItem('pref:preferEpisodeImagesLocal') === 'true';
                if (!preferEpisodeImages && item.Type === 'Episode' && item.SeriesId) {
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
                const params = imageService.getParams('poster', contextType);
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality
                });
            } else if (
                type === 'small-poster' ||
                item.ImageTags?.Primary ||
                item.AlbumPrimaryImageTag ||
                (itemId &&
                    (item.Type === 'MusicArtist' ||
                        item.Type === 'Artist' ||
                        item.Type === 'MusicAlbum' ||
                        item.Type === 'Audio'))
            ) {
                // Standard Item (allow ID fallback for Music items where stubs are common)
                const params = imageService.getParams(
                    type === 'small-poster' || type === 'square' || type === 'artist' ? type : 'poster',
                    contextType
                );

                let targetId = itemId;
                let targetTag = item.ImageTags?.Primary;

                // If it's an Audio track without own art, fallback to Album art
                if (item.Type === 'Audio' && item.AlbumId && !targetTag) {
                    targetId = item.AlbumId;
                    targetTag = item.AlbumPrimaryImageTag;
                }

                imageUrl = api.getImageUrl(targetId, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    ...(targetTag ? { tag: targetTag } : {})
                });
            }
        }
        // Restore getImageUrl and resolve the BlurHash string for the rendered card
        api.getImageUrl = originalGetImageUrl;

        // =====================================================================
        // BlurHash Resolution Strategy
        // =====================================================================
        // We look up the BlurHash in three tiers, from most to least specific:
        //
        // 1. Exact Match:  type + tag captured by the spy (e.g. Primary + "abc123")
        // 2. Type Match:   the spy resolved an image type but the tag was absent
        //                  (happens with fallback URLs like series Backdrop without
        //                  an explicit tag). Grab any available hash for that type.
        // 3. Primary Fallback: grab the first Primary hash as a last resort.
        // =====================================================================
        let blurHash = '';

        // Tier 1: Exact image type + tag match
        if (resolvedImageType && resolvedImageTag) {
            blurHash = item.ImageBlurHashes?.[resolvedImageType]?.[resolvedImageTag] || '';
        }

        // Tier 2: Image type matched but no tag — grab any hash for that type
        if (!blurHash && resolvedImageType && item.ImageBlurHashes?.[resolvedImageType]) {
            const typeHashes = item.ImageBlurHashes[resolvedImageType];
            const keys = Object.keys(typeHashes);
            if (keys.length > 0) {
                blurHash = typeHashes[keys[0]];
            }
        }

        // Tier 3: Absolute fallback to Primary hash (last resort, may not match)
        if (!blurHash && item.ImageBlurHashes?.Primary) {
            const keys = Object.keys(item.ImageBlurHashes.Primary);
            if (keys.length > 0) {
                blurHash = item.ImageBlurHashes.Primary[keys[0]];
            }
        }

        // --- 1.5 Premium Fallbacks & Modern Shadow ---
        if (!imageUrl) {
            imageInnerHtml = CardRenderer.getFallbackHtml(item, isLandscape);
        } else if (isModern && !isGrid) {
            // Modern horizontal cards get a shadow tint to ensure inside title readability.
            // We bypass this for grid-based cards to keep their artwork fully bright and clear.
            imageInnerHtml = `<div class="card-image-tint"></div>${imageInnerHtml}`;
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

        // --- Unplayed Count Badge ---
        //
        // Generates the circular badge on the top-right of media cards.
        // On series and seasons, this indicates the total unplayed episode count.
        // It is optional and can be disabled via preferences to declutter the UI.
        let badgeHtml = '';

        // Fetch the user preference (defaults to false, meaning counts are shown by default)
        const hideEpisodeCounts = storage.getItem('pref:hideEpisodeCounts') === 'true';

        // Only render the count badge if the user hasn't explicitly disabled it
        if (!hideEpisodeCounts && item.UserData && item.UserData.UnplayedItemCount > 0) {
            badgeHtml = `<div class="count-badge">${item.UserData.UnplayedItemCount}</div>`;
        }

        // Played Badge (Check Mark)
        let playedBadgeHtml = '';
        const isMusic =
            item.Type === 'MusicArtist' ||
            item.Type === 'Artist' ||
            item.Type === 'MusicAlbum' ||
            item.Type === 'Audio';

        if (item.UserData && item.UserData.Played && !isMusic) {
            playedBadgeHtml = `
                <div class="played-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
            `;
        }

        // Video Badge (Center Play Icon)
        let videoBadgeHtml = '';
        if (item.Type === 'Video') {
            videoBadgeHtml = `
                <div class="video-badge">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>
            `;
        }

        // Season/Episode Badge (for Series/Episodes)
        let episodeBadgeHtml = '';
        const useEpisodeBadges = storage.getItem('pref:useEpisodeBadges') !== 'false';
        if (item.Type === 'Episode' && item.IndexNumber !== undefined && useEpisodeBadges) {
            const s = (item.ParentIndexNumber || 0).toString().padStart(2, '0');
            const e = (item.IndexNumber || 0).toString().padStart(2, '0');
            episodeBadgeHtml = `<div class="episode-badge">S${s}E${e}</div>`;
        } else if (item.Type === 'Season' && item.IndexNumber !== undefined) {
            episodeBadgeHtml = `<div class="episode-badge">Season ${item.IndexNumber}</div>`;
        }

        // Quality Badge (Resolution/HDR)
        let qualityBadgeHtml = '';
        const showQualityBadges = storage.getItem('pref:showQualityBadges') === 'true';
        if (showQualityBadges) {
            let width = item.Width;
            let height = item.Height;
            let isHdr = false;

            if (item.MediaSources && item.MediaSources.length > 0) {
                const source = item.MediaSources[0];
                if (source.Width) width = source.Width;
                if (source.Height) height = source.Height;
                if (source.MediaStreams) {
                    const videoStream = source.MediaStreams.find((s) => s.Type === 'Video');
                    if (videoStream) {
                        if (videoStream.Width) width = videoStream.Width;
                        if (videoStream.Height) height = videoStream.Height;
                        const videoRange = videoStream.VideoRange || videoStream.VideoRangeType;
                        if (videoRange && videoRange.toLowerCase().includes('hdr')) {
                            isHdr = true;
                        }
                    }
                }
            }

            if (width || height) {
                let resolutionLabel = '';
                const maxDim = Math.max(width || 0, height || 0);
                const minDim = Math.min(width || 0, height || 0);

                if (maxDim >= 3840 || minDim >= 2160) {
                    resolutionLabel = '4K';
                } else if (maxDim >= 1920 || minDim >= 1080) {
                    resolutionLabel = '1080p';
                } else if (maxDim >= 1280 || minDim >= 720) {
                    resolutionLabel = '720p';
                } else if (maxDim > 0) {
                    resolutionLabel = 'SD';
                }

                if (isHdr) {
                    resolutionLabel = resolutionLabel ? `${resolutionLabel} HDR` : 'HDR';
                }

                if (resolutionLabel) {
                    qualityBadgeHtml = `<div class="quality-badge">${resolutionLabel}</div>`;
                }
            }
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
            const swapEpisodeTitles = storage.getItem('pref:swapEpisodeTitles') === 'true';

            if (swapEpisodeTitles) {
                if (contextType === 'season-grid') {
                    titleText = i18n.ensureBiDi(`${e} - ${item.Name}`);
                    subtitleText = '';
                } else {
                    if (useEpisodeBadges) {
                        titleText = i18n.ensureBiDi(item.Name);
                    } else {
                        titleText = i18n.ensureBiDi(`${episodeCode} - ${item.Name}`);
                    }
                    subtitleText = i18n.ensureBiDi(item.SeriesName || '');
                }
            } else {
                if (isLandscape) {
                    if (contextType === 'season-grid') {
                        titleText = i18n.ensureBiDi(`${e} - ${item.Name}`);
                        subtitleText = '';
                    } else {
                        // Next Up Style (Keep Series Name)
                        titleText = i18n.ensureBiDi(item.SeriesName || item.Name);
                        // If useEpisodeBadges is true, Episode code is in the badge, just show name.
                        // If useEpisodeBadges is false, Show "SxxExx - Name".
                        if (useEpisodeBadges) {
                            subtitleText = i18n.ensureBiDi(item.Name);
                        } else {
                            subtitleText = i18n.ensureBiDi(`${episodeCode} - ${item.Name} `);
                        }
                    }
                } else {
                    // Poster Style: Episode code in badge if useEpisodeBadges is true
                    if (useEpisodeBadges) {
                        subtitleText = '';
                    } else {
                        subtitleText = i18n.ensureBiDi(`${episodeCode} `);
                    }
                }
            }
        } else if (type === 'season') {
            if (item.IndexNumber === 0) {
                titleText = i18n.t('Specials');
            } else {
                titleText = i18n.t('SeasonValue', [item.IndexNumber]);
            }
        } else if (item.Type === 'TvChannel') {
            titleText = i18n.ensureBiDi(item.Number ? `${item.Number} - ${item.Name}` : item.Name);
            subtitleText = i18n.ensureBiDi(item.CurrentProgram?.Name || '');
        } else if (item.Type === 'Program') {
            titleText = i18n.ensureBiDi(item.Name);
            subtitleText = i18n.ensureBiDi(item.ChannelName || '');
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

        // --- 3.4. Label Visibility Styles ---
        const cardLabelStyle = storage.getItem('pref:cardLabelStyle') || 'default';
        if (!options.showMeta) {
            if (cardLabelStyle === 'titleOnly' || cardLabelStyle === 'titleOnly2Lines') {
                subtitleText = '';
            } else if (cardLabelStyle === 'hidden') {
                titleText = '';
                subtitleText = '';
            }
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

        // -------------------------------------------------------------
        // GRID CARD MARKER
        // -------------------------------------------------------------
        // If this card is rendered in a 2D vertical grid context (like a
        // Library grid, Search grid, or Genre category sub-grid), we append
        // the 'grid-card' class. This allows us to cleanly exclude grid cards
        // from modern expanding transformations and label positioning in CSS.
        // -------------------------------------------------------------
        if (isGrid) {
            cssClass += ' grid-card';
        }
        // LAZY LOAD: Use data-src and 1x1 transparent gif placeholder
        const placeholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        // Attach fallback data for LazyLoader to use on error
        const fbData = CardRenderer.getFallbackData(item.Name);
        const hideInitials = type === 'library';
        const dataAttributes = `data-src="${imageUrl}" data-fb-name="${fbData.name}" data-fb-init="${fbData.initials}" data-fb-grad="${fbData.gradNum}" ${hideInitials ? 'data-fb-hide-initials="true"' : ''}`;

        // ====================================================================
        // Expansion Eligibility Strategy
        // ====================================================================
        // We allow eligible poster cards on horizontal tracks to expand
        // horizontally on focus/hover.
        //
        // NOTE: We now allow posters to expand even if they do not have a valid
        // imageUrl (falling back to a premium gradient). In this case, the gradient
        // will expand smoothly and overlay the inside title and subtitle on focus/hover.
        //
        // CRITICAL GRID SAFETY: We must explicitly check if the card is inside a vertical grid (!isGrid).
        // If a card inside a vertical grid expands horizontally, it will shift and overlap with the
        // neighboring cards in the grid column structure, breaking grid alignment.
        // ====================================================================
        const canExpand =
            isModern &&
            !isLandscape &&
            !isGrid &&
            (type === 'poster' || type === 'movie' || type === 'series' || type === 'season' || type === 'person');

        let thumbPart = '';
        if (canExpand) {
            // Retrieve resolution boundaries for the modern-expanded card format.
            const thumbParams = imageService.getParams('expanded-poster');
            let thumbUrl = '';

            // 1. Prioritize native backdrops for the classic theatrical landscape feel.
            if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                thumbUrl = api.getImageUrl(itemId, 'Backdrop', {
                    maxWidth: thumbParams.maxWidth,
                    quality: thumbParams.quality,
                    tag: item.BackdropImageTags[0]
                });
            }
            // 2. Fall back to parent-level backdrops (for episodes/seasons where series backdrop applies).
            else if (item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0) {
                thumbUrl = api.getImageUrl(item.ParentBackdropItemId || item.SeriesId, 'Backdrop', {
                    maxWidth: thumbParams.maxWidth,
                    quality: thumbParams.quality,
                    tag: item.ParentBackdropImageTags[0]
                });
            }
            // 3. Fall back to series-level backdrops.
            else if (item.SeriesId && item.SeriesBackdropImageTags && item.SeriesBackdropImageTags.length > 0) {
                thumbUrl = api.getImageUrl(item.SeriesId, 'Backdrop', {
                    maxWidth: thumbParams.maxWidth,
                    quality: thumbParams.quality,
                    tag: item.SeriesBackdropImageTags[0]
                });
            }
            // 4. Ultimate Fallback: Utilize the high-resolution primary poster image itself.
            // When expanded, the CSS crops this horizontally using object-fit cover.
            else {
                const primaryTag = item.ImageTags?.Primary || item.AlbumPrimaryImageTag;
                let targetId = itemId;

                // Fallback to album art for tracks.
                if (item.Type === 'Audio' && item.AlbumId && !primaryTag) {
                    targetId = item.AlbumId;
                }

                thumbUrl = api.getImageUrl(targetId, 'Primary', {
                    maxWidth: thumbParams.maxWidth,
                    quality: thumbParams.quality,
                    ...(primaryTag ? { tag: primaryTag } : {})
                });
            }

            if (thumbUrl) {
                // Return image tag with data-thumb-src. The image is downloaded eagerly
                // on-demand when the card receives focus to preserve precious memory.
                thumbPart = `<img data-thumb-src="${thumbUrl}" class="thumb-layer" alt="" />`;
            }
        }

        // ====================================================================
        // --- Image/Fallback Part Assembly ---
        // ====================================================================
        // If an image URL exists, we construct the image tags with both lazy-loading
        // and expanding-poster support. If no image is available, we construct
        // the premium gradient fallback.
        //
        // NOTE ON LIBRARY CARDS: In the Modern layout, library card labels are hidden
        // by default from the normal card-info sections. Instead, they are overlaid
        // directly on the card image. If a library has no preview image (falling back
        // to a gradient), we must explicitly append the overlay label on top of the
        // gradient block so the card is not rendered completely blank.
        // ====================================================================
        // Check if the user has disabled BlurHash placeholders in Display Settings
        // Fall back to the default dark grey skeletons (no canvas injected) if disabled for raw performance.
        const isBlurHashDisabled = storage.getItem('litefin:disableBlurhash') === 'true';
        const blurHashHtml =
            blurHash && !isBlurHashDisabled
                ? `<canvas class="blurhash-canvas" data-blurhash="${blurHash}"></canvas>`
                : '';
        const imagePart = imageUrl
            ? `${imageInnerHtml}${thumbPart}${blurHashHtml}<img src="${placeholder}" ${dataAttributes} alt="${item.Name}" class="lazy ${canExpand ? 'poster-layer' : ''}" />`
            : `${CardRenderer.getFallbackHtml(item, isLandscape, { hideInitials })}${isModern && type === 'library' ? `<div class="card-overlay-label">${i18n.ensureBiDi(item.Name)}</div>` : ''}`;
        const finalContextType = contextType || item.Type;

        const isHiddenLibraryLabel =
            type === 'library' && (storage.getItem('pref:hideLibraryLabels') === 'true' || isModern);

        // --- 5. Optional Meta Row (list view) ---
        // showMeta injects an additional row with rating + year + runtime for
        // dense list-view cards. Only requested by _renderGrid() in list mode.
        let metaHtml = '';
        if (options.showMeta) {
            const metaParts = [];
            if (item.OfficialRating) metaParts.push(`<span class="card-meta-rating">${item.OfficialRating}</span>`);
            if (item.CommunityRating && shouldShowScore(item))
                metaParts.push(`<span class="card-meta-score">★ ${item.CommunityRating.toFixed(1)}</span>`);
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

        // ====================================================================
        // --- 5. Integrated vs External Labels (Modern vs Classic Layout) ---
        // ====================================================================
        // The display architecture differs dramatically between our layout engines:
        //
        // 1. In the Modern layout:
        //    - Landscape and square cards integrate labels INSIDE the card image
        //      containers as high-end premium overlays.
        //    - Standard posters render labels OUTSIDE.
        //    - Expandable posters render BOTH to enable a seamless crossfade and
        //      CSS scale transition from outside to inside on hover/focus.
        //
        // 2. In the Classic layout (isModern is false):
        //    - ALL cards (posters, landscape, and square) must render their labels
        //      OUTSIDE (underneath the card structure) to align with standard TV
        //      interfaces and prevent visual clipping.
        // ====================================================================
        const isSquare = type === 'square' || type === 'artist';
        // In vertical 2D grids (!isGrid is false), we disable inside integrated labels
        // and force standard outside labels to keep the entire grid uniform and clean.
        const renderInside = isModern && !isGrid && (isLandscape || isSquare || canExpand);
        const renderOutside = !isModern || isGrid || (!isLandscape && !isSquare);

        // Final visibility logic (Classic vs Modern)
        const showInside = renderInside && !isHiddenLibraryLabel && (options.showMeta || cardLabelStyle !== 'hidden');
        const showOutside = renderOutside && !isHiddenLibraryLabel && (options.showMeta || cardLabelStyle !== 'hidden');
        const expansionClass = canExpand ? ' has-expansion' : '';

        const badgeContainer = `
            ${badgeHtml}
            ${playedBadgeHtml}
            ${videoBadgeHtml}
            ${episodeBadgeHtml}
            ${qualityBadgeHtml}
        `;

        return `
            <button class="${cssClass}${expansionClass}" data-item-id="${itemId}" data-type="${item.Type}" data-item-type="${item.Type}" data-collection-type="${item.CollectionType || ''}" data-context-type="${finalContextType}" data-channel-id="${item.ChannelId || ''}" tabindex="0">
                <div class="card-image ${imageUrl ? 'skeleton-shimmer' : ''}">
                    ${imagePart}
                    ${progressHtml}
                    ${videoBadgeHtml}
                    ${!options.showMeta ? badgeContainer : ''}
                    ${
                        showInside
                            ? `
                    <div class="card-info inside">
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
                </div>
                ${
                    showOutside
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
        const isModern = document.documentElement.getAttribute('data-layout') === 'modern';

        return `
            <div class="media-fallback grad-${data.gradNum}">
                ${!hideInitials ? `<div class="media-fallback-initials">${data.initials}</div>` : ''}
                ${!isModern ? `<div class="media-fallback-name">${data.name}</div>` : ''}
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
    static createSkeletonHtml(count = 10, isLandscape = false, viewMode = 'poster', hideLabels = false) {
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

        const cardLabelStyle = storage.getItem('pref:cardLabelStyle') || 'default';
        const skeletonHideLabels = hideLabels || (viewMode !== 'list' && cardLabelStyle === 'hidden');
        const skeletonHideSubtitle =
            viewMode !== 'list' &&
            (cardLabelStyle === 'titleOnly' || cardLabelStyle === 'titleOnly2Lines' || cardLabelStyle === 'hidden');

        let html = '';
        for (let i = 0; i < count; i++) {
            const isModern = document.documentElement.getAttribute('data-layout') === 'modern';
            const isSquare = viewMode === 'square' || viewMode === 'artist';
            const isIntegratedModern =
                isModern && (isLandscape || viewMode === 'thumb' || viewMode === 'banner' || isSquare);
            const isPortraitModern = isModern && !isLandscape && !isSquare;

            if (viewMode === 'list') {
                // List skeleton: horizontal strip
                html += `
                <div class="${cardClass}">
                    <div class="card-image skeleton-image skeleton-shimmer"></div>
                    ${
                        !skeletonHideLabels
                            ? `
                    <div class="card-info">
                        <div class="card-title skeleton-line skeleton-shimmer w-80"></div>
                        ${!skeletonHideSubtitle ? `<div class="card-subtitle skeleton-line skeleton-shimmer w-50 mt-8"></div>` : ''}
                    </div>
                    `
                            : ''
                    }
                </div>
            `;
            } else {
                const infoHtml = !skeletonHideLabels
                    ? `
                    <div class="card-info${isIntegratedModern ? ' inside' : ''}">
                        <div class="card-title skeleton-line skeleton-shimmer w-80${isIntegratedModern ? '' : ' m-auto'}"></div>
                        ${isIntegratedModern || cardLabelStyle === 'titleOnly2Lines' ? `<div class="card-title skeleton-line skeleton-shimmer w-50 mt-4${isIntegratedModern ? '' : ' m-auto'}"></div>` : ''}
                        ${!skeletonHideSubtitle ? `<div class="card-subtitle skeleton-line skeleton-shimmer w-50${isIntegratedModern ? '' : ' m-auto'} mt-8"></div>` : ''}
                    </div>
                `
                    : '';

                html += `
                <div class="${cardClass}">
                    <div class="card-image skeleton-image skeleton-shimmer">
                        ${isIntegratedModern ? infoHtml : '<!-- Space reserved by aspect-ratio padding -->'}
                    </div>
                    ${!skeletonHideLabels && !isIntegratedModern && !isPortraitModern ? infoHtml : ''}
                </div>
            `;
            }
        }
        return html;
    }
}

export default CardRenderer;
