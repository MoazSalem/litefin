/**
 * ============================================================================
 * Litefin Tizen - Toast Notification
 * ============================================================================
 * Simple auto-dismiss toast notifications for real-time feedback.
 * Positioned bottom-left per user preference.
 * ============================================================================
 */

// ============================================================================
// Toast Class
// ============================================================================

class Toast {
    constructor() {
        // Container for toast messages
        this._container = null;

        // Queue of active toasts
        this._toasts = [];

        // Maximum concurrent toasts
        this._maxToasts = 3;
    }

    /**
     * Initialize toast container
     * Creates the DOM container if it doesn't exist
     * @private
     */
    _ensureContainer() {
        if (this._container) return;

        // Create container
        this._container = document.createElement('div');
        this._container.className = 'toast-container';
        this._container.setAttribute('aria-live', 'polite');
        this._container.setAttribute('aria-atomic', 'true');

        // ================================================================
        // TIZEN FIX: Apply inline styles directly for maximum compatibility
        // Tizen's older Chromium may have issues with stylesheet parsing
        // ================================================================
        const cs = this._container.style;
        cs.cssText = `
            position: fixed !important;
            bottom: 40px !important;
            left: 40px !important;
            z-index: 2147483647 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 12px;
            pointer-events: none !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;

        // Append to body
        document.body.appendChild(this._container);

        // Inject styles if not already present
        this._injectStyles();
    }

    /**
     * Inject toast styles into document
     * @private
     */
    _injectStyles() {
        if (document.getElementById('toast-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'toast-styles';
        // ============================================================
        // TIZEN FIX: Using !important and explicit values to force
        // visibility on Tizen's older Chromium engine
        // ============================================================
        styles.textContent = `
            /* ============================================================ */
            /* Toast Container - Bottom Left                                */
            /* ============================================================ */
            /* CRITICAL: z-index 99999 ensures toast appears above player   */
            /* and OSD layers on Tizen. Using !important for Tizen.         */
            .toast-container {
                position: fixed !important;
                bottom: 40px !important;
                left: 40px !important;
                z-index: 2147483647 !important;
                display: -webkit-flex !important;
                display: flex !important;
                -webkit-flex-direction: column !important;
                flex-direction: column !important;
                gap: 12px;
                pointer-events: none !important;
                visibility: visible !important;
                opacity: 1 !important;
            }

            /* ============================================================ */
            /* Individual Toast                                             */
            /* ============================================================ */
            /* Using solid background - backdrop-filter not supported on    */
            /* Tizen 4's Chromium 56. Starting with opacity:1 for compat.   */
            .toast {
                display: -webkit-flex !important;
                display: flex !important;
                -webkit-align-items: center !important;
                align-items: center !important;
                gap: 12px;
                padding: 16px 24px !important;
                background: #1a1a1a !important;
                border-radius: 12px !important;
                border: 2px solid rgba(255, 255, 255, 0.3) !important;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8) !important;
                color: #ffffff !important;
                font-size: 16px !important;
                font-weight: 500 !important;
                line-height: 1.4 !important;
                max-width: 400px !important;
                min-width: 200px !important;
                pointer-events: auto !important;
                opacity: 1 !important;
                visibility: visible !important;
                -webkit-transform: translateX(0) !important;
                transform: translateX(0) !important;
                -webkit-animation: toast-slide-in 0.3s ease-out !important;
                animation: toast-slide-in 0.3s ease-out !important;
            }

            /* Slide in from left */
            @-webkit-keyframes toast-slide-in {
                from {
                    -webkit-transform: translateX(-120%);
                    transform: translateX(-120%);
                    opacity: 0;
                }
                to {
                    -webkit-transform: translateX(0);
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            @keyframes toast-slide-in {
                from {
                    -webkit-transform: translateX(-120%);
                    transform: translateX(-120%);
                    opacity: 0;
                }
                to {
                    -webkit-transform: translateX(0);
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            /* Slide out to left */
            @-webkit-keyframes toast-slide-out {
                from {
                    -webkit-transform: translateX(0);
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    -webkit-transform: translateX(-120%);
                    transform: translateX(-120%);
                    opacity: 0;
                }
            }
            @keyframes toast-slide-out {
                from {
                    -webkit-transform: translateX(0);
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    -webkit-transform: translateX(-120%);
                    transform: translateX(-120%);
                    opacity: 0;
                }
            }

            .toast.toast-exit {
                -webkit-animation: toast-slide-out 0.25s ease-in forwards !important;
                animation: toast-slide-out 0.25s ease-in forwards !important;
            }

            /* ============================================================ */
            /* Toast Icon                                                   */
            /* ============================================================ */
            .toast-icon {
                -webkit-flex-shrink: 0;
                flex-shrink: 0;
                width: 24px;
                height: 24px;
                fill: currentColor;
                opacity: 0.8;
            }

            /* ============================================================ */
            /* Toast Text                                                   */
            /* ============================================================ */
            .toast-text {
                -webkit-flex: 1;
                flex: 1;
                word-wrap: break-word;
            }
        `;
        document.head.appendChild(styles);
        console.log('[Toast] Styles injected');
    }

    /**
     * Show a toast notification
     * @param {string} message - Message to display
     * @param {number} [duration=5000] - Auto-dismiss duration in ms (0 = no auto-dismiss)
     * @param {Object} [options] - Additional options
     * @param {string} [options.icon] - SVG icon HTML
     */
    show(message, duration = 5000, options = {}) {
        this._ensureContainer();

        // Remove oldest toast if at max
        if (this._toasts.length >= this._maxToasts) {
            this._removeToast(this._toasts[0]);
        }

        // Create toast element
        const toastEl = document.createElement('div');
        toastEl.className = 'toast';

        // ================================================================
        // TIZEN FIX: Apply inline styles directly to ensure visibility
        // ================================================================
        toastEl.style.cssText = `
            display: flex !important;
            align-items: center !important;
            gap: 12px;
            padding: 16px 24px !important;
            background: #1a1a1a !important;
            border-radius: 12px !important;
            border: 2px solid rgba(255, 255, 255, 0.3) !important;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8) !important;
            color: #ffffff !important;
            font-size: 16px !important;
            font-weight: 500 !important;
            line-height: 1.4 !important;
            max-width: 400px !important;
            min-width: 200px !important;
            pointer-events: auto !important;
            opacity: 1 !important;
            visibility: visible !important;
        `;

        // Add icon if provided
        if (options.icon) {
            const iconEl = document.createElement('div');
            iconEl.className = 'toast-icon';
            iconEl.innerHTML = options.icon;
            toastEl.appendChild(iconEl);
        }

        // Add message text
        const textEl = document.createElement('div');
        textEl.className = 'toast-text';
        textEl.textContent = message;
        toastEl.appendChild(textEl);

        // Add to container
        this._container.appendChild(toastEl);
        this._toasts.push(toastEl);

        // Auto-dismiss after duration
        if (duration > 0) {
            setTimeout(() => {
                this._removeToast(toastEl);
            }, duration);
        }

        return toastEl;
    }

    /**
     * Remove a toast with animation
     * @param {HTMLElement} toastEl - Toast element to remove
     * @private
     */
    _removeToast(toastEl) {
        if (!toastEl || !toastEl.parentNode) return;

        // Add exit animation class
        toastEl.classList.add('toast-exit');

        // Remove after animation
        setTimeout(() => {
            if (toastEl.parentNode) {
                toastEl.parentNode.removeChild(toastEl);
            }
            const idx = this._toasts.indexOf(toastEl);
            if (idx >= 0) {
                this._toasts.splice(idx, 1);
            }
        }, 250); // Match animation duration
    }

    /**
     * Clear all toasts
     */
    clear() {
        this._toasts.forEach(t => this._removeToast(t));
    }
}

// ============================================================================
// Export Singleton
// ============================================================================

export const toast = new Toast();
export default Toast;
