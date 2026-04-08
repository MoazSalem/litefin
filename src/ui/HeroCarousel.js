/**
 * ============================================================================
 * Litefin Tizen - Hero Carousel Component
 * ============================================================================
 * A premium auto-scrolling hero section for the HomePage.
 * Handles content rendering, state transitions, and TV focus management.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { router } from '../core/Router.js';

const log = logger.create('HeroCarousel');

class HeroCarousel {
    constructor(options = {}) {
        this._items = options.items || [];
        this._currentIndex = 0;
        this._timer = null;
        this._container = null;
        this._isFocused = false;
        this._autoScrollInterval = 8000; // 8 seconds
        
        // Bindings
        this._handleKeyDown = this._handleKeyDown.bind(this);
        this._handleFocus = this._handleFocus.bind(this);
        this._handleBlur = this._handleBlur.bind(this);
    }

    /**
     * Render the carousel HTML structure
     */
    render() {
        if (!this._items || this._items.length === 0) return '';

        const itemsHtml = this._items.map((item, index) => this._renderItem(item, index)).join('');
        const dotsHtml = this._items.map((_, index) => `<div class="hero-dot ${index === 0 ? 'active' : ''}" data-index="${index}"><div class="hero-dot-progress"></div></div>`).join('');

        return `
            <div id="hero-carousel-container" class="hero-carousel-container focusable" tabindex="0">
                <div class="hero-carousel">
                    <div class="hero-carousel-track">
                        ${itemsHtml}
                    </div>
                    <div class="hero-indicators">
                        ${dotsHtml}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render a single hero item
     * @private
     */
    _renderItem(item, index) {
        const isActive = index === 0;
        
        // Get Backdrop URL
        const backdropUrl = api.getImageUrl(item.Id, 'Backdrop', {
            maxWidth: 1920,
            quality: 80,
            tag: item.ImageTags?.Backdrop
        });

        // Get Logo URL (prefer Logo, then ParentLogo)
        const logoTag = item.ImageTags?.Logo || item.ParentLogoImageTag;
        const logoItemId = item.ImageTags?.Logo ? item.Id : item.ParentLogoItemId || item.SeriesId;
        let logoHtml = '';
        
        if (logoItemId && logoTag) {
            const logoUrl = api.getImageUrl(logoItemId, 'Logo', {
                maxWidth: 800,
                quality: 80,
                tag: logoTag
            });
            logoHtml = `<div class="hero-logo-container"><img src="${logoUrl}" alt="" class="hero-logo"></div>`;
        } else {
            logoHtml = `<h1 class="hero-item-title">${i18n.ensureBiDi(item.Name)}</h1>`;
        }

        // Meta Info Row
        const year = item.ProductionYear || '';
        let runtimeText = '';
        if (item.RunTimeTicks) {
            const totalMinutes = Math.round(item.RunTimeTicks / 600000000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            runtimeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        }
        const rating = item.OfficialRating;
        const starRating = item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : '';

        let metaHtml = '';
        if (year) metaHtml += `<span class="hero-meta-item">${year}</span>`;
        if (runtimeText) metaHtml += `<span class="hero-meta-item">${runtimeText}</span>`;
        if (rating) metaHtml += `<span class="hero-meta-item hero-meta-badge">${rating}</span>`;
        if (starRating) metaHtml += `<span class="hero-meta-item hero-meta-star" style="color: #f5c518; margin-left: 8px;">${starRating}</span>`;

        return `
            <div class="hero-item ${isActive ? 'active' : ''}" data-index="${index}" style="background-image: url('${backdropUrl}')">
                <div class="hero-content">
                    ${logoHtml}
                    <div class="hero-meta-row">
                        ${metaHtml}
                    </div>
                    <p class="hero-description">${i18n.ensureBiDi(item.Overview || '')}</p>
                </div>
            </div>
        `;
    }

    /**
     * Initialize the component after it's in the DOM
     */
    init(el) {
        this._container = el || document.getElementById('hero-carousel-container');
        if (!this._container) return;

        // Event listeners
        this._container.addEventListener('keydown', this._handleKeyDown);
        this._container.addEventListener('focus', this._handleFocus);
        this._container.addEventListener('blur', this._handleBlur);
        this._container.addEventListener('click', () => this._onItemClick());

        // Register with focus manager. We register the parent as the section root
        // so that the carousel container itself is found as a focusable element.
        focusManager.register('home-hero', this._container.parentElement, {
            orientation: 'horizontal',
            leaveDown: null, // Linked dynamically by HomePage
            leaveLeft: 'sidebar'
        });

        // Start auto-scroll
        this._startAutoScroll();
    }

    /**
     * Clean up resources
     */
    destroy() {
        this._stopAutoScroll();
        if (this._container) {
            this._container.removeEventListener('keydown', this._handleKeyDown);
            this._container.removeEventListener('focus', this._handleFocus);
            this._container.removeEventListener('blur', this._handleBlur);
        }
        focusManager.unregister('home-hero');
    }

    /**
     * Start the auto-scroll timer
     * @private
     */
    _startAutoScroll() {
        this._stopAutoScroll();
        if (this._isFocused) return;
        
        this._timer = setInterval(() => {
            this.next();
        }, this._autoScrollInterval);
    }

    /**
     * Stop the auto-scroll timer
     * @private
     */
    _stopAutoScroll() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /**
     * Go to the next item
     */
    next() {
        const nextIndex = (this._currentIndex + 1) % this._items.length;
        this.goTo(nextIndex);
    }

    /**
     * Go to the previous item
     */
    previous() {
        const nextIndex = (this._currentIndex - 1 + this._items.length) % this._items.length;
        this.goTo(nextIndex);
    }

    /**
     * Navigate to a specific item
     */
    goTo(index) {
        if (index === this._currentIndex) return;

        log.debug(`Navigating to hero item ${index}`);
        
        const items = this._container.querySelectorAll('.hero-item');
        const dots = this._container.querySelectorAll('.hero-dot');
        
        // Update classes
        items[this._currentIndex].classList.remove('active');
        dots[this._currentIndex].classList.remove('active');
        
        this._currentIndex = index;
        
        items[this._currentIndex].classList.add('active');
        dots[this._currentIndex].classList.add('active');

        // Restart timer on manual navigation
        if (!this._isFocused) {
            this._startAutoScroll();
        }
    }

    /**
     * Handle item click (Navigate to details)
     * @private
     */
    _onItemClick() {
        const item = this._items[this._currentIndex];
        if (item) {
            router.navigate(`/details/${item.Id}`);
        }
    }

    /**
     * Handle keydown events for manual navigation
     * @private
     */
    _handleKeyDown(e) {
        switch (e.keyCode) {
            case 37: // Left
                if (this._currentIndex > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.previous();
                } else {
                    // Item 0: Fall through to focusManager's leaveLeft (sidebar)
                }
                break;
            case 39: // Right
                if (this._currentIndex < this._items.length - 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.next();
                } else {
                    // Last item: Stay or wrap? User said "returns to previous carousel item", 
                    // which implies standard navigation. I'll block right on last item to prevent accidental sidebar exit if the engine does that.
                    e.preventDefault();
                    e.stopPropagation();
                }
                break;
            case 13: // Enter
                e.preventDefault();
                e.stopPropagation();
                this._onItemClick();
                break;
        }
    }

    /**
     * Handle focus
     * @private
     */
    _handleFocus() {
        this._isFocused = true;
        this._stopAutoScroll();
        this._container.classList.add('focused');
    }

    /**
     * Handle blur
     * @private
     */
    _handleBlur() {
        this._isFocused = false;
        this._container.classList.remove('focused');
        this._startAutoScroll();
    }
}

export default HeroCarousel;
