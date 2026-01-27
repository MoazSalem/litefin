/**
 * ============================================================================
 * Litefin Tizen - Shared Header Component
 * ============================================================================
 * Reusable navigation header with User Avatar and Clock.
 * ============================================================================
 */

import Component from '../core/Component.js';
import { api, auth } from '../api/index.js';
import { router } from '../core/Router.js';

export default class Header extends Component {
    constructor(options = {}) {
        super(options);
        // props.activeTab: 'home' | 'favorites' | null
    }

    render() {
        const activeTab = this.props.activeTab || '';

        return `
            <header class="page-header">
                <div class="header-left">
                    <button class="nav-btn menu-btn icon-only" aria-label="Menu" tabindex="0">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="5" y1="7" x2="19" y2="7"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                            <line x1="5" y1="17" x2="19" y2="17"></line>
                        </svg>
                    </button>
                    <div class="header-logo">
                        <span class="logo-text">Litefin</span>
                    </div>
                </div>
                <nav class="header-mid">
                    <button class="nav-text-btn home-nav-btn ${activeTab === 'home' ? 'active' : ''}" tabindex="0">Home</button>
                    <button class="nav-text-btn favorites-nav-btn ${activeTab === 'favorites' ? 'active' : ''}" tabindex="0">Favorites</button>
                </nav>
                <nav class="header-nav">
                    <button class="nav-btn search-btn icon-only" aria-label="Search" tabindex="0">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="11" cy="11" r="8"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                    </button>
                    <button class="nav-btn user-btn icon-only" aria-label="User Profile" tabindex="0">
                        ${this._renderUserAvatar()}
                    </button>
                    <button class="nav-btn settings-btn icon-only" aria-label="Settings" tabindex="0">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                        </svg>
                    </button>
                    <div class="header-clock"></div>
                </nav>
            </header>
        `;
    }

    onMounted() {
        this._startClock();
        this._bindEvents();
    }

    onDestroyed() {
        if (this._clockInterval) {
            clearInterval(this._clockInterval);
        }
    }

    _bindEvents() {
        // Menu - Sidebar not implemented
        this.el.querySelector('.menu-btn')?.addEventListener('click', () => {
            console.log('Menu clicked');
        });

        // Navigation
        this.el.querySelector('.home-nav-btn')?.addEventListener('click', () => {
            if (this.props.activeTab !== 'home') {
                router.navigate('/');
            }
        });

        this.el.querySelector('.favorites-nav-btn')?.addEventListener('click', () => {
            if (this.props.activeTab !== 'favorites') {
                router.navigate('/favorites');
            }
        });

        this.el.querySelector('.search-btn')?.addEventListener('click', () => router.navigate('/search'));
        this.el.querySelector('.settings-btn')?.addEventListener('click', () => router.navigate('/settings'));
    }

    _renderUserAvatar() {
        const user = auth.getCurrentUser();
        if (!user) return '<span class="icon">👤</span>';

        const imageUrl = user.PrimaryImageTag
            ? api.getUserImageUrl(user.Id, { maxWidth: 100 })
            : '';

        if (imageUrl) {
            return `<img src="${imageUrl}" class="header-avatar" alt="${user.Name}" onerror="this.style.display='none'">`;
        }

        return `<div class="header-avatar-placeholder">${user.Name.charAt(0).toUpperCase()}</div>`;
    }

    _startClock() {
        this._updateClock();
        const now = new Date();
        const delay = (60 - now.getSeconds()) * 1000;
        setTimeout(() => {
            this._updateClock();
            if (this._clockInterval) clearInterval(this._clockInterval);
            this._clockInterval = setInterval(() => this._updateClock(), 60000);
        }, delay);
    }

    _updateClock() {
        const el = this.el.querySelector('.header-clock');
        if (el) {
            const now = new Date();
            let hours = now.getHours();
            const minutes = now.getMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            hours = hours ? hours : 12;
            el.textContent = `${hours}:${minutes} ${ampm}`;
        }
    }
}
