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

class DetailsPage extends Page {
    constructor() {
        super();

        this._itemId = null;
        this._item = null;
        this._nextUp = null;
        this._seasons = null;
        this._episodes = null;
        this._people = null;
        this._similar = null;
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
                                    ▶ Play
                                </button>
                                <button class="btn btn-secondary resume-btn hidden" tabindex="0">
                                    ▶ Resume
                                </button>
                                <button class="btn btn-icon watched-btn" tabindex="0">
                                    ✓
                                </button>
                                <button class="btn btn-icon favorite-btn" tabindex="0">
                                    ♡
                                </button>
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
                
                <!-- Loading -->
                <div class="page-loading">
                    <div class="loading-spinner"></div>
                </div>
            </div>
        `;
    }

    async onInit() {
        this._itemId = this.params.id;

        // Setup focus
        this._setupFocus();

        // Bind actions
        this._bindActions();

        // Load item details
        await this._loadDetails();
    }

    _setupFocus() {
        // Initial setup - leaveDown will be updated as content loads
        this.registerFocusSection('details-actions', this.$('#actions'), {
            orientation: 'horizontal',
            leaveDown: null // Will be updated dynamically
        });

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

        // Favorite button
        this.$('.favorite-btn')?.addEventListener('click', () => {
            this._toggleFavorite();
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
            this._renderRichMetadata();

            // 3. Load Images & Wait for Poster (Premium Feel)
            // We wait for the poster to load so the page "pops" in fully formed.
            await this._loadImages();

            // 4. Dismis Loading Overlay NOW
            this.setLoading(false);

            // 5. Load Secondary Data (Async/Background)
            this._loadSecondaryContent();

            // Load similar items
            this._loadSimilar();

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

            // Backdrop (Fire and forget, don't hide loader for this)
            const backdropId = item.BackdropImageTags?.length > 0 ? item.Id : item.ParentBackdropItemId;
            if (backdropId) {
                const backdropUrl = api.getImageUrl(backdropId, 'Backdrop', { maxWidth: 1920 });
                // Preload backdrop then apply
                const bgImg = new Image();
                bgImg.onload = () => {
                    this.$('#backdrop').style.backgroundImage = `url(${backdropUrl})`;
                    this.$('#backdrop').style.opacity = '1';
                };
                bgImg.src = backdropUrl;
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
                    leaveDown: leaveDownTarget
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

        const originalTitle = (item.OriginalTitle && item.OriginalTitle !== item.Name) ? item.OriginalTitle : '';

        this.$('#hero-info').innerHTML = `
            <div id="details-logo" class="details-logo"></div>
            <h1 class="details-title">${item.Name}</h1>
            ${originalTitle ? `<h2 class="details-original-title">${originalTitle}</h2>` : ''}
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

        // Resume button
        if (userData.PlaybackPositionTicks > 0) {
            this.$('.resume-btn')?.classList.remove('hidden');
            const resumeTime = Math.round(userData.PlaybackPositionTicks / 600000000);
            this.$('.resume-btn').textContent = `▶ Resume (${resumeTime}m)`;
        }

        // Favorite button
        if (userData.IsFavorite) {
            this.$('.favorite-btn').textContent = '♥';
            this.$('.favorite-btn').classList.add('active');
        }

        // Watched button
        if (userData.Played) {
            this.$('.watched-btn').classList.add('active');
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
            leaveDown: leaveDownTarget // Ensure down navigation works
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
                // For seasons, we might have stored season ID in dataset differently in card renderer
                // HomePage card uses item.Id as data-item-id. 
                // So card.dataset.itemId IS the season ID.
                this._loadEpisodes(this._itemId, card.dataset.itemId);
            }
        };

        const upwardLink = this._getPreviousVisibleSection('details-seasons')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-seasons');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection('details-seasons', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget
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

        container.innerHTML = this._episodes.map(ep => {
            const progress = ep.UserData?.PlaybackPositionTicks && ep.RunTimeTicks
                ? (ep.UserData.PlaybackPositionTicks / ep.RunTimeTicks) * 100
                : 0;

            return `
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
            `;
        }).join('');

        // Click handlers
        container.querySelectorAll('.episode-card').forEach(card => {
            card.addEventListener('click', () => {
                router.navigate(`/details/${card.dataset.episodeId}`);
            });
        });

        const upwardLink = this._getPreviousVisibleSection('details-episodes')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-episodes');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section
        this.registerFocusSection('details-episodes', container, {
            orientation: 'vertical',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget
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
        // We probably don't have a PersonPage yet. So let's leave click handler empty or log.
        container.onclick = (e) => {
            // Future: Navigate to Person Page

        };

        const upwardLink = this._getPreviousVisibleSection('details-people')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-people');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section
        this.registerFocusSection('details-people', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget
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
                leaveDown: actualTarget
            });
        } else if (sectionName === 'details-see-more') {
            const richMetaVisible = this.$('#rich-meta').innerHTML !== '';
            const nextTarget = richMetaVisible ? 'details-rich-meta' : targetName;

            this.registerFocusSection('details-see-more', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: 'details-actions',
                leaveDown: nextTarget
            });
        } else if (sectionName === 'details-rich-meta') {
            const seeMoreVisible = this.$('.see-more-btn').style.display !== 'none';
            const upTarget = seeMoreVisible ? 'details-see-more' : 'details-actions';

            this.registerFocusSection('details-rich-meta', this.$('#rich-meta-container'), {
                orientation: 'vertical',
                leaveUp: upTarget,
                leaveDown: targetName
            });
        } else if (sectionName === 'details-next-up') {
            const nextUpVisible = !this.$('#next-up-section').classList.contains('hidden');
            this.registerFocusSection('details-next-up', this.$('#next-up-row'), {
                orientation: 'horizontal',
                leaveUp: 'details-rich-meta',
                leaveDown: targetName
            });
        } else if (sectionName === 'details-seasons') {
            const nextUpVisible = !this.$('#next-up-section').classList.contains('hidden');
            const upLink = nextUpVisible ? 'details-next-up' : 'details-rich-meta';
            this.registerFocusSection('details-seasons', this.$('#seasons-row'), {
                orientation: 'horizontal',
                leaveUp: upLink,
                leaveDown: targetName
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
                orientation: 'vertical',
                leaveUp: episodeUp,
                leaveDown: targetName
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
                leaveDown: targetName
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
            leaveUp: upwardLink
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

    async _toggleFavorite() {
        const isFavorite = this._item.UserData?.IsFavorite;

        try {
            if (isFavorite) {
                await api.unmarkFavorite(this._itemId);
                this.$('.favorite-btn').textContent = '♡';
                this.$('.favorite-btn').classList.remove('active');
            } else {
                await api.markFavorite(this._itemId);
                this.$('.favorite-btn').textContent = '♥';
                this.$('.favorite-btn').classList.add('active');
            }

            this._item.UserData = this._item.UserData || {};
            this._item.UserData.IsFavorite = !isFavorite;
        } catch (error) {
            console.error('Failed to toggle favorite', error);
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

    _renderMediaCard(item, isLandscape, type) {
        let imageUrl = '';
        let hasImage = false;

        // Check for primary image (Standard Item or Person Item)
        // Standard items have ImageTags.Primary
        // Person items (from GetItem People) often have PrimaryImageTag property directly
        let primaryTag = item.ImageTags?.Primary || item.PrimaryImageTag;

        if (primaryTag) {
            hasImage = true;
            // Note: api.getImageUrl handles the distinction if we pass strict options, 
            // but usually we just pass the ID. We can explicitly pass the tag to be safe/efficient.
            imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: isLandscape ? 400 : 300, tag: primaryTag });
        } else if (type === 'season') {
            // Fallback for Season: Use Series Poster
            // this._item is the Series
            if (this._item && this._item.Id) {
                hasImage = true;
                imageUrl = api.getImageUrl(this._item.Id, 'Primary', { maxWidth: 300 });
            }
        }

        // We don't need a fallback URL for person if we are going to use an SVG.

        let titleText = item.Name;
        let subtitleText = '';

        if (type === 'season') {
            // Just Name
        } else if (type === 'person') {
            subtitleText = item.Role || item.Type;
        } else if (type === 'episode') {
            subtitleText = `S${item.ParentIndexNumber}:E${item.IndexNumber}`;
        } else if (item.ProductionYear) {
            subtitleText = item.ProductionYear;
        }

        if (type === 'person') {
            // Debug Person Image Logic
        }

        let imageInnerHtml = '';
        if (type === 'person' && !hasImage) {
            // SVG Placeholder for Person
            imageInnerHtml = `
                <div class="person-fallback">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                    </svg>
                </div>
            `;
        } else {
            // If person has image, OR if not a person (so fallback is empty string if missing)
            imageInnerHtml = `<img src="${imageUrl}" alt="${titleText}" onload="this.classList.add('loaded')">`;
        }

        return `
            <button class="media-card ${isLandscape ? 'landscape' : ''}" data-item-id="${item.Id}" tabindex="0">
                <div class="card-image">
                    ${imageInnerHtml}
                </div>
                <div class="card-info">
                    <div class="card-title">${titleText}</div>
                    ${subtitleText ? `<div class="card-subtitle">${subtitleText}</div>` : ''}
                </div>
            </button>
        `;
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
        if (this._isRichMetaActive) {
            this._deactivateRichMeta();
        }
        super.destroy();
    }
}

export default DetailsPage;
