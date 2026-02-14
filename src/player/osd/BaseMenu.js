import { logger } from '../../utils/Logger.js';

/**
 * BaseMenu
 * 
 * Abstract base class for all OSD menus and overlays.
 * Provides standard methods for:
 * - Initialization and reference to the OSDController.
 * - Toggling visibility.
 * - Handling key events (must be implemented by subclasses to return true if handled).
 * - Rendering (optional skeleton).
 */
export default class BaseMenu {
    constructor(osdController) {
        this.osd = osdController;
        this.player = osdController.player; // Convenience access
        this.log = logger.create(this.constructor.name);
        
        this.$el = null;
        this.isVisible = false;
        this.focusIndex = 0;
        this.isModal = true; // Default to modal (full-screen overlay)
    }

    destroy() {
        if (this.$el) {
            this.$el.remove();
            this.$el = null;
        }
    }

    // Explicit show/hide managing visibility class
    show() {
        this.isVisible = true;
        if (this.$el) {
            this.$el.classList.add('visible');
            this.updateFocus();
        }
        // Tell OSD to stop auto-hiding while menu is open?
        // OSDController handles this via activeMenu check
    }

    hide() {
        this.isVisible = false;
        if (this.$el) {
            this.$el.classList.remove('visible');
        }
    }

    handleKey(key) {
        return false;
    }

    updateFocus() {
        // Implement in subclass
    }
}
