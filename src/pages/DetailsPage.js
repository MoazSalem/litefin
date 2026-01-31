/**
 * ============================================================================
 * Litefin Tizen - Details Page
 * ============================================================================
 * Item details with metadata, play button, and related content.
 * Handles movies, series, seasons, and episodes.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { animationManager } from '../ui/AnimationManager.js';
import { focusManager } from '../ui/FocusManager.js';


import FavoriteButton from '../components/FavoriteButton.js';
import EpisodeList from '../components/EpisodeList.js';
import BackdropManager from '../utils/BackdropManager.js';

class DetailsPage extends Page {
    constructor() {
        super();

        this._itemId = null;
        this._item = null;
        this._nextUp = null;
        this._seasons = null;
        this._episodes = null;
        this._people = null;
        this._people = null;
        this._similar = null;

        // Components

    }

    render() {
        return `
            <div class="page details-page">
                <!-- Backdrop -->
                <div class="details-backdrop" id="backdrop">
                    <div class="backdrop-gradient"></div>
                </div>
                
                <!-- Scrollable Content -->
                <div class="details-content page-content">



                    <!-- Main Split Layout (Marked as media-row for focus scrolling) -->
                    <div class="details-main-split media-row">
                        <!-- Left: Poster -->
                        <div class="hero-poster" id="poster"></div>
                        
                        <!-- Right: Info column -->
                        <div class="details-info-col">
                            <div class="hero-info" id="hero-info">
                                <!-- Info rendered here -->
                            </div>

                            <!-- Actions -->
                            <section class="details-actions" id="actions">
                                <button class="btn btn-primary play-btn" tabindex="0">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                    <span>Play</span>
                                </button>
                                <button class="btn btn-secondary resume-btn hidden" tabindex="0">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                    <span>Resume</span>
                                </button>
                                <button class="btn btn-icon watched-btn" tabindex="0" aria-label="Mark as watched">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                </button>
                                <!-- Favorite Button Injected Here -->
                            </section>

                            <!-- Overview -->
                            <div class="details-overview">
                                <p class="overview-text line-clamp-6"></p>
                                <button class="see-more-btn" tabindex="0">See More</button>
                            </div>

                        </div>
                    </div>
                    
                    <!-- Rich Metadata (Genres, People, Studios, Tags) -->
                    <div id="rich-meta-container" class="media-row">
                        <div class="details-rich-meta" id="rich-meta" tabindex="0"></div>
                    </div>
                    
                    <!-- Next Up (for series) -->
                    <section class="details-next-up media-row hidden" id="next-up-section">
                        <h2 class="row-title">Next Up</h2>
                        <div class="next-up-row row-items" id="next-up-row"></div>
                    </section>
                    
                    <!-- Seasons (for series) -->
                    <section class="details-seasons media-row hidden" id="seasons-section">
                        <h2 class="row-title">Seasons</h2>
                        <div class="seasons-row" id="seasons-row"></div>
                    </section>
                    
                    <!-- Episodes (for season/series) -->
                    <section class="details-episodes media-row hidden" id="episodes-section">
                        <h2 class="row-title">Episodes</h2>
                        <div class="episodes-list" id="episodes-list"></div>
                    </section>

                    <!-- Cast & Crew -->
                    <section class="details-people media-row hidden" id="people-section">
                        <h2 class="row-title">Cast & Crew</h2>
                        <div class="people-row row-items" id="people-row"></div>
                    </section>
                    
                    <!-- Similar items -->
                    <section class="details-similar media-row hidden" id="similar-section">
                        <h2 class="row-title">More Like This</h2>
                        <div class="similar-row" id="similar-row"></div>
                    </section>
                </div>
                

            </div>
        `;
    }

    async onInit() {
        this._itemId = this.params.id;

        try {
            // Setup focus
            this._setupFocus();

            // Bind actions
            this._bindActions();

            // Load item details
            await this._loadDetails();
        } catch (err) {
            console.error('DetailsPage: onInit failed', err);
        }
    }

    _setupFocus() {
        // Register Action Buttons
        this.registerFocusSection('details-actions', this.$('#actions'), {
            orientation: 'horizontal',
            leaveUp: null, // Top of page
            leaveDown: null, // Will be updated dynamically
            leaveLeft: 'sidebar'
        });

        // Default to Play button (actions)
        this.setActiveSection('details-actions');
    }

    _bindActions() {

        // Play button
        this.$('.play-btn')?.addEventListener('click', () => {
            this._play();
        });

        // Resume button
        this.$('.resume-btn')?.addEventListener('click', () => {
            this._play(true);
        });

        // Watched button
        this.$('.watched-btn')?.addEventListener('click', () => {
            this._toggleWatched();
        });
    }

    async _loadDetails() {
        this.setLoading(true);

        try {
            // 1. Fetch Item (Blocking) - minimal fields if possible, but we need overview/people
            // Note: We request 'People' here, which is fine, usually fast.
            this._item = await api.getItem(this._itemId, { Fields: 'People' });
            this.title = this._item.Name;

            // 2. Render Text Immediately (Instant Interaction)
            this._renderHeroText();
            this._setupFavoriteButton(); // New method
            this._renderRichMetadata();

            // 3. Load Images & Wait for Poster (Premium Feel)
            // We wait for the poster to load so the page "pops" in fully formed.
            await this._loadImages();

            // 4. Dismis Loading Overlay NOW
            this.setLoading(false);

            // 5. Load Secondary Data (Async/Background)
            this._loadSecondaryContent();

            // Load similar items (except for seasons)
            if (this._item.Type !== 'Season') {
                this._loadSimilar();
            }

        } catch (error) {
            console.error('DetailsPage: Failed to load', error);
            this.showError('Failed to load details');
            this.setLoading(false);
        }
    }

    _loadImages() {
        return new Promise((resolve) => {
            const item = this._item;

            // Safety timeout: If image takes > 2s, show content anyway
            const timeout = setTimeout(() => {
                console.warn('DetailsPage: Poster load timed out, showing content');
                resolve();
            }, 2000);

            const onPosterReady = () => {
                clearTimeout(timeout);
                resolve();
            };

            // Poster
            const posterUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 400 });
            const img = new Image();
            img.onload = () => {
                img.classList.add('loaded');
                onPosterReady();
            };
            img.onerror = () => {
                // If it fails, we still want to resolve to show the page
                onPosterReady();
            };
            img.src = posterUrl;
            img.alt = item.Name;

            const posterContainer = this.$('#poster');
            posterContainer.innerHTML = '';
            posterContainer.appendChild(img);

            // Backdrop (Fire and forget, via Manager)
            const backdropUrl = BackdropManager.getBackdropUrl(item);
            if (backdropUrl) {
                BackdropManager.applyBackdrop(this.$('#backdrop'), backdropUrl);
            }
        });
    }

    async _loadSecondaryContent() {
        // Load additional data based on type
        if (this._item.Type === 'Series') {
            await Promise.all([
                this._loadNextUp(),
                this._loadSeasons()
            ]);
        } else if (this._item.Type === 'Season') {
            await this._loadEpisodes(this._item.SeriesId, this._itemId);
        }

        // Render people if available
        this._people = this._item.People || [];
        if (this._people.length > 0) {
            this._renderPeople();
        }

        // Load Logo Last (Heavy asset)
        this._loadLogo();
    }

    _renderRichMetadata() {
        const item = this._item;
        const htmlParts = [];

        // Helper to create row
        const createRow = (label, items) => {
            if (!items || items.length === 0) return '';
            const valuesHtml = items.map(i => {
                const name = i.Name || i; // Handle object or string
                // Chips are NOT navigable initially (explicit tabindex="-1")
                // FocusManager now ignores them even if they are buttons
                return `<button class="meta-chip" tabindex="-1" data-meta-name="${name}">${name}</button>`;
            }).join('');

            return `
                <div class="rich-meta-row">
                    <div class="meta-label">${label}</div>
                    <div class="meta-value-list">${valuesHtml}</div>
                </div>
            `;
        };

        // Genres
        if (item.Genres && item.Genres.length > 0) {
            htmlParts.push(createRow('Genres', item.Genres));
        }

        // Directors
        const directors = (item.People || []).filter(p => p.Type === 'Director');
        if (directors.length > 0) {
            htmlParts.push(createRow('Directors', directors));
        }

        // Writers
        const writers = (item.People || []).filter(p => p.Type === 'Writer');
        if (writers.length > 0) {
            htmlParts.push(createRow('Writers', writers));
        }

        // Studios
        if (item.Studios && item.Studios.length > 0) {
            htmlParts.push(createRow('Studios', item.Studios));
        }

        // Tags (No limit as requested)
        if (item.Tags && item.Tags.length > 0) {
            htmlParts.push(createRow('Tags', item.Tags));
        }

        const container = this.$('#rich-meta');
        if (container) {
            container.innerHTML = htmlParts.join('');

            // Make container focusable as a single unit
            if (htmlParts.length > 0) {
                container.setAttribute('tabindex', '0');
                container.classList.add('focusable');

                // Bind Click AND Keydown (Enter) to activate "Trap Mode"
                const activateHandler = (e) => {
                    // Only Enter (13) if key event
                    if (e.type === 'keydown' && e.keyCode !== 13) return;



                    // Prevent bubbling if clicking internal chips already valid
                    if (e.target.classList.contains('meta-chip') && this._isRichMetaActive) {
                        return;
                    }

                    e.preventDefault();
                    e.stopPropagation();
                    this._activateRichMeta();
                };

                container.onclick = activateHandler;
                container.onkeydown = activateHandler;

                // Register Focus Section
                const upwardLink = this._getPreviousVisibleSection('details-rich-meta')?.targetName || 'details-actions';
                const nextSection = this._getNextVisibleSection('details-rich-meta');
                const leaveDownTarget = nextSection ? nextSection.targetName : null;

                this.registerFocusSection('details-rich-meta', this.$('#rich-meta-container'), {
                    orientation: 'vertical',
                    leaveUp: upwardLink,
                    leaveDown: leaveDownTarget,
                    leaveLeft: 'sidebar'
                });

                // Update upward link
                this._updateLeaveDown(upwardLink, 'details-rich-meta');
            }
        }
    }

    _activateRichMeta() {
        if (this._isRichMetaActive) return;

        const container = this.$('#rich-meta'); // The Table
        const wrapper = this.$('#rich-meta-container'); // The Section
        if (!container) return;


        this._isRichMetaActive = true;
        container.classList.add('active-table');

        // Enable chips
        const chips = container.querySelectorAll('.meta-chip');
        chips.forEach(chip => chip.setAttribute('tabindex', '0'));

        // Disable container from auto-focus
        container.setAttribute('tabindex', '-1');

        // Async focus shift to ensure attributes apply
        requestAnimationFrame(() => {
            // Re-query chips to be sure
            const validChips = container.querySelectorAll('.meta-chip');
            if (validChips.length === 0) {
                console.error('RichMeta: No chips found after render, reverting');
                this._deactivateRichMeta();
                return;
            }



            // Push focus trap on the Wrapper (So internal nav works)
            focusManager.pushTrap(wrapper);

            // Force focus
            focusManager.focusElement(validChips[0]);
        });
    }

    _deactivateRichMeta() {
        if (!this._isRichMetaActive) return;

        const container = this.$('#rich-meta');
        if (!container) return;


        this._isRichMetaActive = false;
        container.classList.remove('active-table');

        // Disable chips
        const chips = container.querySelectorAll('.meta-chip');
        chips.forEach(chip => chip.setAttribute('tabindex', '-1'));

        // Pop trap (Restores focus to previous element = container)
        focusManager.popTrap();

        // Restore container visibility
        container.setAttribute('tabindex', '0');

        // Ensure focus is on container (redundant but safe)
        focusManager.focusElement(container);
    }

    onBack() {
        // Intercept Back if inside the table
        if (this._isRichMetaActive) {
            this._deactivateRichMeta();
            return;
        }
        super.onBack();
    }

    _loadLogo() {
        const item = this._item;
        // Check for Logo using ImageTags.Logo or ParentLogoImageTag
        const logoTag = item.ImageTags?.Logo || item.ParentLogoImageTag;
        const logoItemId = item.ImageTags?.Logo ? item.Id : (item.ParentLogoItemId || item.SeriesId);

        if (logoTag && logoItemId) {
            const logoUrl = api.getImageUrl(logoItemId, 'Logo', { maxWidth: 600, tag: logoTag });
            const img = new Image();
            img.onload = () => {
                const logoContainer = this.$('#details-logo');
                if (logoContainer) {
                    logoContainer.innerHTML = '';
                    logoContainer.appendChild(img);
                    img.classList.add('loaded');
                }
            };
            img.src = logoUrl;
            // img.alt = item.Name + " Logo"; // Alt might show if transparent PNG fails?
        }
    }

    _renderHeroText() {
        const item = this._item;

        // Build meta items (Year, Runtime, Ratings)
        const year = item.ProductionYear || '';

        let runtimeText = '';
        let endsAtText = '';
        if (item.RunTimeTicks) {
            const totalMinutes = Math.round(item.RunTimeTicks / 600000000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            runtimeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

            // Ends At
            const endTime = new Date(Date.now() + (item.RunTimeTicks / 10000));
            const timeString = endTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            endsAtText = `Ends at ${timeString}`;
        }

        const rating = item.OfficialRating;
        const starRating = item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : '';
        const criticRating = item.CriticRating ? `🍅 ${item.CriticRating}` : '';

        let metaHtml = '';
        if (year) metaHtml += `<span class="meta-item">${year}</span>`;
        if (runtimeText) metaHtml += `<span class="meta-item">${runtimeText}</span>`;
        if (rating) metaHtml += `<span class="meta-item meta-badge">${rating}</span>`;
        if (starRating) metaHtml += `<span class="meta-item meta-star">${starRating}</span>`;
        if (criticRating) metaHtml += `<span class="meta-item meta-tomato">${criticRating}</span>`;
        if (endsAtText) metaHtml += `<span class="meta-item meta-ends-at">${endsAtText}</span>`;

        const isSeason = item.Type === 'Season';
        const displayTitle = isSeason ? (item.SeriesName || item.Name) : item.Name;
        const displaySubtitle = isSeason ? item.Name : ((item.OriginalTitle && item.OriginalTitle !== item.Name) ? item.OriginalTitle : '');

        this.$('#hero-info').innerHTML = `
            <div id="details-logo" class="details-logo"></div>
            <h1 class="details-title">${displayTitle}</h1>
            ${displaySubtitle && displaySubtitle !== displayTitle ? `<h2 class="details-original-title">${displaySubtitle}</h2>` : ''}
            ${item.Type === 'Episode' ? `<p class="details-episode-info">S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.SeriesName}</p>` : ''}
            
            <div class="details-meta-row">
                ${metaHtml}
            </div>
        `;

        // Overview
        const overviewEl = this.$('.overview-text');

        // Tagline
        const tagline = (item.Taglines && item.Taglines.length > 0) ? item.Taglines[0] : '';

        // Find or create tagline element
        let taglineEl = this.$('.details-tagline');
        if (!taglineEl && tagline) {
            taglineEl = document.createElement('p');
            taglineEl.className = 'details-tagline';
            // Insert before the overview text
            const overviewContainer = this.$('.details-overview');
            overviewContainer.insertBefore(taglineEl, overviewEl);
        }

        if (taglineEl) {
            taglineEl.textContent = tagline;
            taglineEl.style.display = tagline ? 'block' : 'none';
        }

        overviewEl.textContent = item.Overview || '';

        // Reset state
        overviewEl.classList.add('line-clamp-6');
        this.$('.see-more-btn').style.display = 'none';

        // Reveal the column (Fade In) to prevent layout jump
        // We do this after content injection
        requestAnimationFrame(() => {
            this.$('.details-info-col').classList.add('visible');
            this._checkOverviewTruncation();
        });

        // Update buttons based on state
        this._updateButtons();
    }

    _updateButtons() {
        const item = this._item;
        const userData = item.UserData || {};

        const playBtn = this.$('.play-btn');
        const resumeBtn = this.$('.resume-btn');
        const watchedBtn = this.$('.watched-btn');

        // Reset state first
        if (playBtn) playBtn.classList.remove('hidden');
        if (resumeBtn) {
            resumeBtn.classList.add('hidden');
            resumeBtn.classList.remove('btn-primary');
            resumeBtn.classList.add('btn-secondary');
        }

        // Resume Logic
        if (userData.PlaybackPositionTicks > 0) {
            // If resume point exists: Hide Play, Show Resume as Primary
            if (playBtn) playBtn.classList.add('hidden');

            if (resumeBtn) {
                resumeBtn.classList.remove('hidden');
                // Upgrade to primary style
                resumeBtn.classList.remove('btn-secondary');
                resumeBtn.classList.add('btn-primary');

                const resumeTime = Math.round(userData.PlaybackPositionTicks / 600000000);
                resumeBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Resume (${resumeTime}m)</span>`;

                // Ensure focus logic knows about this swap? 
                // FocusManager should handle it as long as the visible one is focusable.

                // CRITICAL: If we hid the Play button (which probably had focus or would get it),
                // we must manually force focus to the Resume button so focus isn't lost.
                requestAnimationFrame(() => {
                    focusManager.focusElement(resumeBtn);
                });
            }
        }

        // Watched button
        if (userData.Played) {
            if (watchedBtn) watchedBtn.classList.add('active');
        }
    }

    async _loadNextUp() {
        try {
            const response = await api.getNextUp({ SeriesId: this._itemId, Limit: 1 });
            this._nextUp = response.Items || [];

            if (this._nextUp.length > 0) {
                this._renderNextUp();
            }
        } catch (error) {
            console.warn('Failed to load next up', error);
        }
    }

    _renderNextUp() {
        const container = this.$('#next-up-row');
        const section = this.$('#next-up-section');

        section.classList.remove('hidden');
        container.classList.add('row-items');

        const htmlParts = [];
        for (const item of this._nextUp) {
            // Force landscape for Next Up (Episode)
            htmlParts.push(this._renderMediaCard(item, true, 'episode'));
        }
        container.innerHTML = htmlParts.join('');

        // Delegated click handler
        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                // Navigate to episode details?? Or play?
                // Usually Next Up on details page -> Play or go to episode?
                // Jellyfin web goes to Episode Details.
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        // Determine upward link using helper
        const upwardLink = this._getPreviousVisibleSection('details-next-up')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-next-up');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section
        this.registerFocusSection('details-next-up', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget, // Ensure down navigation works
            leaveLeft: 'sidebar'
        });

        // Update upward link
        this._updateLeaveDown(upwardLink, 'details-next-up');
    }

    async _loadSeasons() {
        try {
            const response = await api.getSeasons(this._itemId);
            this._seasons = response.Items || [];

            if (this._seasons.length > 0) {
                this._renderSeasons();
            }
        } catch (error) {
            console.warn('Failed to load seasons', error);
        }
    }

    _renderSeasons() {
        const container = this.$('#seasons-row');
        const section = this.$('#seasons-section');

        section.classList.remove('hidden');
        container.classList.add('row-items'); // Standard class

        const htmlParts = [];
        for (const season of this._seasons) {
            htmlParts.push(this._renderMediaCard(season, false, 'season'));
        }
        container.innerHTML = htmlParts.join('');

        // Delegated click handler
        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                // Navigate directly to DetailsPage with Season ID
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        const upwardLink = this._getPreviousVisibleSection('details-seasons')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-seasons');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection('details-seasons', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar'
        });

        // Update upward link
        this._updateLeaveDown(upwardLink, 'details-seasons');
    }

    async _loadEpisodes(seriesId, seasonId) {
        try {
            const response = await api.getEpisodes(seriesId, seasonId);
            this._episodes = response.Items || [];

            if (this._episodes.length > 0) {
                this._renderEpisodes();
            }
        } catch (error) {
            console.warn('Failed to load episodes', error);
        }
    }

    _renderEpisodes() {
        const container = this.$('#episodes-list');
        const section = this.$('#episodes-section');

        section.classList.remove('hidden');

        if (this._item.Type === 'Season') {
            container.classList.add('vertical-list');
            // Use vertical EpisodeList component
            this._episodeList = new EpisodeList({
                episodes: this._episodes,
                seriesId: this._item.SeriesId,
                onPlay: (episodeId) => {
                    router.navigate(`/play/${episodeId}`);
                },
                onAction: (action, episodeId) => {
                    if (action === 'info') {
                        router.navigate(`/details/${episodeId}`);
                    }
                    console.log(`Episode action: ${action} on ${episodeId}`);
                }
            });
            this._episodeList.mount(container);
        } else {
            // Horizontal episode cards (for Series NextUp, etc.)
            const htmlParts = [];
            for (const ep of this._episodes) {
                const progress = ep.UserData?.PlaybackPositionTicks && ep.RunTimeTicks
                    ? (ep.UserData.PlaybackPositionTicks / ep.RunTimeTicks) * 100
                    : 0;

                htmlParts.push(`
                    <button class="episode-card" data-episode-id="${ep.Id}" tabindex="0">
                        <div class="episode-thumb">
                            <img src="${api.getImageUrl(ep.Id, 'Primary', { maxWidth: 300 })}" alt="">
                            ${progress > 0 ? `<div class="progress-bar"><div class="progress" style="width: ${progress}%"></div></div>` : ''}
                        </div>
                        <div class="episode-info">
                            <span class="episode-number">E${ep.IndexNumber}</span>
                            <span class="episode-title">${ep.Name}</span>
                            <p class="episode-overview">${ep.Overview?.substring(0, 100) || ''}...</p>
                        </div>
                    </button>
                `);
            }
            container.innerHTML = htmlParts.join('');

            // Click handlers
            container.querySelectorAll('.episode-card').forEach(card => {
                card.addEventListener('click', () => {
                    router.navigate(`/details/${card.dataset.episodeId}`);
                });
            });
        }

        // Focus section registration
        const upwardLink = this._getPreviousVisibleSection('details-episodes')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-episodes');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section - use appropriate selector
        const selector = this._item.Type === 'Season'
            ? '.episode-row-card, .episode-action-btn'
            : '.episode-card';

        // Helper for custom navigation
        const onSeasonMove = (direction, focusedEl) => {
            const currentRow = focusedEl.closest('.episode-row');
            if (!currentRow) return false;

            // Get all rows to determine index
            const allRows = Array.from(container.querySelectorAll('.episode-row'));
            const rowIndex = allRows.indexOf(currentRow);

            if (direction === 'up') {
                if (rowIndex > 0) {
                    // Move to previous row's CARD (always reset to card for stability)
                    const prevRow = allRows[rowIndex - 1];
                    const target = prevRow.querySelector('.episode-row-card');
                    focusManager.focusElement(target);
                    return true;
                }
                // At top row - let it bubble to leaveUp
                return false;
            }

            if (direction === 'down') {
                if (rowIndex < allRows.length - 1) {
                    // Move to next row's CARD
                    const nextRow = allRows[rowIndex + 1];
                    const target = nextRow.querySelector('.episode-row-card');
                    focusManager.focusElement(target);
                    return true;
                }
                // At bottom row - let it bubble to leaveDown
                return false;
            }

            // Left/Right handled by 'horizontal' orientation (linear in DOM)
            // But we might want to ensure it doesn't wrap to next row?
            // Standard 'horizontal' in FocusManager checks index +/- 1.
            // Since our DOM order is Card -> Btn1 -> Btn2 -> NextCard...
            // "Right" from last Btn would go to NextCard. We probably DON'T want that?
            // Ideally Right on last button should do nothing (or leaveRight?)
            if (direction === 'right') {
                const rowItems = Array.from(currentRow.querySelectorAll(selector.split(', ').join(',')));
                const itemIndex = rowItems.indexOf(focusedEl);

                // If we are at the end of the row, BLOCK movement to next row
                if (itemIndex >= rowItems.length - 1) {
                    return true; // Handled (blocked)
                }
            }

            if (direction === 'left') {
                const rowItems = Array.from(currentRow.querySelectorAll(selector.split(', ').join(',')));
                const itemIndex = rowItems.indexOf(focusedEl);

                // If at start of row (Card), let it bubble to leaveLeft (if any) or Sidebar?
                // Standard horizontal will try index-1. 
                // If index-1 is prev row's last button, that's bad.
                // So we must BLOCK if itemIndex is 0.
                if (itemIndex === 0) {
                    return false; // Allow bubble to leave section
                }
            }

            return false; // Fallback to standard local move
        };

        this.registerFocusSection('details-episodes', container, {
            orientation: 'horizontal', // Use horizontal to handle Left/Right linear
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            selector: selector,
            onMove: this._item.Type === 'Season' ? onSeasonMove : null
        });

        // Update upward link's leaveDown
        this._updateLeaveDown(upwardLink, 'details-episodes');
    }

    _renderPeople() {
        const container = this.$('#people-row');
        const section = this.$('#people-section');

        section.classList.remove('hidden');

        const htmlParts = [];
        for (const person of this._people) {
            htmlParts.push(this._renderMediaCard(person, false, 'person'));
        }
        container.innerHTML = htmlParts.join('');

        // Delegated click handler - navigate to Person Details (if we had a page)
        // For now, maybe just focus? Or do nothing?
        // User didn't specify behavior, but usually it goes to person items.
        // Person Click Handler
        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card && card.dataset.itemId) {
                const personId = card.dataset.itemId;
                router.navigate(`/person/${personId}`);
            }
        };

        const upwardLink = this._getPreviousVisibleSection('details-people')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-people');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section
        this.registerFocusSection('details-people', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar'
        });

        // Update upward link's leaveDown
        this._updateLeaveDown(upwardLink, 'details-people');
    }

    _checkOverviewTruncation() {
        const overviewEl = this.$('.overview-text');
        const seeMoreBtn = this.$('.see-more-btn');

        if (overviewEl.scrollHeight > overviewEl.clientHeight) {
            seeMoreBtn.style.display = 'block';

            // 1. Determine what is below the See More button
            const nextSection = this._getNextVisibleSection('details-see-more');
            const downTarget = nextSection ? nextSection.targetName : null;

            // 2. Register See More Section
            this.registerFocusSection('details-see-more', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: 'details-actions',
                leaveDown: downTarget
            });

            // 3. Link Actions -> See More
            this._updateLeaveDown('details-actions', 'details-see-more');

            // Handle Click (Toggle)
            seeMoreBtn.onclick = () => {
                const isExpanded = !overviewEl.classList.contains('line-clamp-6');

                if (isExpanded) {
                    // Collapse
                    overviewEl.classList.add('line-clamp-6');
                    seeMoreBtn.textContent = 'See More';
                    this.$('.details-page').scrollTop = 0; // Optional: Reset scroll
                } else {
                    // Expand
                    overviewEl.classList.remove('line-clamp-6');
                    seeMoreBtn.textContent = 'See Less';
                }

                // Keep focus on the button
                seeMoreBtn.focus();
            };
        }
    }

    _getNextVisibleSection(currentSectionName) {
        const sections = [
            { name: 'details-see-more', elementId: '#details-overview', isVisible: () => this.$('.see-more-btn').style.display !== 'none' },
            { name: 'details-rich-meta', elementId: '#rich-meta', isVisible: () => this.$('#rich-meta').innerHTML !== '' },
            { name: 'details-next-up', elementId: '#next-up-row', isVisible: () => !this.$('#next-up-section').classList.contains('hidden') },
            { name: 'details-seasons', elementId: '#seasons-row', isVisible: () => !this.$('#seasons-section').classList.contains('hidden') },
            { name: 'details-episodes', elementId: '#episodes-list', isVisible: () => !this.$('#episodes-section').classList.contains('hidden') },
            { name: 'details-people', elementId: '#people-row', isVisible: () => !this.$('#people-section').classList.contains('hidden') },
            { name: 'details-similar', elementId: '#similar-row', isVisible: () => !this.$('#similar-section').classList.contains('hidden') }
        ];

        let foundCurrent = false;
        for (const section of sections) {
            if (section.name === currentSectionName) {
                foundCurrent = true;
                continue;
            }
            if (foundCurrent && section.isVisible()) {
                return { targetName: section.name, elementId: section.elementId };
            }
        }
        return null;
    }

    _getPreviousVisibleSection(currentSectionName) {
        const sections = [
            { name: 'details-similar', elementId: '#similar-row', isVisible: () => !this.$('#similar-section').classList.contains('hidden') },
            { name: 'details-people', elementId: '#people-row', isVisible: () => !this.$('#people-section').classList.contains('hidden') },
            { name: 'details-episodes', elementId: '#episodes-list', isVisible: () => !this.$('#episodes-section').classList.contains('hidden') },
            { name: 'details-seasons', elementId: '#seasons-row', isVisible: () => !this.$('#seasons-section').classList.contains('hidden') },
            { name: 'details-next-up', elementId: '#next-up-row', isVisible: () => !this.$('#next-up-section').classList.contains('hidden') },
            { name: 'details-rich-meta', elementId: '#rich-meta', isVisible: () => this.$('#rich-meta').innerHTML !== '' },
            { name: 'details-see-more', elementId: '#details-overview', isVisible: () => this.$('.see-more-btn').style.display !== 'none' },
            { name: 'details-actions', elementId: '#actions', isVisible: () => true } // Actions are always visible
        ];

        let foundCurrent = false;
        for (const section of sections) {
            if (section.name === currentSectionName) {
                foundCurrent = true;
                continue;
            }
            if (foundCurrent && section.isVisible()) {
                return { targetName: section.name, elementId: section.elementId };
            }
        }
        return null;
    }

    _updateLeaveDown(sectionName, targetName) {
        if (sectionName === 'details-actions') {
            const seeMoreVisible = this.$('.see-more-btn').style.display !== 'none';
            const richMetaVisible = this.$('#rich-meta').innerHTML !== '';
            let actualTarget = targetName;

            if (seeMoreVisible) {
                actualTarget = 'details-see-more';
            } else if (richMetaVisible) {
                actualTarget = 'details-rich-meta';
            }

            this.registerFocusSection('details-actions', this.$('#actions'), {
                orientation: 'horizontal',
                leaveUp: 'details-nav-header', // Preserve header link
                leaveDown: actualTarget,
                leaveLeft: 'sidebar'
            });
        } else if (sectionName === 'details-see-more') {
            const richMetaVisible = this.$('#rich-meta').innerHTML !== '';
            const nextTarget = richMetaVisible ? 'details-rich-meta' : targetName;

            this.registerFocusSection('details-see-more', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: 'details-actions',
                leaveDown: nextTarget,
                leaveLeft: 'sidebar'
            });
        } else if (sectionName === 'details-rich-meta') {
            const seeMoreVisible = this.$('.see-more-btn').style.display !== 'none';
            const upTarget = seeMoreVisible ? 'details-see-more' : 'details-actions';

            this.registerFocusSection('details-rich-meta', this.$('#rich-meta-container'), {
                orientation: 'vertical',
                leaveUp: upTarget,
                leaveDown: targetName,
                leaveLeft: 'sidebar'
            });
        } else if (sectionName === 'details-next-up') {
            const nextUpVisible = !this.$('#next-up-section').classList.contains('hidden');
            this.registerFocusSection('details-next-up', this.$('#next-up-row'), {
                orientation: 'horizontal',
                leaveUp: 'details-rich-meta',
                leaveDown: targetName,
                leaveLeft: 'sidebar'
            });
        } else if (sectionName === 'details-seasons') {
            const nextUpVisible = !this.$('#next-up-section').classList.contains('hidden');
            const upLink = nextUpVisible ? 'details-next-up' : 'details-rich-meta';
            this.registerFocusSection('details-seasons', this.$('#seasons-row'), {
                orientation: 'horizontal',
                leaveUp: upLink,
                leaveDown: targetName,
                leaveLeft: 'sidebar'
            });
        } else if (sectionName === 'details-episodes') {
            const seasonsVisible = !this.$('#seasons-section').classList.contains('hidden');
            const nextUpVisible = !this.$('#next-up-section').classList.contains('hidden');
            let episodeUp = 'details-actions';
            if (seasonsVisible) {
                episodeUp = 'details-seasons';
            } else if (nextUpVisible) {
                episodeUp = 'details-next-up';
            }
            this.registerFocusSection('details-episodes', this.$('#episodes-list'), {
                orientation: 'custom', // Use custom to denote managed logic, though FM doesn't strictly check for 'custom' string yet, it's good for clarity
                leaveUp: episodeUp,
                leaveDown: targetName,
                leaveLeft: 'sidebar',
                onMove: (direction, focusedElement) => {
                    if (!focusedElement) return false;
                    const currentRow = focusedElement.closest('.episode-row');
                    if (!currentRow) return false;

                    // Horizontal Navigation (Within Row)
                    if (direction === 'right' || direction === 'left') {
                        // Find all focusables in this row
                        const rowFocusables = Array.from(currentRow.querySelectorAll('.focusable, .episode-action-btn'));
                        const currentIndex = rowFocusables.indexOf(focusedElement);

                        if (direction === 'right') {
                            if (currentIndex < rowFocusables.length - 1) {
                                focusManager.focusElement(rowFocusables[currentIndex + 1]);
                                return true;
                            }
                        } else {
                            if (currentIndex > 0) {
                                focusManager.focusElement(rowFocusables[currentIndex - 1]);
                                return true;
                            }
                        }
                        return false; // Allow FocusManager to handle section leaving (e.g. Left -> Menu?)
                    }

                    // Vertical Navigation (Between Rows)
                    if (direction === 'down' || direction === 'up') {
                        const rows = Array.from(this.$('#episodes-list').querySelectorAll('.episode-row'));
                        const rowIndex = rows.indexOf(currentRow);

                        let targetRow = null;
                        if (direction === 'down') {
                            if (rowIndex < rows.length - 1) targetRow = rows[rowIndex + 1];
                            else return false; // Let FocusManager handle leaveDown
                        } else {
                            if (rowIndex > 0) targetRow = rows[rowIndex - 1];
                            else return false; // Let FocusManager handle leaveUp
                        }

                        if (targetRow) {
                            // Always focus the episodes card when moving vertically
                            const targetCard = targetRow.querySelector('.episode-row-card');
                            if (targetCard) {
                                focusManager.focusElement(targetCard);
                                return true;
                            }
                        }
                    }
                    return false;
                }
            });
        } else if (sectionName === 'details-people') {
            const episodesVisible = !this.$('#episodes-section').classList.contains('hidden');
            const seasonsVisible = !this.$('#seasons-section').classList.contains('hidden');
            const nextUpVisible = !this.$('#next-up-section').classList.contains('hidden');

            let peopleUp = 'details-actions';
            if (episodesVisible) {
                peopleUp = 'details-episodes';
            } else if (seasonsVisible) {
                peopleUp = 'details-seasons';
            } else if (nextUpVisible) {
                peopleUp = 'details-next-up';
            }
            this.registerFocusSection('details-people', this.$('#people-row'), {
                orientation: 'horizontal',
                leaveUp: peopleUp,
                leaveDown: targetName,
                leaveLeft: 'sidebar'
            });
        }
    }

    async _loadSimilar() {
        try {
            const response = await api.getSimilar(this._itemId);
            this._similar = response.Items || [];

            if (this._similar.length > 0) {
                this._renderSimilar();
            }
        } catch (error) {
            console.warn('Failed to load similar', error);
        }
    }

    _renderSimilar() {
        const container = this.$('#similar-row');
        const section = this.$('#similar-section');

        section.classList.remove('hidden');
        container.classList.add('row-items');

        const htmlParts = [];
        for (const item of this._similar) {
            htmlParts.push(this._renderMediaCard(item, false, 'poster'));
        }
        container.innerHTML = htmlParts.join('');

        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        const peopleVisible = !this.$('#people-section').classList.contains('hidden');
        const episodesVisible = !this.$('#episodes-section').classList.contains('hidden');
        const seasonsVisible = !this.$('#seasons-section').classList.contains('hidden');
        const nextUpVisible = !this.$('#next-up-section').classList.contains('hidden');

        let upwardLink = 'details-actions';
        if (peopleVisible) {
            upwardLink = 'details-people';
        } else if (episodesVisible) {
            upwardLink = 'details-episodes';
        } else if (seasonsVisible) {
            upwardLink = 'details-seasons';
        } else if (nextUpVisible) {
            upwardLink = 'details-next-up';
        }

        this.registerFocusSection('details-similar', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveLeft: 'sidebar'
        });

        this._updateLeaveDown(upwardLink, 'details-similar');
    }

    _play(resume = false) {
        let itemToPlay = this._item;

        if (this._item.Type === 'Series' && this._episodes?.length > 0) {
            itemToPlay = this._episodes.find(ep => !ep.UserData?.Played) || this._episodes[0];
        }

        eventBus.emit('player:play', {
            item: itemToPlay,
            resume
        });
    }

    _setupFavoriteButton() {
        const actionsContainer = this.$('#actions');
        if (actionsContainer) {
            if (this._favBtn) this._favBtn.destroy();

            this._favBtn = new FavoriteButton({
                itemId: this._item.Id,
                initialState: this._item.UserData?.IsFavorite,
                className: 'btn btn-icon favorite-btn',
                onChange: (isFav) => {
                    if (!this._item.UserData) this._item.UserData = {};
                    this._item.UserData.IsFavorite = isFav;
                }
            });

            // Remove any existing Favorite Button (if re-rendering)
            const old = actionsContainer.querySelector('.favorite-btn');
            if (old) old.remove();

            this._favBtn.mount(actionsContainer);

            // Refresh focus cache so FocusManager sees the new button
            focusManager.invalidateCache('details-actions');
        }
    }



    async _toggleWatched() {
        const isPlayed = this._item.UserData?.Played;

        try {
            if (isPlayed) {
                await api.unmarkPlayed(this._itemId);
                this.$('.watched-btn').classList.remove('active');
            } else {
                await api.markPlayed(this._itemId);
                this.$('.watched-btn').classList.add('active');
            }

            this._item.UserData = this._item.UserData || {};
            this._item.UserData.Played = !isPlayed;
        } catch (error) {
            console.error('Failed to toggle watched', error);
        }
    }

    onBack() {
        if (this._isRichMetaActive) {
            console.log('RichMeta: Back pressed, exiting trap');
            this._deactivateRichMeta();
            return true; // Consume event (don't exit page)
        }
        return super.onBack();
    }

    destroy() {
        if (this._header) {
            this._header.destroy();
            this._header = null;
        }
        if (this._favBtn) {
            this._favBtn.destroy();
            this._favBtn = null;
        }

        if (this._isRichMetaActive) {
            this._deactivateRichMeta();
        }
        super.destroy();
    }
}

export default DetailsPage;
