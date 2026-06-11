/**
 * ============================================================================
 * Litefin Tizen - Black Screensaver
 * ============================================================================
 * Displays a completely black screen to minimize light output and power
 * consumption on OLED/Plasma displays.
 * ============================================================================
 */

export class BlackScreensaver {
    constructor() {
        this.name = 'BlackScreensaver';
        this.id = 'blackscreensaver';
        this._container = null;
    }

    /**
     * Show the black screensaver
     * Creates a full-screen black overlay to ensure total darkness
     */
    show() {
        if (!this._container) {
            // Create the container element that will cover the entire viewport
            this._container = document.createElement('div');
            this._container.className = 'black-screensaver';

            // Append to the body so it sits on top of everything
            document.body.appendChild(this._container);

            // Accessibility: make it clear this is a screensaver if read by a screen reader
            this._container.setAttribute('role', 'presentation');
            this._container.setAttribute('aria-hidden', 'true');
        }
    }

    /**
     * Hide the black screensaver
     * Removes the element with a simple fade-out animation if supported
     * @returns {Promise<void>}
     */
    hide() {
        if (this._container) {
            return new Promise((resolve) => {
                const onAnimationFinish = () => {
                    // Safety check to ensure container still exists and is attached
                    if (this._container && this._container.parentNode) {
                        this._container.parentNode.removeChild(this._container);
                    }
                    this._container = null;
                    resolve();
                };

                // Perform a simple fade-out to make the transition back to the app smoother
                if (this._container.animate) {
                    const animation = this._container.animate([{ opacity: '1' }, { opacity: '0' }], {
                        duration: 400,
                        easing: 'ease-out'
                    });
                    animation.onfinish = onAnimationFinish;
                } else {
                    // Fallback for environments without the Web Animations API
                    onAnimationFinish();
                }
            });
        }

        return Promise.resolve();
    }
}
