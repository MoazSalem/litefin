// Core component class layout from which Litefin components derive.
import Component from '../../core/Component.js';

// Centralized icon store loaded globally to reuse SVG layout definitions.
import { osdIcons } from '../../utils/Icons.js';

// Class level logger for diagnostic output reporting SyncPlay connection signals.
import { logger } from '../../utils/Logger.js';

// Localizer to translates SyncPlay texts.
import { i18n } from '../../utils/i18n.js';

const log = logger.create('SyncPlayNotification');

/**
 * SyncPlayNotification
 *
 * A sleek, Apple-style frosted glass overlay that briefly appears in the
 * center of the screen to notify the user of SyncPlay group actions (e.g.,
 * "User paused", "Waiting for buffering").
 *
 * It auto-hides after a short delay and uses CSS spring animations for
 * a premium feel.
 */
export default class SyncPlayNotification extends Component {
    constructor(parentOsd, options = {}) {
        super(options);
        this._parentOsd = parentOsd;
        
        this._isVisible = false;
        this._hideTimer = null;
        
        // Defaults
        this._displayDuration = 3000;
        
        this._renderBase();
    }

    _renderBase() {
        // Create the container if it doesn't exist
        this._container = document.createElement('div');
        this._container.className = 'osd-syncplay-notification osd-syncplay-hidden';
        
        this._container.innerHTML = `
            <div class="osd-syncplay-notification-glass">
                <div class="osd-syncplay-notification-icon" id="syncPlayNotifIcon">
                    ${osdIcons.group}
                </div>
                <div class="osd-syncplay-notification-text">
                    <div class="osd-syncplay-notification-primary" id="syncPlayNotifPrimary">${i18n.t('SyncPlay')}</div>
                    <div class="osd-syncplay-notification-secondary" id="syncPlayNotifSecondary">${i18n.t('SyncPlay')}</div>
                </div>
            </div>
        `;

        // Cache elements
        this._iconEl = this._container.querySelector('#syncPlayNotifIcon');
        this._primaryTextEl = this._container.querySelector('#syncPlayNotifPrimary');
        this._secondaryTextEl = this._container.querySelector('#syncPlayNotifSecondary');
    }

    render() {
        if (!this._container || this._hasAppended) return;

        // Append to the OSD overlays container
        const overlaysContainer = this._parentOsd._osdEl?.querySelector('.osd-overlays');
        if (overlaysContainer) {
            overlaysContainer.appendChild(this._container);
            this._hasAppended = true;
        } else {
            log.warn('Could not find .osd-overlays to append SyncPlayNotification');
        }
    }

    show(actionType, primaryText, secondaryText = '', durationMs = this._displayDuration) {
        log.debug(`Showing SyncPlay Notification: [${actionType}] ${primaryText} - ${secondaryText}`);
        
        // Ensure it is appended to the DOM before trying to show
        if (!this._hasAppended) {
            this.render();
        }

        // Clear any existing hide timer
        if (this._hideTimer) {
            clearTimeout(this._hideTimer);
            this._hideTimer = null;
        }

        // Set dynamic SVG vector markup based on the actionType trigger.
        let svgIcon = osdIcons.group;
        switch (actionType) {
            case 'play':
            case 'unpause':
                // Use playing indicator for start/resume signals.
                svgIcon = osdIcons.play;
                break;
            case 'pause':
            case 'stop':
                // Pause indicator.
                svgIcon = osdIcons.pause;
                break;
            case 'seek':
                // Fast-forward indicator icon.
                svgIcon = osdIcons.fastForward;
                break;
            case 'buffering':
                // Maintain group alignment during buffering events.
                svgIcon = osdIcons.group;
                break;
            case 'join':
                // Group checkmark fallback structure.
                svgIcon = osdIcons.group || osdIcons.check;
                break;
            case 'leave':
                // Arrow back icon representation representing room egress.
                svgIcon = osdIcons.arrowBack; 
                break;
            default:
                // Universal fallback to group membership.
                svgIcon = osdIcons.group;
                break;
        }

        // Re-inject parsing to ensure the SVG renders cleanly
        this._iconEl.innerHTML = svgIcon;
        
        // Let CSS know about the action type so it can trigger specific animations (like a pulse for buffering)
        this._container.dataset.action = actionType;

        // Set Text
        this._primaryTextEl.textContent = primaryText;
        this._secondaryTextEl.textContent = secondaryText;
        
        // Hide secondary if empty to keep it perfectly centered
        if (!secondaryText) {
            this._secondaryTextEl.classList.add('hide');
        } else {
            this._secondaryTextEl.classList.remove('hide');
        }

        // Trigger animation by removing the hidden class
        // Next frame to ensure CSS transitions re-fire if it was already visible
        requestAnimationFrame(() => {
            this._container.classList.remove('osd-syncplay-hidden');
            this._container.classList.add('osd-syncplay-visible');
            
            // Pop animation reset hack
            this._container.style.animation = 'none';
            this._container.offsetHeight; // force reflow
            this._container.style.animation = null;
        });

        this._isVisible = true;

        // Start auto-hide timer
        if (durationMs > 0) {
            this._hideTimer = setTimeout(() => {
                this.hide();
            }, durationMs);
        }
    }

    /**
     * Hide the notification with a smooth fade out.
     */
    hide() {
        if (!this._isVisible) return;
        
        log.debug('Hiding SyncPlay Notification');
        
        if (this._hideTimer) {
            clearTimeout(this._hideTimer);
            this._hideTimer = null;
        }

        this._container.classList.remove('osd-syncplay-visible');
        this._container.classList.add('osd-syncplay-hidden');
        
        this._isVisible = false;
    }
    
    destroy() {
        if (this._hideTimer) {
            clearTimeout(this._hideTimer);
        }
        if (this._container && this._container.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }
        super.destroy();
    }
}
