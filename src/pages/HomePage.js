/**
 * ============================================================================
 * FastFin Tizen - Home Page
 * ============================================================================
 * Main landing page after login showing:
 * - Continue watching row
 * - Next up episodes
 * - Latest items per library
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import VirtualList from '../ui/VirtualList.js';
import { animationManager } from '../ui/AnimationManager.js';

class HomePage extends Page {
    constructor() {
        super();
        this.title = 'Home';

        this._libraries = [];
        this._rows = [];
    }

    render() {
        return `
            <div class="page home-page">
                <!-- Header -->
                <header class="page-header">
                    <h1 class="page-title">Home</h1>
                    <nav class="header-nav">
                        <button class="nav-btn search-btn" tabindex="0">
                            <span class="icon">🔍</span>
                            Search
                        </button>
                        <button class="nav-btn settings-btn" tabindex="0">
                            <span class="icon">⚙️</span>
                        </button>
                    </nav>
                </header>
                
                <!-- Content rows -->
                <main class="page-content" id="home-content">
                    <div class="home-rows">
                        <!-- Rows will be rendered here -->
                    </div>
                    
                    <!-- Loading state -->
                    <div class="page-loading">
                        <div class="loading-spinner"></div>
                    </div>
                </main>
            </div>
        `;
    }

    async onInit() {
        // Setup navigation
        this._bindNavigation();

        // Setup focus
        this._setupFocus();

        // Load content
        await this._loadContent();
    }

    _bindNavigation() {
        // Search button
        this.$('.search-btn')?.addEventListener('click', () => {
            router.navigate('/search');
        });

        // Settings button
        this.$('.settings-btn')?.addEventListener('click', () => {
            router.navigate('/settings');
        });
    }

    _setupFocus() {
        // Register header as focus section
        this.registerFocusSection('home-header', this.$('.page-header'), {
            orientation: 'horizontal',
            leaveDown: 'home-row-0'
        });

        this.setActiveSection('home-header');
    }

    async _loadContent() {
        this.setLoading(true);

        try {
            // Get user libraries
            const viewsResponse = await api.getUserViews();
            this._libraries = viewsResponse.Items || [];

            // Build rows data
            const rowsData = [];

            // 1. Continue watching
            const resumeItems = await api.getResumeItems();
            if (resumeItems.Items?.length > 0) {
                rowsData.push({
                    title: 'Continue Watching',
                    items: resumeItems.Items,
                    type: 'resume'
                });
            }

            // 2. Next up
            const nextUp = await api.getNextUp();
            if (nextUp.Items?.length > 0) {
                rowsData.push({
                    title: 'Next Up',
                    items: nextUp.Items,
                    type: 'episode'
                });
            }

            // 3. Latest per library
            for (const library of this._libraries) {
                try {
                    const latest = await api.getLatestItems(library.Id, { Limit: 20 });
                    if (latest?.length > 0) {
                        rowsData.push({
                            title: `Latest in ${library.Name}`,
                            items: latest,
                            libraryId: library.Id,
                            type: 'latest'
                        });
                    }
                } catch (e) {
                    console.warn(`Failed to load latest for ${library.Name}`, e);
                }
            }

            // Render rows
            this._renderRows(rowsData);

        } catch (error) {
            console.error('HomePage: Failed to load content', error);
            this.showError('Failed to load content');
        }

        this.setLoading(false);
    }

    _renderRows(rowsData) {
        const container = this.$('.home-rows');
        if (!container) return;

        container.innerHTML = rowsData.map((row, index) => `
            <section class="media-row" data-row-index="${index}">
                <h2 class="row-title">${row.title}</h2>
                <div class="row-items" id="row-items-${index}">
                    ${this._renderRowItems(row.items)}
                </div>
            </section>
        `).join('');

        // Register focus sections for each row
        rowsData.forEach((row, index) => {
            const rowEl = this.$(`[data-row-index="${index}"]`);

            this.registerFocusSection(`home-row-${index}`, rowEl, {
                orientation: 'horizontal',
                leaveUp: index === 0 ? 'home-header' : `home-row-${index - 1}`,
                leaveDown: index < rowsData.length - 1 ? `home-row-${index + 1}` : null
            });
        });

        // Add click handlers to cards
        container.querySelectorAll('.media-card').forEach(card => {
            card.addEventListener('click', () => {
                const itemId = card.dataset.itemId;
                if (itemId) {
                    router.navigate(`/details/${itemId}`);
                }
            });

            // Focus animation
            card.addEventListener('focus', () => {
                animationManager.focusScale(card, true);
            });
            card.addEventListener('blur', () => {
                animationManager.focusScale(card, false);
            });
        });

        // Set first row as active if content loaded
        if (rowsData.length > 0) {
            this.setActiveSection('home-row-0');
        }
    }

    _renderRowItems(items) {
        return items.map(item => this._renderMediaCard(item)).join('');
    }

    _renderMediaCard(item) {
        // Get primary image URL
        const imageUrl = api.getImageUrl(item.Id, 'Primary', {
            maxWidth: 300,
            tag: item.ImageTags?.Primary
        });

        // Get backdrop for episodes
        const useBackdrop = item.Type === 'Episode';
        const backdropUrl = useBackdrop && item.ParentBackdropItemId
            ? api.getImageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth: 400 })
            : '';

        // Progress bar for resume items
        let progressHtml = '';
        if (item.UserData?.PlaybackPositionTicks && item.RunTimeTicks) {
            const progress = (item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100;
            progressHtml = `<div class="progress-bar"><div class="progress" style="width: ${progress}%"></div></div>`;
        }

        // Episode info
        let subtitleHtml = '';
        if (item.Type === 'Episode') {
            subtitleHtml = `<p class="card-subtitle">S${item.ParentIndexNumber}:E${item.IndexNumber}</p>`;
        }

        return `
            <button class="media-card" data-item-id="${item.Id}" tabindex="0">
                <div class="card-image">
                    <img 
                        src="${useBackdrop ? backdropUrl : imageUrl}" 
                        alt="${item.Name}"
                        loading="lazy"
                        onerror="this.style.visibility='hidden'"
                    >
                    ${progressHtml}
                </div>
                <div class="card-info">
                    <p class="card-title">${item.Name}</p>
                    ${subtitleHtml}
                </div>
            </button>
        `;
    }

    onBack() {
        // Show exit confirmation or go to login
        eventBus.emit('app:exitRequested');
    }
}

export default HomePage;
