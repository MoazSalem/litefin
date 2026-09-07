import BaseMenu from './BaseMenu.js';
import { auth } from '../../api/index.js';
import { api } from '../../api/ApiClient.js';
import { i18n } from '../../utils/i18n.js';
import { imageService } from '../../utils/ImageService.js';
import { pinDialog } from '../../ui/PinDialog.js';
import { pinManager } from '../../utils/PinManager.js';

export default class ResumeProfilesMenu extends BaseMenu {
    constructor(osdController) {
        super(osdController);
        this._onSelect = null;
        this._buttons = [];
    }

    open(onSelect) {
        this._onSelect = onSelect;
        this.focusIndex = 0;
        this.render();
        this.show();
    }

    render() {
        if (!this.$el) {
            this.$el = document.createElement('div');
            this.$el.className = 'resume-profiles-overlay';
            document.body.appendChild(this.$el);
            this.$el.addEventListener('click', (event) => {
                const card = event.target.closest?.('.resume-profile-card');
                if (card) this._select(card.dataset.userid);
            });
        }

        const sessions = auth.getSessions();
        this.$el.innerHTML = `
            <div class="resume-profiles-panel" role="dialog" aria-modal="true">
                <h1>${i18n.t('HeaderWhoIsWatching')}</h1>
                <div class="resume-profiles-grid">
                    ${sessions.map((session) => this._renderCard(session)).join('')}
                </div>
            </div>
        `;
        this._buttons = Array.from(this.$el.querySelectorAll('.resume-profile-card'));
    }

    _renderCard(session) {
        const initial = (session.userName || '?').charAt(0).toUpperCase();
        let avatar = `<div class="profiles-card-initial">${initial}</div>`;
        if (session.primaryImageTag) {
            const params = imageService.getParams('avatar');
            const url = api.getUserImageUrl(session.userId, {
                maxWidth: params.maxWidth,
                quality: params.quality
            });
            avatar = `<img class="profiles-card-avatar" src="${url}" alt="">`;
        }
        return `
            <div class="profiles-profile-item">
                <button class="profiles-card resume-profile-card" data-userid="${session.userId}" tabindex="0">
                    ${avatar}
                </button>
                <span class="profiles-card-name">${session.userName || session.userId}</span>
            </div>
        `;
    }

    handleKey(key) {
        if (!this.isVisible) return false;
        if (key === 'left' && this.focusIndex > 0) this.focusIndex--;
        else if (key === 'right' && this.focusIndex < this._buttons.length - 1) this.focusIndex++;
        else if (key === 'enter') this._select(this._buttons[this.focusIndex]?.dataset.userid);
        else if (key === 'back') return true;
        else return ['up', 'down'].includes(key);
        this.updateFocus();
        return true;
    }

    updateFocus() {
        this._buttons.forEach((button, index) => button.classList.toggle('focused', index === this.focusIndex));
        this._buttons[this.focusIndex]?.focus();
    }

    _select(userId, pinVerified = false) {
        if (!userId || !this._onSelect) return;
        const currentUserId = auth.getCurrentUser()?.Id;
        if (userId !== currentUserId && !pinVerified && pinManager.hasPin(userId)) {
            pinDialog.show({
                mode: 'verify',
                userId,
                title: i18n.t('EnterPin') || 'Enter PIN',
                onSuccess: () => this._select(userId, true)
            });
            return;
        }
        this._onSelect(userId);
    }
}
