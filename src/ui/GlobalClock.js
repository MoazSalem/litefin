/**
 * ============================================================================
 * Litefin Tizen - Global Clock Manager
 * ============================================================================
 * Manages a persistent clock display that stays above all other UI elements,
 * including screensavers. Respects user 12h/24h preferences and RTL.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('GlobalClock');

class GlobalClock {
    constructor() {
        this._element = null;
        this._timer = null;
        this._isVisible = true; // Always visible by default
    }

    /**
     * Initialize the global clock
     */
    init() {
        if (this._element) return;

        log.info('Initializing Global Clock...');

        // 1. Create the clock element
        this._element = document.createElement('div');
        this._element.id = 'global-clock';
        this._element.className = 'global-clock';
        
        // 2. Wrap in a high-level container to stay above ALL other UI
        // We inject it directly into body to bypass any relative containers.
        document.body.appendChild(this._element);

        // 3. Initial update
        this.update();

        // 4. Start update timer (on the minute boundary for accuracy)
        this._startTimer();

        // 5. Listen for setting changes
        // 'pref:timeFormat' is the key in PlayerSettings, so it might emit 'pref:timeFormat'
        eventBus.on('pref:timeFormat', () => {
            log.debug('Time format changed, updating clock...');
            this.update();
        });

        // Toggle visibility based on player states if needed
        // For now, we follow the "global" requirement.
    }

    /**
     * Update the clock display text
     */
    update() {
        if (!this._element) return;

        const timeFormat = PlayerSettings.get('timeFormat') || '12h';
        const is24h = timeFormat === '24h' || timeFormat === '24';

        const now = new Date();
        const timeString = now.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
            hour12: !is24h
        });

        // Use a sleek format: 10:45 PM or 22:45
        this._element.textContent = timeString;
    }

    /**
     * Start the interval to update time
     * @private
     */
    _startTimer() {
        if (this._timer) clearInterval(this._timer);

        // Update every 30 seconds to minimize drift while staying efficient.
        this._timer = setInterval(() => this.update(), 30000);
    }

    /**
     * Show or hide the global clock
     * @param {boolean} visible 
     */
    setVisibility(visible) {
        this._isVisible = visible;
        if (this._element) {
            this._element.style.display = visible ? '' : 'none';
        }
    }
}

// Export singleton instance
export const globalClock = new GlobalClock();
export default globalClock;
