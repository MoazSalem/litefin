/**
 * ============================================================================
 * Litefin Tizen - About Tab Modal Dialogs
 * ============================================================================
 * Modal dialog definitions, QR code layouts, and focus trap controllers for
 * the Settings About tab.
 * ============================================================================
 */

import { focusManager } from '../../../ui/FocusManager.js';
import { i18n } from '../../../utils/i18n.js';
import { ABOUT_ICONS } from '../../../utils/Icons.js';
import { getDeviceSpecsData, openExternalUrl } from './AboutDeviceSpecs.js';

export { getDeviceSpecsData, openExternalUrl };

/**
 * Shared modal dialog wrapper template generator.
 * @private
 */
function renderDialogShell({ titleSvg, title, subtitle, contentHtml, closeBtnId = 'btn-about-modal-close', modalClass = '' }) {
    return `
        <div class="settings-modal about-dialog-modal ${modalClass}" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="about-dialog-header">
                <h2>${titleSvg}${title}</h2>
                <p class="about-dialog-subtitle">${subtitle}</p>
            </div>
            <div class="about-dialog-content">${contentHtml}</div>
            <div class="about-dialog-actions">
                <button class="modal-action-btn focusable about-dialog-close-btn" id="${closeBtnId}" tabindex="0" data-focusable="true">
                    ${i18n.t('Close') || 'Close'}
                </button>
            </div>
        </div>
    `;
}

/**
 * Shared QR card component template generator.
 * @private
 */
function renderQrCard({ qrImg, title, desc, urlChip, btnId, navRight, navLeft, navUp, navDown, maxCardWidth }) {
    const cardStyle = maxCardWidth ? `style="max-width: ${maxCardWidth};"` : '';
    const rightAttr = navRight ? `data-nav-right="${navRight}"` : '';
    const leftAttr = navLeft ? `data-nav-left="${navLeft}"` : '';
    const upAttr = navUp ? `data-nav-up="${navUp}"` : '';
    const downAttr = navDown ? `data-nav-down="${navDown}"` : '';

    return `
        <div class="about-qr-card" ${cardStyle}>
            <div class="about-qr-image-wrap">
                <img src="${qrImg}" class="about-qr-img" alt="${title} QR Code" />
            </div>
            <span class="about-qr-title">${title}</span>
            <span class="about-qr-desc">${desc}</span>
            <span class="about-qr-url-chip">${urlChip}</span>
            <button class="btn btn-secondary btn-small focusable about-qr-btn" id="${btnId}" tabindex="0" data-focusable="true" ${rightAttr} ${leftAttr} ${upAttr} ${downAttr}>
                ${i18n.t('OpenLink') || 'Open Link'}
            </button>
        </div>
    `;
}

/**
 * Controller for rendering and handling modal dialogs within the About tab.
 */
export class AboutModals {
    /**
     * Creates an instance of AboutModals.
     * @param {HTMLElement|Function} overlayProvider Function or element for modal overlay
     */
    constructor(overlayProvider) {
        this._overlayProvider = overlayProvider;
        this._closeTimer = null;
    }

    /**
     * Resolves the current DOM overlay element.
     * @private
     * @returns {HTMLElement|null}
     */
    _getOverlay() {
        if (typeof this._overlayProvider === 'function') {
            return this._overlayProvider();
        }
        return this._overlayProvider || document.getElementById('modal-overlay');
    }

    /**
     * Closes the currently active About dialog and pops the focus trap.
     */
    closeDialog() {
        const overlay = this._getOverlay();
        if (!overlay || !overlay.classList.contains('visible')) return;

        // Disarm interactive elements to prevent focus clinging
        const actionButtons = overlay.querySelectorAll('button, [tabindex]');
        for (let i = 0; i < actionButtons.length; i++) {
            const btn = actionButtons[i];
            btn.setAttribute('tabindex', '-1');
            btn.setAttribute('disabled', 'true');
            if (typeof btn.blur === 'function') {
                btn.blur();
            }
        }

        // Hide overlay smoothly
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.onclick = null;

        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
        }

        this._closeTimer = setTimeout(() => {
            if (overlay) {
                overlay.innerHTML = '';
            }
        }, 300);

        // Pop focus trap
        focusManager.popTrap();
    }

    /**
     * Mounts, binds, and activates modal dialog trap.
     * @private
     */
    _displayModal({ titleSvg, title, subtitle, contentHtml, closeBtnId = 'btn-about-modal-close', modalClass = '', defaultFocus, orientation = 'grid', actionBindings = [] }) {
        const overlay = this._getOverlay();
        if (!overlay) return;

        overlay.innerHTML = renderDialogShell({ titleSvg, title, subtitle, contentHtml, closeBtnId, modalClass });
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Backdrop click dismiss
        overlay.onclick = (e) => {
            if (e.target === overlay) this.closeDialog();
        };

        // Close button dismiss
        const closeBtn = overlay.querySelector(`#${closeBtnId}`);
        if (closeBtn) {
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                this.closeDialog();
            };
        }

        // Action button bindings
        actionBindings.forEach(({ selector, url }) => {
            const btn = overlay.querySelector(selector);
            if (btn) {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    openExternalUrl(url);
                };
            }
        });

        // Activate focus trap
        focusManager.pushTrap(overlay.querySelector('.about-dialog-modal'), {
            orientation,
            defaultFocusSelector: defaultFocus
        });
    }

    /**
     * Displays the Device Specifications dialog modal.
     */
    showDeviceInformationDialog() {
        const specs = getDeviceSpecsData();

        const buildBadgeCloud = (codecs) =>
            codecs
                .map((c) => {
                    const statusClass = !c.hw ? 'unsupported' : !c.user ? 'disabled' : 'supported';
                    const statusLabel = !c.hw
                        ? ` (${i18n.t('Unsupported') || 'Unsupported'})`
                        : !c.user
                          ? ` (${i18n.t('Disabled') || 'Disabled'})`
                          : '';
                    return `<span class="about-codec-badge ${statusClass}">${c.name}${statusLabel}</span>`;
                })
                .join('');

        const contentHtml = `
            <div class="about-device-specs-grid">
                <div class="about-device-tile">
                    <span class="about-device-label" data-i18n="Model">${i18n.t('Model')}</span>
                    <span class="about-device-val">${specs.modelName}</span>
                </div>
                <div class="about-device-tile">
                    <span class="about-device-label" data-i18n="Platform">${i18n.t('Platform')}</span>
                    <span class="about-device-val">${specs.platform}</span>
                </div>
                <div class="about-device-tile">
                    <span class="about-device-label" data-i18n="Resolution">${i18n.t('Resolution')}</span>
                    <span class="about-device-val">${specs.resolution}</span>
                </div>
                <div class="about-device-tile">
                    <span class="about-device-label" data-i18n="HDRSupport">${i18n.t('HDRSupport')}</span>
                    <span class="about-device-val">${specs.hdr}</span>
                </div>
                <div class="about-device-tile span-2">
                    <span class="about-device-label" data-i18n="VideoCodecs">${i18n.t('VideoCodecs')}</span>
                    <div class="about-badge-cloud">${buildBadgeCloud(specs.videoCodecs)}</div>
                </div>
                <div class="about-device-tile span-2">
                    <span class="about-device-label" data-i18n="AudioCodecs">${i18n.t('AudioCodecs') || 'Audio Codecs'}</span>
                    <div class="about-badge-cloud">${buildBadgeCloud(specs.audioCodecs)}</div>
                </div>
            </div>
        `;

        this._displayModal({
            titleSvg: ABOUT_ICONS.deviceInfo,
            title: i18n.t('ViewDeviceInfo') || 'Device Specifications',
            subtitle: 'Hardware identity, display pipeline, and hardware decoding decoders.',
            contentHtml,
            closeBtnId: 'btn-device-info-done',
            defaultFocus: '#btn-device-info-done',
            orientation: 'horizontal'
        });
    }

    /**
     * Displays GitHub repository and issue tracker dialog with 2 QR codes.
     * @param {'repo'|'issues'} [initialFocus='repo']
     */
    showGitHubDialog(initialFocus = 'repo') {
        const card1 = renderQrCard({
            qrImg: 'assets/qr/qr-github.png',
            title: i18n.t('GitHubRepo') || 'GitHub Repository',
            desc: 'View source code, release notes, and documentation on GitHub.',
            urlChip: 'github.com/MoazSalem/litefin',
            btnId: 'btn-github-open',
            navRight: '#btn-issues-open',
            navDown: '#btn-about-modal-close'
        });

        const card2 = renderQrCard({
            qrImg: 'assets/qr/qr-issues.png',
            title: i18n.t('ReportIssue') || 'Quick Issue Reporter',
            desc: 'Submit bug reports, feature requests, or troubleshooting crash reports.',
            urlChip: 'github.com/MoazSalem/litefin/issues',
            btnId: 'btn-issues-open',
            navLeft: '#btn-github-open',
            navDown: '#btn-about-modal-close'
        });

        this._displayModal({
            titleSvg: ABOUT_ICONS.github,
            title: 'GitHub & Bug Tracker',
            subtitle: 'Scan with your phone camera, or click to open directly in a browser.',
            contentHtml: `<div class="about-qr-grid">${card1}${card2}</div>`,
            defaultFocus: initialFocus === 'issues' ? '#btn-issues-open' : '#btn-github-open',
            actionBindings: [
                { selector: '#btn-github-open', url: 'https://github.com/MoazSalem/litefin' },
                { selector: '#btn-issues-open', url: 'https://github.com/MoazSalem/litefin/issues' }
            ]
        });
    }

    /**
     * Displays server companion plugins dialog featuring 2 QR codes.
     */
    showPluginsDialog() {
        const card1 = renderQrCard({
            qrImg: 'assets/qr/qr-plugin-jellyfin.png',
            title: 'Jellyfin Plugin',
            desc: 'Official server companion plugin for Jellyfin server instances.',
            urlChip: 'github.com/MoazSalem/litefin-plugin',
            btnId: 'btn-plugin-jellyfin-open',
            navRight: '#btn-plugin-emby-open',
            navDown: '#btn-about-modal-close'
        });

        const card2 = renderQrCard({
            qrImg: 'assets/qr/qr-plugin-emby.png',
            title: 'Emby Plugin',
            desc: 'Official server companion plugin for Emby server instances.',
            urlChip: 'github.com/MoazSalem/litefin-plugin-emby',
            btnId: 'btn-plugin-emby-open',
            navLeft: '#btn-plugin-jellyfin-open',
            navDown: '#btn-about-modal-close'
        });

        this._displayModal({
            titleSvg: ABOUT_ICONS.plugins,
            title: 'Server Companion Plugins',
            subtitle: 'Install companion plugins on your media server for Seerr integration and cloud settings backup.',
            contentHtml: `<div class="about-qr-grid">${card1}${card2}</div>`,
            defaultFocus: '#btn-plugin-jellyfin-open',
            actionBindings: [
                { selector: '#btn-plugin-jellyfin-open', url: 'https://github.com/MoazSalem/litefin-plugin' },
                { selector: '#btn-plugin-emby-open', url: 'https://github.com/MoazSalem/litefin-plugin-emby' }
            ]
        });
    }

    /**
     * Displays the Discord Community invitation dialog.
     */
    showDiscordDialog() {
        const card = renderQrCard({
            qrImg: 'assets/qr/qr-discord.png',
            title: 'Official Discord Server',
            desc: 'Real-time troubleshooting, alpha announcements, and community discussions.',
            urlChip: 'discord.gg/N3VpazBtTx',
            btnId: 'btn-discord-open',
            navDown: '#btn-about-modal-close',
            maxCardWidth: '380px'
        });

        this._displayModal({
            titleSvg: ABOUT_ICONS.discord,
            title: i18n.t('DiscordCommunity') || 'Discord Community',
            subtitle: 'Scan to join the official Litefin Discord server. Connect with other users, ask questions, and share feedback.',
            contentHtml: `<div class="about-qr-grid">${card}</div>`,
            modalClass: 'compact-modal',
            defaultFocus: '#btn-discord-open',
            actionBindings: [
                { selector: '#btn-discord-open', url: 'https://discord.gg/N3VpazBtTx' }
            ]
        });
    }

    /**
     * Displays the Support & Donations dialog featuring 2 QR codes.
     */
    showSupportDialog() {
        const card1 = renderQrCard({
            qrImg: 'assets/qr/qr-donation.png',
            title: 'Buy Me a Coffee',
            desc: 'Support developer coffee fuels and ongoing rapid release cycles!',
            urlChip: 'buymeacoffee.com/moazsalem',
            btnId: 'btn-support-coffee-open',
            navRight: '#btn-support-sponsors-open',
            navDown: '#btn-about-modal-close'
        });

        const card2 = renderQrCard({
            qrImg: 'assets/qr/qr-sponsors.png',
            title: 'GitHub Sponsors',
            desc: 'Become an official sponsor of the Litefin repository.',
            urlChip: 'github.com/sponsors/MoazSalem',
            btnId: 'btn-support-sponsors-open',
            navLeft: '#btn-support-coffee-open',
            navDown: '#btn-about-modal-close'
        });

        this._displayModal({
            titleSvg: ABOUT_ICONS.support,
            title: 'Support & Donations',
            subtitle: 'Litefin is free and open-source. Help back continuous development and infrastructure support.',
            contentHtml: `<div class="about-qr-grid">${card1}${card2}</div>`,
            defaultFocus: '#btn-support-coffee-open',
            actionBindings: [
                { selector: '#btn-support-coffee-open', url: 'https://www.buymeacoffee.com/moazsalem' },
                { selector: '#btn-support-sponsors-open', url: 'https://github.com/sponsors/MoazSalem' }
            ]
        });
    }

    /**
     * Teardown timer cleanup.
     */
    destroy() {
        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }
        this._overlayProvider = null;
    }
}

export default AboutModals;
