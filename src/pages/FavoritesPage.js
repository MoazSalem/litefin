
import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';

class FavoritesPage extends Page {
    constructor() {
        super();
        this.title = 'Favorites';
    }

    render() {
        return `
            <div class="page favorites-page">
                <header class="page-header">
                    <div class="header-left">
                        <div class="header-logo">
                            <span class="logo-text">Litefin</span>
                        </div>
                    </div>
                    <nav class="header-mid">
                        <button class="nav-text-btn home-nav-btn" tabindex="0">Home</button>
                        <button class="nav-text-btn favorites-nav-btn active" tabindex="0">Favorites</button>
                    </nav>
                    <nav class="header-nav">
                        <button class="nav-btn search-btn icon-only" aria-label="Search" tabindex="0">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                        </button>
                        <button class="nav-btn user-btn icon-only" aria-label="User Profile" tabindex="0">
                            <span class="icon">👤</span> 
                        </button>
                        <button class="nav-btn settings-btn icon-only" aria-label="Settings" tabindex="0">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                        </button>
                    </nav>
                </header>
                <div class="page-content">
                    <h2 class="section-title">Your Favorites</h2>
                    <div class="favorites-grid" id="favorites-grid">
                        <div class="loading-spinner"></div>
                    </div>
                </div>
            </div>
        `;
    }

    async onInit() {
        this._bindNavigation();
        await this._loadFavorites();
    }

    _bindNavigation() {
        this.$('.home-nav-btn')?.addEventListener('click', () => router.navigate('/'));
        this.$('.favorites-nav-btn')?.addEventListener('click', () => { }); // Already here
        this.$('.search-btn')?.addEventListener('click', () => router.navigate('/search'));
        this.$('.settings-btn')?.addEventListener('click', () => router.navigate('/settings'));

        // Register focus
        this.registerFocusSection('header', this.$('.page-header'), {
            orientation: 'horizontal',
            leaveDown: 'favorites-grid'
        });

        this.setActiveSection('header');
    }

    async _loadFavorites() {
        // Todo: Implement fetching favorites
        // api.getItems({ Filters: 'IsFavorite' }) ...
        const container = this.$('#favorites-grid');
        if (container) container.innerHTML = '<p style="padding: 20px; color: #aaa;">Favorites content coming soon...</p>';
    }
}

export default FavoritesPage;
