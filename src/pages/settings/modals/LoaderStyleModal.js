/**
 * ============================================================================
 * Litefin Tizen - Loading Indicator Style Selection Modal Controller
 * ============================================================================
 * Manages the interactive dialog allowing users to choose their preferred
 * loading spinner animation style:
 * - Left column with list of options and tactile D-pad/hover feedback
 * - Right live preview stage on an isolated glass pedestal
 * - Decoupled preview rendering immune to page-level attribute states
 * - Comprehensive spatial navigation with automatic scroll centering
 * ============================================================================
 */

import { focusManager } from '../../../ui/FocusManager.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { eventBus } from '../../../core/EventBus.js';
import { i18n } from '../../../utils/i18n.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { logger } from '../../../utils/Logger.js';
import { CHECKMARK_SVG } from '../../../utils/Icons.js';

const log = logger.create('LoaderStyleModal');

/**
 * Supported loading animation style definitions.
 */
export const LOADER_STYLES = [
    {
        id: 'dots',
        name: () => i18n.t('LoaderStyleDots') || 'Pulsing Dots',
        description: () => i18n.t('LoaderStyleDotsDesc') || 'Signature multi-dot animation with vibrant theme glow.',
        badge: () => i18n.t('LoaderStyleBadgeModern') || 'Standard'
    },
    {
        id: 'ring',
        name: () => i18n.t('LoaderStyleRing') || 'Rotating Ring',
        description: () => i18n.t('LoaderStyleRingDesc') || 'Lightweight circular ring with minimal GPU & CPU overhead.',
        badge: () => i18n.t('LoaderStyleBadgeEfficient') || 'Lightweight'
    },
    {
        id: 'dual-ring',
        name: () => i18n.t('LoaderStyleDualRing') || 'Dual Ring',
        description: () => i18n.t('LoaderStyleDualRingDesc') || 'Concentric rotating ring with accent outer arc.',
        badge: () => i18n.t('LoaderStyleBadgeDynamic') || 'Dual Arc'
    },
    {
        id: 'orbit',
        name: () => i18n.t('LoaderStyleOrbit') || 'Orbital Bead',
        description: () =>
            i18n.t('LoaderStyleOrbitDesc') || 'Translucent circular path with an orbiting accent satellite point.',
        badge: () => i18n.t('LoaderStyleBadgeOrbit') || 'Planetary'
    },
    {
        id: 'satellite',
        name: () => i18n.t('LoaderStyleSatellite') || 'Satellite Ring',
        description: () =>
            i18n.t('LoaderStyleSatelliteDesc') ||
            'Rotating primary accent frame with an offset secondary orbiting ring.',
        badge: () => i18n.t('LoaderStyleBadgeSatellite') || 'Dual Axis'
    },
    {
        id: 'triple-ring',
        name: () => i18n.t('LoaderStyleTripleRing') || 'Triple Gyro',
        description: () =>
            i18n.t('LoaderStyleTripleRingDesc') ||
            'Multi-tier concentric arcs spinning in alternating counter directions.',
        badge: () => i18n.t('LoaderStyleBadgeTripleRing') || 'Gyroscope'
    },
    {
        id: 'dotted-ring',
        name: () => i18n.t('LoaderStyleDottedRing') || 'Dotted Eclipse',
        description: () =>
            i18n.t('LoaderStyleDottedRingDesc') ||
            'Dual-ring concentric spinner featuring dotted and solid accent strokes.',
        badge: () => i18n.t('LoaderStyleBadgeDottedRing') || 'Dotted'
    },
    {
        id: 'sonar-ring',
        name: () => i18n.t('LoaderStyleSonarRing') || 'Sonar Aperture',
        description: () =>
            i18n.t('LoaderStyleSonarRingDesc') ||
            'Spinning theme-colored disc with opposing high-contrast aperture cutouts.',
        badge: () => i18n.t('LoaderStyleBadgeSonarRing') || 'Aperture'
    },
    {
        id: 'eclipse-sweep',
        name: () => i18n.t('LoaderStyleEclipseSweep') || 'Crescent Sweep',
        description: () =>
            i18n.t('LoaderStyleEclipseSweepDesc') ||
            'Minimalist circular disc illuminated by a traveling inset crescent shadow.',
        badge: () => i18n.t('LoaderStyleBadgeEclipseSweep') || 'Crescent'
    },
    {
        id: 'push-pulse',
        name: () => i18n.t('LoaderStylePushPulse') || 'Push Pulse',
        description: () =>
            i18n.t('LoaderStylePushPulseDesc') ||
            'Interlocking dual spheres expanding and contracting in counter-phase rhythm.',
        badge: () => i18n.t('LoaderStyleBadgePushPulse') || 'Dual Pulse'
    },
    {
        id: 'horizontal-dots',
        name: () => i18n.t('LoaderStyleHorizontalDots') || 'Fading Trio',
        description: () =>
            i18n.t('LoaderStyleHorizontalDotsDesc') ||
            'Horizontal linear dot triad with progressive wave pulse animations.',
        badge: () => i18n.t('LoaderStyleBadgeHorizontalDots') || 'Tri-Dot'
    },
    {
        id: 'pulsing-grid',
        name: () => i18n.t('LoaderStylePulsingGrid') || 'Morphing Grid',
        description: () =>
            i18n.t('LoaderStylePulsingGridDesc') ||
            'Geometric four-quadrant pinwheel that contracts, rotates, and expands.',
        badge: () => i18n.t('LoaderStyleBadgePulsingGrid') || 'Geometric'
    }
];

/**
 * Controller for the Loading Indicator Style selection modal dialog.
 */
export class LoaderStyleModal {
    /**
     * Initializes a new instance of LoaderStyleModal.
     * @param {Object} page Host SettingsPage instance
     */
    constructor(page) {
        this.page = page;
        this._modalFocusChangedHandler = null;
    }

    /**
     * Renders isolated live preview spinner markup for a specific style ID.
     * @param {string} styleId Style identifier
     * @returns {string} Serialized HTML markup for the animated spinner
     */
    renderLoaderPreviewSample(styleId) {
        const sampleClasses = {
            ring: 'loader-preview-sample--ring',
            'dual-ring': 'loader-preview-sample--dual-ring',
            orbit: 'loader-preview-sample--orbit',
            satellite: 'loader-preview-sample--satellite',
            'triple-ring': 'loader-preview-sample--triple-ring',
            'dotted-ring': 'loader-preview-sample--dotted-ring',
            'eclipse-sweep': 'loader-preview-sample--eclipse-sweep',
            'sonar-ring': 'loader-preview-sample--sonar-ring',
            'push-pulse': 'loader-preview-sample--push-pulse',
            'horizontal-dots': 'loader-preview-sample--horizontal-dots',
            'pulsing-grid': 'loader-preview-sample--pulsing-grid',
            dots: 'loader-preview-sample--dots'
        };

        const spinnerElements = {
            ring: '<div class="preview-spinner-ring"></div>',
            'dual-ring': '<div class="preview-spinner-dual-ring"></div>',
            orbit: '<div class="preview-spinner-orbit"></div>',
            satellite: '<div class="preview-spinner-satellite"></div>',
            'triple-ring': '<div class="preview-spinner-triple-ring"></div>',
            'dotted-ring': '<div class="preview-spinner-dotted-ring"></div>',
            'eclipse-sweep': '<div class="preview-spinner-eclipse-sweep"></div>',
            'sonar-ring': '<div class="preview-spinner-sonar-ring"></div>',
            'push-pulse': '<div class="preview-spinner-push-pulse"></div>',
            'horizontal-dots': '<div class="preview-spinner-horizontal-dots"></div>',
            'pulsing-grid': '<div class="preview-spinner-pulsing-grid"></div>',
            dots: '<div class="preview-spinner-dots"></div>'
        };

        const cls = sampleClasses[styleId] || sampleClasses.dots;
        const spinner = spinnerElements[styleId] || spinnerElements.dots;

        return `
            <div class="loader-preview-sample ${cls}">
                ${spinner}
            </div>
        `;
    }

    /**
     * Opens the loading indicator style selection modal.
     */
    open() {
        log.debug('Opening LoaderStyleModal');
        const overlay = this.page ? this.page.$('#modal-overlay') : document.getElementById('modal-overlay');
        if (!overlay) return;

        // Store focus context for seamless restoration upon modal dismissal
        this.page._prevFocus = focusManager.getFocused();
        this.page._prevSection = focusManager.getActiveSection();

        // Materialize localized style objects
        const styles = LOADER_STYLES.map((s) => ({
            id: s.id,
            name: s.name(),
            description: s.description(),
            badge: s.badge()
        }));

        const currentStyle = layoutManager.getLoaderStyle() || 'dots';
        const activeObj = styles.find((s) => s.id === currentStyle) || styles[0];

        overlay.innerHTML = `
            <div class="settings-modal loader-style-modal" role="dialog" aria-modal="true">
                <div class="modal-header loader-style-modal-header">
                    <h2 data-i18n="LabelLoaderStyle">${i18n.t('LabelLoaderStyle') || 'Loading Indicator Style'}</h2>
                    <span class="loader-modal-badge" id="loader-preview-badge">${escapeHtml(activeObj.badge)}</span>
                </div>
                <div class="loader-style-modal-split">
                    <!-- Left Column: Interactive Options List -->
                    <div class="loader-style-options-column" id="modal-loader-options-list">
                        ${styles
                            .map(
                                (s) => `
                            <button class="loader-style-option-btn ${currentStyle === s.id ? 'selected' : ''}" 
                                    data-style="${s.id}"
                                    data-name="${escapeHtml(s.name)}"
                                    data-desc="${escapeHtml(s.description)}"
                                    data-badge="${escapeHtml(s.badge)}"
                                    tabindex="0"
                                    data-focusable="true">
                                <div class="loader-style-option-info">
                                    <span class="loader-style-option-title">${escapeHtml(s.name)}</span>
                                    <span class="loader-style-option-desc">${escapeHtml(s.description)}</span>
                                </div>
                                <span class="loader-style-option-pill">${escapeHtml(s.badge)}</span>
                                <span class="loader-style-check-icon">
                                    ${CHECKMARK_SVG}
                                </span>
                            </button>
                        `
                            )
                            .join('')}
                    </div>

                    <!-- Right Column: Live Animated Preview Stage -->
                    <div class="loader-style-preview-stage">
                        <div class="loader-preview-card" id="loader-preview-card">
                            <div class="loader-preview-pedestal">
                                <div class="loader-preview-spinner-mount" id="loader-preview-spinner-mount">
                                    ${this.renderLoaderPreviewSample(activeObj.id)}
                                </div>
                            </div>
                            <div class="loader-preview-meta">
                                <div class="loader-preview-title" id="loader-preview-title">${escapeHtml(activeObj.name)}</div>
                                <div class="loader-preview-subtitle" id="loader-preview-desc">${escapeHtml(activeObj.description)}</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0" data-i18n="ButtonCancel">${i18n.t('ButtonCancel') || 'Cancel'}</button>
                </div>
            </div>
        `;

        // Reveal modal overlay
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        const previewMount = overlay.querySelector('#loader-preview-spinner-mount');
        const previewTitle = overlay.querySelector('#loader-preview-title');
        const previewDesc = overlay.querySelector('#loader-preview-desc');
        const previewBadge = overlay.querySelector('#loader-preview-badge');

        // Centralized preview updater function
        const updatePreviewForStyle = (styleId, name, desc, badge) => {
            if (previewMount) {
                previewMount.innerHTML = this.renderLoaderPreviewSample(styleId);
            }
            if (previewTitle && name) previewTitle.textContent = name;
            if (previewDesc && desc) previewDesc.textContent = desc;
            if (previewBadge && badge) previewBadge.textContent = badge;
        };

        // Bind interactive event handlers for style option buttons
        overlay.querySelectorAll('.loader-style-option-btn').forEach((btn) => {
            const styleId = btn.dataset.style;
            const name = btn.dataset.name;
            const desc = btn.dataset.desc;
            const badge = btn.dataset.badge;

            const handleFocusOrHover = () => {
                updatePreviewForStyle(styleId, name, desc, badge);
            };

            btn.addEventListener('focus', handleFocusOrHover);
            btn.addEventListener('mouseenter', handleFocusOrHover);

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                layoutManager.setLoaderStyle(styleId);

                // Update settings trigger button label
                if (this.page) {
                    const triggerLabel = this.page.$('#loader-style-btn-label');
                    if (triggerLabel) triggerLabel.textContent = name;
                }

                this.close();
            });
        });

        // Listen for spatial navigation focus updates across styles
        if (this._modalFocusChangedHandler) {
            eventBus.off('focus:changed', this._modalFocusChangedHandler);
        }
        this._modalFocusChangedHandler = (focusedEl) => {
            if (!focusedEl) return;
            const optionBtn = focusedEl.closest ? focusedEl.closest('.loader-style-option-btn') : null;
            if (optionBtn && optionBtn.dataset) {
                if (typeof optionBtn.scrollIntoView === 'function') {
                    optionBtn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
                }
                updatePreviewForStyle(
                    optionBtn.dataset.style,
                    optionBtn.dataset.name,
                    optionBtn.dataset.desc,
                    optionBtn.dataset.badge
                );
            }
        };
        eventBus.on('focus:changed', this._modalFocusChangedHandler);

        // Cancel button dismisses modal
        overlay.querySelector('#btn-modal-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });

        // Register Focus Section for options column
        this.page.registerFocusSection('modal-loader-options', overlay.querySelector('#modal-loader-options-list'), {
            orientation: 'vertical',
            leaveDown: 'modal-actions',
            enterTo: 'last-focused'
        });

        // Register Focus Section for modal actions
        this.page.registerFocusSection('modal-actions', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: 'modal-loader-options',
            onMove: (direction) => {
                if (direction === 'up') {
                    focusManager.setActiveSection('modal-loader-options', true, null, { enterTo: 'last-focused' });
                    return true;
                }
                return false;
            }
        });

        // Set initial focus to currently selected style option
        focusManager.setActiveSection('modal-loader-options');
        setTimeout(() => {
            const activeBtn =
                overlay.querySelector('.loader-style-option-btn.selected') ||
                overlay.querySelector('.loader-style-option-btn');
            if (activeBtn) {
                focusManager.focusElement(activeBtn);
            }
        }, 50);
    }

    /**
     * Closes the loader style modal dialog.
     */
    close() {
        if (this._modalFocusChangedHandler) {
            eventBus.off('focus:changed', this._modalFocusChangedHandler);
            this._modalFocusChangedHandler = null;
        }

        if (this.page && typeof this.page._closeSelectionModal === 'function') {
            this.page._closeSelectionModal();
        }
    }

    /**
     * Cleans up all attached event listeners to prevent memory leaks.
     */
    destroy() {
        if (this._modalFocusChangedHandler) {
            eventBus.off('focus:changed', this._modalFocusChangedHandler);
            this._modalFocusChangedHandler = null;
        }
    }
}

export default LoaderStyleModal;
