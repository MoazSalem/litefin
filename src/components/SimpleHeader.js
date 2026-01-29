/**
 * ============================================================================
 * Litefin Tizen - Simple Header Component
 * ============================================================================
 * Reusable navigation header for Detail sections (Back / Home).
 * ============================================================================
 */

import Component from '../core/Component.js';
import { router } from '../core/Router.js';

class SimpleHeader extends Component {
    constructor(config = {}) {
        super(config);

        this.id = config.id || 'simple-header';
        this.className = config.className || 'nav-header media-row';
        this.parentId = config.parentId || null; // For focus management hooks if needed
    }

    render() {
        return `
            <div class="${this.className}" id="${this.id}">
                <button class="btn btn-icon" id="${this.id}-btn-back" tabindex="0" aria-label="Back">
                    <!-- Arrow Left SVG -->
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="32" height="32">
                        <line x1="19" y1="12" x2="5" y2="12"></line>
                        <polyline points="12 19 5 12 12 5"></polyline>
                    </svg>
                </button>
                <button class="btn btn-icon" id="${this.id}-btn-home" tabindex="0" aria-label="Home">
                    <!-- Home SVG -->
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="30" height="30">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                        <polyline points="9 22 9 12 15 12 15 22"></polyline>
                    </svg>
                </button>
                <div class="header-title" id="${this.id}-title" style="margin-left: 20px; font-size: 1.5rem; font-weight: 600; opacity: 0; transition: opacity 0.3s;"></div>
            </div>
        `;
    }

    onMounted() {
        const backBtn = document.getElementById(`${this.id}-btn-back`);
        const homeBtn = document.getElementById(`${this.id}-btn-home`);

        if (backBtn) {
            backBtn.onclick = () => router.back();
        }

        if (homeBtn) {
            homeBtn.onclick = () => router.navigate('/');
        }
    }

    /**
     * Set the header title
     * @param {string} title 
     */
    setTitle(title) {
        const titleEl = document.getElementById(`${this.id}-title`);
        if (titleEl) {
            titleEl.textContent = title;
            titleEl.style.opacity = title ? '1' : '0';
        }
    }
}

export default SimpleHeader;
