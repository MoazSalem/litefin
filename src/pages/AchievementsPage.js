import Page from './Page.js';
import { api } from '../api/index.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import '../styles/achievements.css';

const log = logger.create('AchievementsPage');

const GAME_TEXT = {
    ru: {
        game: 'Игровой центр', arsenal: 'Арсенал', shop: 'Магазин', cosmetics: 'Косметика', gifts: 'Подарить очки',
        scoreBank: 'Доступно очков', spent: 'Потрачено всего', loadingGame: 'Загружаем игровые данные…',
        arsenalEmpty: 'Пока нет усилений. Их можно приобрести в магазине за очки.',
        shopIntro: 'Покупай усиления и оформление профиля за заработанные очки.',
        cosmeticsIntro: 'Твои предметы. Выбирай, что показывать в профиле.',
        giftIntro: 'Передай часть своих очков другому пользователю этого Jellyfin-сервера.',
        noCosmetics: 'Пока нет косметических предметов. Загляни в магазин.',
        buy: 'Купить', owned: 'Уже куплено', equipped: 'Установлено', equip: 'Применить', use: 'Активировать',
        active: 'Активно', quantity: 'Количество', price: 'Цена', score: 'очков',
        automatic: 'Срабатывает автоматически, когда это необходимо.',
        recipient: 'Получатель', chooseUser: 'Выбери пользователя', amount: 'Сколько очков передать',
        sendGift: 'Передать очки', usersLoading: 'Загружаем список пользователей…', noUsers: 'Нет доступных получателей.',
        questReroll: 'Обновить задания', rerollUsed: 'Обновление использовано', rerollLeft: 'Осталось: 1',
        confirmBuy: 'Купить «{name}» за {price} очков?', confirmUse: 'Активировать «{name}»?',
        confirmEquip: 'Применить «{name}»?', confirmGift: 'Передать {amount} очков пользователю «{name}»?',
        confirmReroll: 'Заменить все текущие {period} задания? Старые задания будут потеряны.',
        daily: 'ежедневные', weekly: 'еженедельные', purchaseOk: 'Покупка выполнена.', useOk: 'Усиление активировано.',
        equipOk: 'Предмет применён.', giftOk: 'Очки переданы.', rerollOk: 'Задания обновлены.',
        actionFailed: 'Не удалось выполнить действие.', notEnough: 'Недостаточно очков.', milestone: 'Откроется за достижения прогресса',
        activeUntil: 'Действует до', loadingUsers: 'Список пользователей загружается…',
        shopPowerups: 'Усиления', shopCosmetics: 'Оформление профиля',
        inventory: 'В инвентаре', balance: 'Баланс', viewShop: 'Перейти в магазин'
    },
    en: {
        game: 'Game Center', arsenal: 'Arsenal', shop: 'Shop', cosmetics: 'Cosmetics', gifts: 'Gift score',
        scoreBank: 'Available score', spent: 'Total spent', loadingGame: 'Loading game data…',
        arsenalEmpty: 'No power-ups yet. Buy some in the shop with your score.',
        shopIntro: 'Spend earned score on power-ups and profile cosmetics.',
        cosmeticsIntro: 'Your owned items. Choose what to show on your profile.',
        giftIntro: 'Send some of your score to another user on this Jellyfin server.',
        noCosmetics: 'No cosmetics yet. Visit the shop.',
        buy: 'Buy', owned: 'Owned', equipped: 'Equipped', equip: 'Equip', use: 'Activate',
        active: 'Active', quantity: 'Quantity', price: 'Price', score: 'score',
        automatic: 'Consumed automatically when needed.',
        recipient: 'Recipient', chooseUser: 'Choose a user', amount: 'Score amount',
        sendGift: 'Send score', usersLoading: 'Loading users…', noUsers: 'No recipients available.',
        questReroll: 'Reroll quests', rerollUsed: 'Reroll used', rerollLeft: 'Remaining: 1',
        confirmBuy: 'Buy “{name}” for {price} score?', confirmUse: 'Activate “{name}”?',
        confirmEquip: 'Equip “{name}”?', confirmGift: 'Send {amount} score to “{name}”?',
        confirmReroll: 'Replace all current {period} quests? The old quests will be lost.',
        daily: 'daily', weekly: 'weekly', purchaseOk: 'Purchase completed.', useOk: 'Power-up activated.',
        equipOk: 'Item equipped.', giftOk: 'Score sent.', rerollOk: 'Quests rerolled.',
        actionFailed: 'The action could not be completed.', notEnough: 'Not enough score.', milestone: 'Unlocked through progress milestones',
        activeUntil: 'Active until', loadingUsers: 'Loading user list…',
        shopPowerups: 'Power-ups', shopCosmetics: 'Profile cosmetics',
        inventory: 'In inventory', balance: 'Balance', viewShop: 'Open shop'
    }
};

function gameText(key, replacements = {}) {
    const language = String((typeof document !== 'undefined' && document.documentElement.lang) || 'en').toLowerCase();
    const dictionary = language.startsWith('ru') ? GAME_TEXT.ru : GAME_TEXT.en;
    let text = dictionary[key] || GAME_TEXT.en[key] || key;
    Object.keys(replacements).forEach((name) => {
        text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(replacements[name]));
    });
    return text;
}

function arrayOf(object, ...keys) {
    const value = valueOf(object, ...keys);
    return Array.isArray(value) ? value : [];
}

function cosmeticKindLabel(kind) {
    const ru = String((typeof document !== 'undefined' && document.documentElement.lang) || 'en').toLowerCase().startsWith('ru');
    const labels = ru
        ? { ProfileTheme: 'Тема профиля', BadgeFrame: 'Рамка значка', RankTitle: 'Титул', Avatar: 'Аватар', Background: 'Фон', ProfileBorder: 'Рамка профиля' }
        : { ProfileTheme: 'Profile theme', BadgeFrame: 'Badge frame', RankTitle: 'Rank title', Avatar: 'Avatar', Background: 'Background', ProfileBorder: 'Profile border' };
    return labels[kind] || kind || (ru ? 'Предмет' : 'Item');
}

function cosmeticEquipField(kind) {
    return ({
        ProfileTheme: 'EquippedThemeId', BadgeFrame: 'EquippedBadgeFrameId',
        RankTitle: 'EquippedCustomTitleId', Avatar: 'EquippedAvatarId',
        Background: 'EquippedBackgroundId', ProfileBorder: 'EquippedProfileBorderId'
    })[kind] || '';
}

function valueOf(object, ...keys) {
    if (!object) return undefined;
    for (const key of keys) {
        if (object[key] !== undefined && object[key] !== null) return object[key];
    }
    return undefined;
}

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function badgeIcon(badge) {
    const icon = String(valueOf(badge, 'Icon', 'icon') || '').trim();
    if (icon && icon.length <= 4 && !/^[a-z0-9_ -]+$/i.test(icon)) return icon;

    const key = icon.toLowerCase();
    const known = {
        military_tech: '🏅',
        trophy: '🏆',
        movie: '🎬',
        live_tv: '📺',
        whatshot: '🔥',
        schedule: '⏱️',
        star: '⭐',
        local_movies: '🎞️',
        music_note: '🎵',
        menu_book: '📚',
        videogame_asset: '🎮',
        public: '🌍',
        calendar_month: '📅'
    };
    if (known[key]) return known[key];

    const category = String(valueOf(badge, 'Category', 'category') || '').toLowerCase();
    if (category.includes('music')) return '🎵';
    if (category.includes('book')) return '📚';
    if (category.includes('game')) return '🎮';
    if (category.includes('series') || category.includes('episode')) return '📺';
    if (category.includes('film') || category.includes('movie')) return '🎬';
    return '🏆';
}

function progressPercent(current, target) {
    const goal = Number(target) || 0;
    if (goal <= 0) return 0;
    return Math.max(0, Math.min(100, (Number(current) || 0) / goal * 100));
}

class AchievementsPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('Achievements');
        this._isAsyncPage = true;
        this._filter = 'all';
        this._visibleBadgeCount = 24;
        this._data = null;
        this._loading = false;
        this._userId = null;
        this._userPath = '';
        this._loadout = null;
        this._giftUsers = null;
        this._giftUsersLoading = false;
    }

    render() {
        return `
            <div class="page achievements-page">
                <main class="page-content achievements-content">
                    <header class="achievements-header">
                        <div>
                            <div class="achievements-eyebrow">JELLYFIN · ACHIEVEMENT BADGES</div>
                            <h1>${escapeHtml(i18n.t('Achievements'))}</h1>
                        </div>
                        <button class="achievements-refresh focusable" id="achievements-refresh" type="button" tabindex="0">
                            <span aria-hidden="true">↻</span> ${escapeHtml(i18n.t('AchievementRefresh'))}
                        </button>
                    </header>

                    <div class="achievements-error" id="achievements-error" role="status" hidden></div>
                    <div class="achievements-loading" id="achievements-loading">${escapeHtml(i18n.t('Loading'))}</div>

                    <section class="achievements-overview" id="achievements-overview" aria-live="polite"></section>
                    <section class="achievements-section" id="achievements-quests-section">
                        <h2>${escapeHtml(i18n.t('AchievementQuests'))}</h2>
                        <div class="achievements-quests" id="achievements-quests"></div>
                    </section>
                    <section class="achievements-section achievements-game-section" id="achievements-game-section">
                        <div class="achievements-game-heading">
                            <div>
                                <h2>${escapeHtml(gameText('game'))}</h2>
                                <p>${escapeHtml(gameText('shopIntro'))}</p>
                            </div>
                            <div class="achievements-game-balance">
                                <span>⭐</span>
                                <small>${escapeHtml(gameText('scoreBank'))}</small>
                                <strong id="achievement-game-balance">—</strong>
                            </div>
                        </div>
                        <nav class="achievements-game-tabs" role="tablist" aria-label="${escapeHtml(gameText('game'))}">
                            <button class="achievement-game-tab focusable active" data-achievement-tab="arsenal" type="button" role="tab" aria-selected="true" tabindex="0">⚡ ${escapeHtml(gameText('arsenal'))}</button>
                            <button class="achievement-game-tab focusable" data-achievement-tab="shop" type="button" role="tab" aria-selected="false" tabindex="0">🛒 ${escapeHtml(gameText('shop'))}</button>
                            <button class="achievement-game-tab focusable" data-achievement-tab="cosmetics" type="button" role="tab" aria-selected="false" tabindex="0">🎨 ${escapeHtml(gameText('cosmetics'))}</button>
                            <button class="achievement-game-tab focusable" data-achievement-tab="gifts" type="button" role="tab" aria-selected="false" tabindex="0">🎁 ${escapeHtml(gameText('gifts'))}</button>
                        </nav>
                        <div class="achievement-game-status" id="achievement-game-status" role="status" hidden></div>
                        <section class="achievement-game-panel" id="achievement-panel-arsenal" data-achievement-panel="arsenal" role="tabpanel">
                            <div class="achievement-game-subhead"><h3>${escapeHtml(gameText('arsenal'))}</h3><span id="achievement-powerup-count"></span></div>
                            <div class="achievement-game-grid" id="achievement-arsenal-grid"><p class="achievements-muted">${escapeHtml(gameText('loadingGame'))}</p></div>
                        </section>
                        <section class="achievement-game-panel" id="achievement-panel-shop" data-achievement-panel="shop" role="tabpanel" hidden>
                            <p class="achievement-game-description">${escapeHtml(gameText('shopIntro'))}</p>
                            <h3>${escapeHtml(gameText('shopPowerups'))}</h3>
                            <div class="achievement-game-grid" id="achievement-shop-powerups"></div>
                            <h3>${escapeHtml(gameText('shopCosmetics'))}</h3>
                            <div class="achievement-game-grid" id="achievement-shop-cosmetics"></div>
                        </section>
                        <section class="achievement-game-panel" id="achievement-panel-cosmetics" data-achievement-panel="cosmetics" role="tabpanel" hidden>
                            <p class="achievement-game-description">${escapeHtml(gameText('cosmeticsIntro'))}</p>
                            <div class="achievement-game-grid" id="achievement-cosmetics-grid"></div>
                        </section>
                        <section class="achievement-game-panel" id="achievement-panel-gifts" data-achievement-panel="gifts" role="tabpanel" hidden>
                            <p class="achievement-game-description">${escapeHtml(gameText('giftIntro'))}</p>
                            <form class="achievement-gift-form" id="achievement-gift-form">
                                <label>${escapeHtml(gameText('recipient'))}
                                    <select id="achievement-gift-recipient" required>
                                        <option value="">${escapeHtml(gameText('usersLoading'))}</option>
                                    </select>
                                </label>
                                <label>${escapeHtml(gameText('amount'))}
                                    <input id="achievement-gift-amount" type="number" min="1" max="10000" step="1" value="100" required inputmode="numeric">
                                </label>
                                <button class="achievement-action-button focusable" type="submit" tabindex="0">🎁 ${escapeHtml(gameText('sendGift'))}</button>
                            </form>
                        </section>
                    </section>

                    <section class="achievements-section" id="achievements-leaderboard-section">
                        <h2>${escapeHtml(i18n.t('AchievementLeaderboard'))}</h2>
                        <div class="achievements-leaderboard" id="achievements-leaderboard"></div>
                    </section>
                    <section class="achievements-section">
                        <div class="achievements-section-heading">
                            <h2>${escapeHtml(i18n.t('Achievements'))}</h2>
                            <span class="achievements-count" id="achievements-count"></span>
                        </div>
                        <div class="achievements-filters" role="group" aria-label="${escapeHtml(i18n.t('AchievementProgress'))}">
                            <button class="achievement-filter focusable active" data-achievement-filter="all" type="button" tabindex="0">${escapeHtml(i18n.t('AchievementAll'))}</button>
                            <button class="achievement-filter focusable" data-achievement-filter="unlocked" type="button" tabindex="0">${escapeHtml(i18n.t('AchievementUnlockedFilter'))}</button>
                            <button class="achievement-filter focusable" data-achievement-filter="locked" type="button" tabindex="0">${escapeHtml(i18n.t('AchievementLockedFilter'))}</button>
                        </div>
                        <div class="achievements-grid" id="achievements-grid"></div>
                        <button class="achievements-more focusable" id="achievements-more" type="button" tabindex="0" hidden>${escapeHtml(i18n.t('AchievementShowMore'))}</button>
                    </section>
                </main>
            </div>
        `;
    }

    async onInit() {
        this.title = i18n.t('Achievements');
        this._bindEvents();
        await this._load();
        this.markReady();
    }

    _bindEvents() {
        const refresh = this.$('#achievements-refresh');
        if (refresh) refresh.addEventListener('click', () => this._load(true));

        this.el.querySelectorAll('[data-achievement-filter]').forEach((button) => {
            button.addEventListener('click', () => {
                this._filter = button.getAttribute('data-achievement-filter') || 'all';
                this._visibleBadgeCount = 24;
                this.el.querySelectorAll('[data-achievement-filter]').forEach((candidate) => {
                    candidate.classList.toggle('active', candidate === button);
                });
                this._renderBadges();
            });
        });

        const more = this.$('#achievements-more');
        if (more) {
            more.addEventListener('click', () => {
                this._visibleBadgeCount += 24;
                this._renderBadges();
            });
        }

        this.el.addEventListener('click', (event) => {
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;
            const button = target.closest('button');
            if (!button || !this.el.contains(button)) return;

            if (button.hasAttribute('data-achievement-tab')) {
                this._selectGameTab(button.getAttribute('data-achievement-tab'));
            } else if (button.hasAttribute('data-achievement-reroll')) {
                this._rerollQuests(button.getAttribute('data-achievement-reroll'), button);
            } else if (button.hasAttribute('data-achievement-buy')) {
                this._buyShopItem(button.getAttribute('data-achievement-buy'), button);
            } else if (button.hasAttribute('data-achievement-use')) {
                this._usePowerUp(button.getAttribute('data-achievement-use'), button);
            } else if (button.hasAttribute('data-achievement-equip')) {
                this._equipCosmetic(button.getAttribute('data-achievement-equip'), button);
            }
        });

        const giftForm = this.$('#achievement-gift-form');
        if (giftForm) giftForm.addEventListener('submit', (event) => this._sendGift(event));
    }

    async _load() {
        if (this._loading) return;
        this._loading = true;
        const loading = this.$('#achievements-loading');
        const error = this.$('#achievements-error');
        if (loading) loading.hidden = false;
        if (error) error.hidden = true;

        try {
            const userId = api.userId || api._userId;
            if (!userId) throw new Error('No active Jellyfin user session');

            // The public test route confirms the server plugin before user-scoped calls.
            await api.get('/Plugins/AchievementBadges/test');

            const language = String(document.documentElement.lang || 'en').toLowerCase().split('-')[0];
            const userPath = `/Plugins/AchievementBadges/users/${encodeURIComponent(userId)}`;
            this._userId = userId;
            this._userPath = userPath;
            const [summary, rank, badges, quests, leaderboard] = await Promise.all([
                api.get(`${userPath}/summary`),
                api.get(`${userPath}/rank`),
                api.get(`${userPath}?lang=${encodeURIComponent(language)}`),
                api.get(`${userPath}/quests`),
                api.get('/Plugins/AchievementBadges/leaderboard?limit=5').catch(() => [])
            ]);

            this._data = {
                summary: summary || {},
                rank: rank || {},
                badges: Array.isArray(badges) ? badges : [],
                quests: quests || {},
                leaderboard: Array.isArray(leaderboard) ? leaderboard : []
            };

            await this._loadLoadout();
            this._render();
        } catch (err) {
            log.warn('Achievement Badges data could not be loaded:', err);
            this._showError(err);
        } finally {
            this._loading = false;
            if (loading) loading.hidden = true;
        }
    }

    async _loadLoadout() {
        if (!this._userPath) return;
        const endpoints = [
            `${this._userPath}/bank`,
            `${this._userPath}/powerups`,
            '/Plugins/AchievementBadges/shop/catalog',
            `${this._userPath}/cosmetics`
        ];
        const results = await Promise.all(endpoints.map((endpoint) => api.get(endpoint).catch((err) => {
            log.warn(`Achievement Badges loadout request failed (${endpoint}):`, err);
            return null;
        })));
        this._loadout = {
            bank: results[0] || {},
            powerups: results[1] || {},
            catalog: results[2] || {},
            cosmetics: results[3] || {}
        };
    }

    _selectGameTab(tab) {
        const allowed = ['arsenal', 'shop', 'cosmetics', 'gifts'];
        const selected = allowed.includes(tab) ? tab : 'arsenal';
        this.el.querySelectorAll('[data-achievement-tab]').forEach((button) => {
            const active = button.getAttribute('data-achievement-tab') === selected;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        this.el.querySelectorAll('[data-achievement-panel]').forEach((panel) => {
            panel.hidden = panel.getAttribute('data-achievement-panel') !== selected;
        });
        if (selected === 'gifts' && !this._giftUsers && !this._giftUsersLoading) this._loadGiftUsers();
    }

    _setGameStatus(message, isError = false) {
        const status = this.$('#achievement-game-status');
        if (!status) return;
        status.textContent = message || '';
        status.classList.toggle('is-error', !!isError);
        status.hidden = !message;
    }

    _renderLoadout() {
        const balance = this.$('#achievement-game-balance');
        if (!this._loadout) {
            if (balance) balance.textContent = '—';
            return;
        }
        const bankScore = Number(valueOf(this._loadout.bank, 'ScoreBank', 'scoreBank') ?? valueOf(this._loadout.powerups, 'ScoreBank', 'scoreBank') ?? 0);
        if (balance) balance.textContent = bankScore.toLocaleString();
        this._renderArsenal();
        this._renderShop();
        this._renderCosmetics();
    }

    _renderArsenal() {
        const grid = this.$('#achievement-arsenal-grid');
        const countNode = this.$('#achievement-powerup-count');
        if (!grid) return;
        const inventory = arrayOf(this._loadout.powerups, 'Inventory', 'inventory');
        const total = inventory.reduce((sum, item) => sum + Number(valueOf(item, 'Count', 'count') || 0), 0);
        if (countNode) countNode.textContent = `${gameText('quantity')}: ${total}`;
        if (!inventory.length || total <= 0) {
            grid.innerHTML = `<p class="achievements-muted">${escapeHtml(gameText('arsenalEmpty'))}</p>`;
            return;
        }
        grid.innerHTML = inventory.map((item) => {
            const type = String(valueOf(item, 'Type', 'type') || '');
            const name = valueOf(item, 'DisplayName', 'displayName') || type;
            const count = Number(valueOf(item, 'Count', 'count') || 0);
            const active = !!valueOf(item, 'Active', 'active');
            const activeUntil = valueOf(item, 'ActiveUntil', 'activeUntil');
            const desc = valueOf(item, 'Description', 'description') || '';
            const isFreeze = type.toLowerCase() === 'streakfreeze';
            const canUse = count > 0 && !isFreeze && !(active && type.toLowerCase() === 'doublecredit');
            const icon = type.toLowerCase() === 'xpboost' ? '⚡' : type.toLowerCase() === 'doublecredit' ? '✖️2' : '❄️';
            return `
                <article class="achievement-game-card achievement-powerup-card">
                    <div class="achievement-game-card-icon">${icon}</div>
                    <div class="achievement-game-card-content">
                        <strong>${escapeHtml(name)}</strong>
                        <p>${escapeHtml(desc || (isFreeze ? gameText('automatic') : ''))}</p>
                        <div class="achievement-game-card-meta"><span>${escapeHtml(gameText('inventory'))}: <b>${count}</b></span>${active ? `<span class="is-active">${escapeHtml(gameText('active'))}</span>` : ''}</div>
                        ${activeUntil ? `<small>${escapeHtml(gameText('activeUntil'))}: ${escapeHtml(new Date(activeUntil).toLocaleString())}</small>` : ''}
                        ${isFreeze ? `<small>${escapeHtml(gameText('automatic'))}</small>` : ''}
                        ${canUse ? `<button class="achievement-action-button focusable" type="button" data-achievement-use="${escapeHtml(type)}" tabindex="0">${escapeHtml(gameText('use'))}</button>` : ''}
                    </div>
                </article>`;
        }).join('');
    }

    _renderShop() {
        const powerupsTarget = this.$('#achievement-shop-powerups');
        const cosmeticsTarget = this.$('#achievement-shop-cosmetics');
        if (!powerupsTarget || !cosmeticsTarget) return;
        const powerups = arrayOf(this._loadout.catalog, 'PowerUps', 'powerUps', 'powerups');
        const cosmetics = arrayOf(this._loadout.catalog, 'Cosmetics', 'cosmetics');
        const owned = new Set(arrayOf(this._loadout.cosmetics, 'Owned', 'owned').map(String));
        const score = Number(valueOf(this._loadout.bank, 'ScoreBank', 'scoreBank') ?? valueOf(this._loadout.powerups, 'ScoreBank', 'scoreBank') ?? 0);
        const renderItem = (item, isCosmetic) => {
            const id = String(valueOf(item, 'Id', 'id') || '');
            const name = valueOf(item, 'DisplayName', 'displayName') || id;
            const description = valueOf(item, 'Description', 'description') || '';
            const price = Number(valueOf(item, 'PriceScore', 'priceScore') || 0);
            const milestone = Number(valueOf(item, 'MilestoneScore', 'milestoneScore') || 0);
            const isOwned = isCosmetic && owned.has(id);
            const isMilestone = isCosmetic && price === 0 && milestone > 0 && !isOwned;
            const affordable = score >= price;
            const preview = valueOf(item, 'PreviewColor', 'previewColor');
            const previewColor = typeof preview === 'string' && /^#[0-9a-f]{3,8}$/i.test(preview) ? preview : '';
            const previewGlyph = previewColor ? '✦' : (preview || (isCosmetic ? '🎨' : '⚡'));
            const rawKind = valueOf(item, 'Kind', 'kind') || '';
            const kind = isCosmetic ? cosmeticKindLabel(rawKind) : (String(valueOf(item, 'Type', 'type') || '').toLowerCase() === 'xpboost' ? 'XP Boost' : String(valueOf(item, 'Type', 'type') || '').toLowerCase() === 'doublecredit' ? 'Double Credit' : 'Streak Freeze');
            const button = isOwned
                ? `<span class="achievement-owned-label">✓ ${escapeHtml(gameText('owned'))}</span>`
                : isMilestone
                    ? `<span class="achievement-owned-label">${escapeHtml(gameText('milestone'))}: ${milestone.toLocaleString()} ⭐</span>`
                    : `<button class="achievement-action-button focusable" type="button" data-achievement-buy="${escapeHtml(id)}" data-achievement-name="${escapeHtml(name)}" data-achievement-price="${price}" tabindex="0" ${!affordable ? 'disabled' : ''}>${escapeHtml(gameText('buy'))}</button>`;
            return `
                <article class="achievement-game-card achievement-shop-card ${!affordable && !isOwned && !isMilestone ? 'is-unaffordable' : ''}">
                    <div class="achievement-game-card-icon" ${previewColor ? `style="color:${previewColor}"` : ''}>${escapeHtml(previewGlyph)}</div>
                    <div class="achievement-game-card-content">
                        <strong>${escapeHtml(name)}</strong>
                        <small>${escapeHtml(kind)}</small>
                        <p>${escapeHtml(description)}</p>
                        <div class="achievement-game-card-foot"><span class="achievement-shop-price">${price.toLocaleString()} ⭐</span>${button}</div>
                    </div>
                </article>`;
        };
        powerupsTarget.innerHTML = powerups.length ? powerups.map((item) => renderItem(item, false)).join('') : `<p class="achievements-muted">${escapeHtml(gameText('arsenalEmpty'))}</p>`;
        cosmeticsTarget.innerHTML = cosmetics.length ? cosmetics.map((item) => renderItem(item, true)).join('') : `<p class="achievements-muted">${escapeHtml(gameText('noCosmetics'))}</p>`;
    }

    _renderCosmetics() {
        const target = this.$('#achievement-cosmetics-grid');
        if (!target) return;
        const catalog = arrayOf(this._loadout.catalog, 'Cosmetics', 'cosmetics');
        const owned = new Set(arrayOf(this._loadout.cosmetics, 'Owned', 'owned').map(String));
        const equipped = this._loadout.cosmetics || {};
        const items = catalog.filter((item) => owned.has(String(valueOf(item, 'Id', 'id') || '')));
        if (!items.length) {
            target.innerHTML = `<p class="achievements-muted">${escapeHtml(gameText('noCosmetics'))}</p>`;
            return;
        }
        target.innerHTML = items.map((item) => {
            const id = String(valueOf(item, 'Id', 'id') || '');
            const name = valueOf(item, 'DisplayName', 'displayName') || id;
            const kind = String(valueOf(item, 'Kind', 'kind') || '');
            const equippedId = valueOf(equipped, cosmeticEquipField(kind), cosmeticEquipField(kind).charAt(0).toLowerCase() + cosmeticEquipField(kind).slice(1));
            const isEquipped = equippedId === id;
            const preview = valueOf(item, 'PreviewColor', 'previewColor') || '🎨';
            const safeColor = typeof preview === 'string' && /^#[0-9a-f]{3,8}$/i.test(preview) ? preview : '';
            return `
                <article class="achievement-game-card achievement-cosmetic-card">
                    <div class="achievement-game-card-icon" ${safeColor ? `style="color:${safeColor}"` : ''}>${escapeHtml(preview)}</div>
                    <div class="achievement-game-card-content">
                        <strong>${escapeHtml(name)}</strong>
                        <small>${escapeHtml(cosmeticKindLabel(kind))}</small>
                        <p>${escapeHtml(valueOf(item, 'Description', 'description') || '')}</p>
                        ${isEquipped ? `<span class="achievement-owned-label is-equipped">✓ ${escapeHtml(gameText('equipped'))}</span>` : `<button class="achievement-action-button focusable" type="button" data-achievement-equip="${escapeHtml(id)}" data-achievement-name="${escapeHtml(name)}" tabindex="0">${escapeHtml(gameText('equip'))}</button>`}
                    </div>
                </article>`;
        }).join('');
    }

    async _loadGiftUsers() {
        this._giftUsersLoading = true;
        const select = this.$('#achievement-gift-recipient');
        if (select) select.innerHTML = `<option value="">${escapeHtml(gameText('usersLoading'))}</option>`;
        try {
            const result = await api.get(`${this._userPath}/directory`);
            this._giftUsers = (Array.isArray(result) ? result : []).filter((user) => String(valueOf(user, 'Id', 'id') || '') !== String(this._userId));
            this._renderGiftUsers();
        } catch (err) {
            log.warn('Achievement Badges user directory could not be loaded:', err);
            this._giftUsers = [];
            this._renderGiftUsers();
            this._setGameStatus(gameText('actionFailed'), true);
        } finally {
            this._giftUsersLoading = false;
        }
    }

    _renderGiftUsers() {
        const select = this.$('#achievement-gift-recipient');
        const submit = this.$('#achievement-gift-form button[type="submit"]');
        if (!select) return;
        if (!this._giftUsers || !this._giftUsers.length) {
            select.innerHTML = `<option value="">${escapeHtml(gameText('noUsers'))}</option>`;
            if (submit) submit.disabled = true;
            return;
        }
        select.innerHTML = `<option value="">${escapeHtml(gameText('chooseUser'))}</option>` + this._giftUsers.map((user) => {
            const id = String(valueOf(user, 'Id', 'id') || '');
            const name = valueOf(user, 'Name', 'name') || id;
            return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
        }).join('');
        if (submit) submit.disabled = false;
    }

    async _rerollQuests(period, button) {
        if (!['daily', 'weekly'].includes(period) || !this._userPath) return;
        const periodLabel = gameText(period);
        if (!window.confirm(gameText('confirmReroll', { period: periodLabel }))) return;
        button.disabled = true;
        this._setGameStatus(gameText('loadingGame'));
        try {
            await api.post(`${this._userPath}/quests/${period}/reroll`, {});
            this._data.quests = await api.get(`${this._userPath}/quests`);
            this._renderQuests();
            this._setGameStatus(gameText('rerollOk'));
        } catch (err) {
            log.warn(`Achievement Badges ${period} quest reroll failed:`, err);
            this._setGameStatus(err.message || gameText('actionFailed'), true);
            button.disabled = false;
        }
    }

    async _buyShopItem(itemId, button) {
        if (!itemId || !this._userPath) return;
        const name = button.getAttribute('data-achievement-name') || itemId;
        const price = Number(button.getAttribute('data-achievement-price') || 0);
        if (!window.confirm(gameText('confirmBuy', { name, price: price.toLocaleString() }))) return;
        button.disabled = true;
        this._setGameStatus(gameText('loadingGame'));
        try {
            const result = await api.post(`${this._userPath}/shop/purchase`, { ItemId: itemId });
            if (valueOf(result, 'Success', 'success') === false) throw new Error(valueOf(result, 'Message', 'message') || gameText('actionFailed'));
            await this._loadLoadout();
            this._renderLoadout();
            this._setGameStatus(valueOf(result, 'Message', 'message') || gameText('purchaseOk'));
        } catch (err) {
            log.warn('Achievement Badges shop purchase failed:', err);
            this._setGameStatus(err.message || gameText('actionFailed'), true);
            button.disabled = false;
        }
    }

    async _usePowerUp(type, button) {
        if (!type || !this._userPath) return;
        const item = arrayOf(this._loadout && this._loadout.powerups, 'Inventory', 'inventory').find((entry) => String(valueOf(entry, 'Type', 'type')) === type);
        const name = item ? valueOf(item, 'DisplayName', 'displayName') : type;
        if (!window.confirm(gameText('confirmUse', { name }))) return;
        button.disabled = true;
        this._setGameStatus(gameText('loadingGame'));
        try {
            const result = await api.post(`${this._userPath}/powerups/use/${encodeURIComponent(type)}`, {});
            await this._loadLoadout();
            this._renderLoadout();
            this._setGameStatus(valueOf(result, 'Message', 'message') || gameText('useOk'));
        } catch (err) {
            log.warn('Achievement Badges power-up activation failed:', err);
            this._setGameStatus(err.message || gameText('actionFailed'), true);
            button.disabled = false;
        }
    }

    async _equipCosmetic(cosmeticId, button) {
        if (!cosmeticId || !this._userPath) return;
        const name = button.getAttribute('data-achievement-name') || cosmeticId;
        if (!window.confirm(gameText('confirmEquip', { name }))) return;
        button.disabled = true;
        this._setGameStatus(gameText('loadingGame'));
        try {
            const result = await api.post(`${this._userPath}/cosmetics/equip`, { CosmeticId: cosmeticId });
            if (valueOf(result, 'Success', 'success') === false) throw new Error(valueOf(result, 'Message', 'message') || gameText('actionFailed'));
            await this._loadLoadout();
            this._renderLoadout();
            this._setGameStatus(valueOf(result, 'Message', 'message') || gameText('equipOk'));
        } catch (err) {
            log.warn('Achievement Badges cosmetic equip failed:', err);
            this._setGameStatus(err.message || gameText('actionFailed'), true);
            button.disabled = false;
        }
    }

    async _sendGift(event) {
        event.preventDefault();
        if (!this._userPath) return;
        const select = this.$('#achievement-gift-recipient');
        const amountInput = this.$('#achievement-gift-amount');
        const button = this.$('#achievement-gift-form button[type="submit"]');
        const recipientId = select ? select.value : '';
        const recipient = this._giftUsers && this._giftUsers.find((user) => String(valueOf(user, 'Id', 'id')) === recipientId);
        const recipientName = recipient ? (valueOf(recipient, 'Name', 'name') || recipientId) : '';
        const amount = Number(amountInput ? amountInput.value : 0);
        if (!recipientId || !Number.isInteger(amount) || amount < 1 || amount > 10000) {
            this._setGameStatus(gameText('actionFailed'), true);
            return;
        }
        if (!window.confirm(gameText('confirmGift', { amount: amount.toLocaleString(), name: recipientName }))) return;
        if (button) button.disabled = true;
        this._setGameStatus(gameText('loadingGame'));
        try {
            const result = await api.post(`${this._userPath}/gift/${encodeURIComponent(recipientId)}`, null, { params: { amount } });
            if (valueOf(result, 'Success', 'success') === false) throw new Error(valueOf(result, 'Message', 'message') || gameText('actionFailed'));
            await this._loadLoadout();
            this._renderLoadout();
            this._setGameStatus(valueOf(result, 'Message', 'message') || gameText('giftOk'));
        } catch (err) {
            log.warn('Achievement Badges score gift failed:', err);
            this._setGameStatus(err.message || gameText('actionFailed'), true);
        } finally {
            if (button) button.disabled = false;
        }
    }

    _showError(err) {
        const error = this.$('#achievements-error');
        if (!error) return;
        const isMissing = err && (err.status === 404 || err.status === 401 || err.status === 403);
        error.textContent = isMissing
            ? i18n.t('AchievementBadgesUnavailable')
            : i18n.t('AchievementLoadError');
        error.hidden = false;
        const overview = this.$('#achievements-overview');
        const quests = this.$('#achievements-quests');
        const leaderboard = this.$('#achievements-leaderboard');
        const grid = this.$('#achievements-grid');
        if (overview) overview.innerHTML = '';
        if (quests) quests.innerHTML = '';
        if (leaderboard) leaderboard.innerHTML = '';
        if (grid) grid.innerHTML = '';
    }

    _render() {
        if (!this._data) return;
        this._renderOverview();
        this._renderQuests();
        this._renderLeaderboard();
        this._renderBadges();
        this._renderLoadout();
    }

    _renderOverview() {
        const target = this.$('#achievements-overview');
        if (!target) return;

        const summary = this._data.summary;
        const rank = this._data.rank;
        const tier = valueOf(rank, 'Tier', 'tier') || {};
        const nextTier = valueOf(rank, 'NextTier', 'nextTier') || {};
        const score = Number(valueOf(summary, 'Score', 'score', 'UnlockedScore') || valueOf(rank, 'Score', 'score') || 0);
        const unlocked = Number(valueOf(summary, 'Unlocked', 'unlocked') || 0);
        const total = Number(valueOf(summary, 'Total', 'total') || this._data.badges.length);
        const percent = Number(valueOf(summary, 'Percentage', 'percentage') || 0);
        const rankName = valueOf(tier, 'Name', 'name') || '—';
        const nextName = valueOf(nextTier, 'Name', 'name');
        const rankProgress = Math.max(0, Math.min(100, Number(valueOf(rank, 'ProgressToNext', 'progressToNext') || 0)));
        const streak = Number(valueOf(summary, 'CurrentWatchStreak', 'currentWatchStreak') || 0);
        const bestStreak = Number(valueOf(summary, 'BestWatchStreak', 'bestWatchStreak') || 0);

        const recent = this._data.badges
            .filter((badge) => valueOf(badge, 'Unlocked', 'unlocked') && valueOf(badge, 'UnlockedAt', 'unlockedAt'))
            .sort((a, b) => new Date(valueOf(b, 'UnlockedAt', 'unlockedAt')) - new Date(valueOf(a, 'UnlockedAt', 'unlockedAt')))
            .slice(0, 4);
        const recentHtml = recent.length
            ? `<div class="achievements-recent">${recent.map((badge) => `<span title="${escapeHtml(valueOf(badge, 'Title', 'title'))}">${badgeIcon(badge)}</span>`).join('')}</div>`
            : '';

        target.innerHTML = `
            <div class="achievement-stat achievement-stat-score">
                <span class="achievement-stat-icon">⭐</span>
                <span class="achievement-stat-label">${escapeHtml(i18n.t('AchievementScore'))}</span>
                <strong>${score.toLocaleString()}</strong>
            </div>
            <div class="achievement-stat achievement-stat-rank">
                <span class="achievement-stat-icon">👑</span>
                <span class="achievement-stat-label">${escapeHtml(i18n.t('AchievementRank'))}</span>
                <strong>${escapeHtml(rankName)}</strong>
                <div class="achievement-progress"><span style="width:${rankProgress}%"></span></div>
                <small>${nextName ? `${rankProgress}% · ${escapeHtml(nextName)}` : `${rankProgress}%`}</small>
            </div>
            <div class="achievement-stat achievement-stat-unlocked">
                <span class="achievement-stat-icon">🏆</span>
                <span class="achievement-stat-label">${escapeHtml(i18n.t('AchievementUnlocked'))}</span>
                <strong>${unlocked} / ${total}</strong>
                <div class="achievement-progress"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>
                <small>${percent.toFixed(1)}%</small>
            </div>
            <div class="achievement-stat achievement-stat-streak">
                <span class="achievement-stat-icon">🔥</span>
                <span class="achievement-stat-label">${escapeHtml(i18n.t('AchievementProgress'))}</span>
                <strong>${streak} ${escapeHtml('·')} ${bestStreak}</strong>
                <small>${escapeHtml(i18n.t('AchievementWatchStreak'))}</small>
                ${recentHtml}
            </div>
        `;
    }

    _renderQuests() {
        const target = this.$('#achievements-quests');
        if (!target) return;
        const daily = valueOf(this._data.quests, 'Daily', 'daily') || [];
        const weekly = valueOf(this._data.quests, 'Weekly', 'weekly') || [];
        const renderList = (items) => {
            if (!Array.isArray(items) || !items.length) return `<p class="achievements-muted">${escapeHtml(i18n.t('AchievementNoQuests'))}</p>`;
            return items.map((quest) => {
                const title = valueOf(quest, 'Title', 'title') || '';
                const description = valueOf(quest, 'Description', 'description') || '';
                const current = Number(valueOf(quest, 'Current', 'current') || 0);
                const goal = Number(valueOf(quest, 'Target', 'target') || 0);
                const completed = !!valueOf(quest, 'Completed', 'completed');
                const reward = Number(valueOf(quest, 'Reward', 'reward') || 0);
                const percent = progressPercent(current, goal);
                return `
                    <article class="achievement-quest ${completed ? 'is-complete' : ''}">
                        <div class="achievement-quest-icon">${badgeIcon(quest)}</div>
                        <div class="achievement-quest-body">
                            <strong>${escapeHtml(title)}</strong>
                            <p>${escapeHtml(description)}</p>
                            <div class="achievement-progress"><span style="width:${percent}%"></span></div>
                            <small>${current} / ${goal} · +${reward} ⭐</small>
                        </div>
                        ${completed ? '<span class="achievement-quest-check">✓</span>' : ''}
                    </article>
                `;
            }).join('');
        };

        const dailyRemaining = Number(valueOf(this._data.quests, 'DailyRerollsRemaining', 'dailyRerollsRemaining') || 0);
        const weeklyRemaining = Number(valueOf(this._data.quests, 'WeeklyRerollsRemaining', 'weeklyRerollsRemaining') || 0);
        const rerollButton = (period, remaining) => `
            <button class="achievement-reroll-button focusable" type="button" data-achievement-reroll="${period}" tabindex="0" ${remaining <= 0 ? 'disabled' : ''}>
                ↻ ${remaining > 0 ? escapeHtml(gameText('questReroll')) : escapeHtml(gameText('rerollUsed'))}
            </button>`;

        target.innerHTML = `
            <div class="achievement-quest-group">
                <div class="achievement-quest-heading"><h3>${escapeHtml(i18n.t('AchievementDaily'))}</h3>${rerollButton('daily', dailyRemaining)}</div>
                ${renderList(daily)}
            </div>
            <div class="achievement-quest-group">
                <div class="achievement-quest-heading"><h3>${escapeHtml(i18n.t('AchievementWeekly'))}</h3>${rerollButton('weekly', weeklyRemaining)}</div>
                ${renderList(weekly)}
            </div>
        `;
    }

    _renderLeaderboard() {
        const target = this.$('#achievements-leaderboard');
        if (!target) return;
        const entries = this._data.leaderboard;
        if (!entries.length) {
            target.innerHTML = `<p class="achievements-muted">${escapeHtml(i18n.t('AchievementNoLeaderboard'))}</p>`;
            return;
        }
        target.innerHTML = entries.map((entry, index) => {
            const name = valueOf(entry, 'UserName', 'userName') || '—';
            const score = Number(valueOf(entry, 'Score', 'score', 'Value', 'value') || 0);
            const unlocked = Number(valueOf(entry, 'Unlocked', 'unlocked') || 0);
            return `
                <div class="achievement-leader-row">
                    <span class="achievement-leader-place">${index + 1}</span>
                    <strong>${escapeHtml(name)}</strong>
                    <span>${score.toLocaleString()} ⭐</span>
                    <small>${unlocked} 🏆</small>
                </div>
            `;
        }).join('');
    }

    _renderBadges() {
        const grid = this.$('#achievements-grid');
        const count = this.$('#achievements-count');
        const more = this.$('#achievements-more');
        if (!grid || !this._data) return;

        let badges = this._data.badges.slice();
        if (this._filter === 'unlocked') badges = badges.filter((badge) => !!valueOf(badge, 'Unlocked', 'unlocked'));
        if (this._filter === 'locked') badges = badges.filter((badge) => !valueOf(badge, 'Unlocked', 'unlocked'));
        badges.sort((a, b) => {
            const aUnlocked = !!valueOf(a, 'Unlocked', 'unlocked');
            const bUnlocked = !!valueOf(b, 'Unlocked', 'unlocked');
            if (aUnlocked !== bUnlocked) return aUnlocked ? -1 : 1;
            const aTime = new Date(valueOf(a, 'UnlockedAt', 'unlockedAt') || 0).getTime();
            const bTime = new Date(valueOf(b, 'UnlockedAt', 'unlockedAt') || 0).getTime();
            return bTime - aTime || String(valueOf(a, 'Title', 'title') || '').localeCompare(String(valueOf(b, 'Title', 'title') || ''));
        });

        if (count) count.textContent = `${badges.length}`;
        if (!badges.length) {
            grid.innerHTML = `<p class="achievements-muted">${escapeHtml(i18n.t('AchievementNoBadges'))}</p>`;
            if (more) more.hidden = true;
            return;
        }

        const visible = badges.slice(0, this._visibleBadgeCount);
        grid.innerHTML = visible.map((badge) => {
            const title = valueOf(badge, 'Title', 'title') || '';
            const description = valueOf(badge, 'Description', 'description') || '';
            const category = valueOf(badge, 'Category', 'category') || '';
            const rarity = String(valueOf(badge, 'Rarity', 'rarity') || 'Common').toLowerCase().replace(/[^a-z0-9-]/g, '');
            const current = Number(valueOf(badge, 'CurrentValue', 'currentValue') || 0);
            const goal = Number(valueOf(badge, 'TargetValue', 'targetValue') || 0);
            const unlocked = !!valueOf(badge, 'Unlocked', 'unlocked');
            const percent = progressPercent(current, goal);
            const unlockedAt = valueOf(badge, 'UnlockedAt', 'unlockedAt');
            const dateText = unlockedAt ? new Date(unlockedAt).toLocaleDateString() : '';
            return `
                <article class="achievement-badge ${unlocked ? 'is-unlocked' : 'is-locked'} rarity-${rarity}">
                    <div class="achievement-badge-icon">${badgeIcon(badge)}</div>
                    <div class="achievement-badge-info">
                        <div class="achievement-badge-title-row">
                            <strong>${escapeHtml(title)}</strong>
                            <span class="achievement-rarity">${escapeHtml(valueOf(badge, 'Rarity', 'rarity') || '')}</span>
                        </div>
                        <p>${escapeHtml(description)}</p>
                        <div class="achievement-badge-meta">
                            <span>${escapeHtml(category)}</span>
                            ${unlockedAt ? `<span>${escapeHtml(i18n.t('AchievementEarnedOn', [dateText]))}</span>` : `<span>${current} / ${goal}</span>`}
                        </div>
                        ${!unlocked && goal > 0 ? `<div class="achievement-progress"><span style="width:${percent}%"></span></div>` : ''}
                    </div>
                    <span class="achievement-badge-state" aria-label="${unlocked ? escapeHtml(i18n.t('AchievementUnlocked')) : escapeHtml(i18n.t('AchievementLockedFilter'))}">${unlocked ? '✓' : '🔒'}</span>
                </article>
            `;
        }).join('');

        if (more) {
            more.hidden = visible.length >= badges.length;
            if (!more.hidden) more.textContent = `${i18n.t('AchievementShowMore')} (${badges.length - visible.length})`;
        }
    }
}

export default AchievementsPage;

