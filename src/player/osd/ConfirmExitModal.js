/**
 * ============================================================================
 * ConfirmExitModal
 * ============================================================================
 * Modal confirmation dialog shown when pressing Back to exit playback.
 * Extends BaseMenu to integrate seamlessly with OSDController lifecycle
 * and focus management.
 * ============================================================================
 */

import BaseMenu from "./BaseMenu.js";
import { i18n } from "../../utils/i18n.js";

export default class ConfirmExitModal extends BaseMenu {
    /**
     * Initializes the modal instance with references to the controller.
     * @param {Object} osdController
     */
    constructor(osdController) {
        super(osdController);
        this.isModal = true;
        this.focusIndex = 0; // 0: Cancel (safe default), 1: Exit
        this._openedAt = 0;
        this._wasPlaying = false;
    }

    /**
     * Open and display the confirmation modal.
     */
    open() {
        this.focusIndex = 0; // Reset focus to Cancel by default

        // Pause playback if currently playing
        const player = this.osd.player;
        this._wasPlaying = player && !player.isPaused();
        if (this._wasPlaying && player.pause) {
            player.pause();
        }

        this.render();

        // Reveal the overlay
        this.show();

        // Lock out immediate Enter key bounces on opening
        this._openedAt = Date.now();

        // Apply visual focus to the initial action button
        requestAnimationFrame(() => {
            this.updateFocus();
        });
    }

    /**
     * Render the modal DOM and append it inside .osd-overlays.
     */
    render() {
        if (this.$el) {
            this.$el.remove();
            this.$el = null;
        }

        const overlay = document.createElement("div");
        overlay.className = "modal-overlay confirm-exit-overlay";

        const titleText = i18n.t("ConfirmExitPlayerTitle") || "Exit Playback?";
        const messageText = i18n.t("ConfirmExitPlayerMessage") || "Are you sure you want to stop playback and exit?";
        const cancelText = i18n.t("ButtonCancel") || "Cancel";
        const exitText = i18n.t("ButtonExit") || i18n.t("Exit") || "Exit";

        overlay.innerHTML = `
            <div class="settings-modal confirm-exit-modal" role="dialog" aria-modal="true" aria-label="${titleText}">
                <div class="modal-header confirm-exit-header">
                    <h2>${titleText}</h2>
                </div>
                <div class="confirm-exit-body">
                    <p class="confirm-exit-message">${messageText}</p>
                </div>
                <div class="modal-actions confirm-exit-actions" id="confirm-exit-actions">
                    <button type="button" class="modal-action-btn focusable confirm-exit-cancel" data-index="0" tabindex="0">
                        ${cancelText}
                    </button>
                    <button type="button" class="modal-action-btn danger-btn focusable confirm-exit-confirm" data-index="1" tabindex="0">
                        ${exitText}
                    </button>
                </div>
            </div>
        `;

        // Click on Cancel
        const cancelBtn = overlay.querySelector(".confirm-exit-cancel");
        if (cancelBtn) {
            cancelBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._onCancel();
            });
        }

        // Click on Exit
        const exitBtn = overlay.querySelector(".confirm-exit-confirm");
        if (exitBtn) {
            exitBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._onConfirmExit();
            });
        }

        // Dismiss on backdrop click
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                e.stopPropagation();
                this._onCancel();
            }
        });

        const overlaysEl = this.osd._osdEl?.querySelector(".osd-overlays") || document.body;
        overlaysEl.appendChild(overlay);

        this.$el = overlay;
    }

    /**
     * Handle key input when modal is open.
     * @param {string} key
     * @returns {boolean}
     */
    handleKey(key) {
        if (!this.isVisible) return false;

        switch (key) {
            case "left":
            case "right":
                // Toggle between Cancel (0) and Exit (1)
                this.focusIndex = this.focusIndex === 0 ? 1 : 0;
                this.updateFocus();
                return true;

            case "enter":
                // Debounce rapid key triggers
                if (Date.now() - this._openedAt < 300) {
                    return true;
                }
                if (this.focusIndex === 1) {
                    this._onConfirmExit();
                } else {
                    this._onCancel();
                }
                return true;

            case "back":
                // Back safely dismisses the confirmation and returns to playback
                this._onCancel();
                return true;

            default:
                // Consume all other directional keys while modal is active
                return true;
        }
    }

    /**
     * Update focus state on modal action buttons.
     */
    updateFocus() {
        if (!this.$el) return;

        const buttons = this.$el.querySelectorAll(".confirm-exit-actions .modal-action-btn");
        buttons.forEach((btn, idx) => {
            if (idx === this.focusIndex) {
                btn.classList.add("focused");
                btn.focus();
            } else {
                btn.classList.remove("focused");
            }
        });
    }

    /**
     * Safe cancellation: Close modal and restore OSD visibility.
     * @private
     */
    _onCancel() {
        // Resume playback if it was playing prior to opening the dialog
        const player = this.osd.player;
        if (this._wasPlaying && player) {
            if (player.unpause) {
                player.unpause();
            } else if (player.play) {
                player.play();
            }
        }
        this._wasPlaying = false;
        this.osd.closeMenu();
    }

    /**
     * Confirmed exit: Stop playback and navigate away.
     * @private
     */
    _onConfirmExit() {
        this.hide();
        this.destroy();
        if (this.osd.activeMenu === this) {
            this.osd.activeMenu = null;
        }
        // Dispatch confirmed exit to OSDController
        this.osd.exitPlayerConfirmed();
    }
}
