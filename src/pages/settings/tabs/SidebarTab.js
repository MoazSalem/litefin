/**
 * ============================================================================
 * Litefin Tizen - Sidebar Tab Controller
 * ============================================================================
 * Manages Navigation Sidebar settings: layout modes (classic, modern, collapsed,
 * floating), item alignment, initial sidebar focus target, color schemes,
 * logo behaviors, back button routing, icon shadow styling, and live sidebar
 * section reordering and library pinning editors.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import { api } from '../../../api/index.js';
import { eventBus } from '../../../core/EventBus.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { sidebarLayoutManager } from '../../../utils/SidebarLayoutManager.js';
import { logger } from '../../../utils/Logger.js';
import { UP_SVG, DOWN_SVG, EYE_OFF, EYE_ON } from '../../../utils/Icons.js';

const log = logger.create('SidebarTab');

/**
 * Controller class governing navigation sidebar preferences and dynamic ordering.
 */
export class SidebarTab {
    constructor(page) {
        this.page = page;
        this._listeners = [];
    }

    _drop(id, options, current) {
        return (this.page && typeof this.page._renderDropdown === 'function') ? this.page._renderDropdown(id, options, current) : '';
    }

    _item(name, desc, control, id = '', show = true) {
        const idAttr = id ? ` id="${id}"` : '';
        const styleAttr = show ? '' : ' style="display: none;"';
        return `<div class="setting-item"${idAttr}${styleAttr}><div class="setting-label"><span class="setting-name">${name}</span><span class="setting-description">${desc}</span></div><div class="setting-control">${control}</div></div>`;
    }

    _toggle(id, active) {
        return `<button class="toggle-switch ${active ? 'active' : ''}" id="${id}" tabindex="0"></button>`;
    }

    render() {
        const layoutModes = [
            { value: 'classic', label: i18n.t('LayoutClassic') || 'Classic' },
            { value: 'modern', label: i18n.t('LayoutModernSidebar') || 'Modern' },
            { value: 'modern-collapsed', label: i18n.t('LayoutModernCollapsedSidebar') || 'Modern Collapsed' },
            { value: 'floating-buttons', label: i18n.t('LayoutFloatingButtonsSidebar') || 'Floating Buttons' },
            { value: 'floating-island', label: i18n.t('LayoutFloatingIslandSidebar') || 'Floating Island' }
        ];

        const sidebarModes = [
            { value: 'shown', label: i18n.t('AlwaysShown') || 'Always Shown' },
            { value: 'collapsed', label: i18n.t('AlwaysCollapsed') || 'Always Collapsed' },
            { value: 'hidden', label: i18n.t('AlwaysHidden') || 'Always Hidden' },
            { value: 'mixed', label: i18n.t('MixedMode') || 'Hidden in Details' }
        ];

        const alignModes = [
            { value: 'top', label: i18n.t('OptionSidebarItemsAlignTop') || 'Top' },
            { value: 'center', label: i18n.t('OptionSidebarItemsAlignCenter') || 'Center' },
            { value: 'bottom', label: i18n.t('OptionSidebarItemsAlignBottom') || 'Bottom' }
        ];

        const colors = [
            { value: 'white', label: i18n.t('SidebarColorWhite') || 'White' },
            { value: 'accent', label: i18n.t('SidebarColorAccent') || 'Accent' },
            { value: 'grey', label: i18n.t('SidebarColorGrey') || 'Grey' },
            { value: 'black', label: i18n.t('SidebarColorBlack') || 'Black' }
        ];

        const unselectedColors = [
            { value: 'grey', label: i18n.t('SidebarColorGrey') || 'Grey' },
            { value: 'white', label: i18n.t('SidebarColorWhite') || 'White' },
            { value: 'black', label: i18n.t('SidebarColorBlack') || 'Black' },
            { value: 'accent', label: i18n.t('SidebarColorAccent') || 'Accent' }
        ];

        const bgStyles = [
            { value: 'theme', label: i18n.t('OptionCollapsedSidebarColorTheme') || 'Follow Theme' },
            { value: 'black', label: i18n.t('OptionCollapsedSidebarColorBlack') || 'Black' },
            { value: 'semi', label: i18n.t('OptionCollapsedSidebarColorSemi') || 'Semi-transparent' },
            { value: 'tinted-semi', label: i18n.t('OptionCollapsedSidebarColorTintedSemi') || 'Tinted Semi-transparent' },
            { value: 'transparent', label: i18n.t('OptionCollapsedSidebarColorTransparent') || 'Transparent' }
        ];

        const logoOpts = [
            { value: 'visible', label: i18n.t('OptionLogoSettingsVisible') || 'Visible' },
            { value: 'settings', label: i18n.t('OptionLogoSettingsSettings') || 'Visible as Settings' },
            { value: 'home', label: i18n.t('OptionLogoSettingsHome') || 'Visible as Home' },
            { value: 'hidden', label: i18n.t('OptionLogoSettingsHidden') || 'Hidden' }
        ];

        const logoVal = (() => {
            const v = storage.getItem('pref:logoSettings') || 'visible';
            return v === 'true' ? 'settings' : v === 'false' ? 'visible' : v;
        })();

        const backOpts = [
            { value: 'auto', label: i18n.t('OptionSidebarBackButtonAuto') || 'Desktop & Web Only' },
            { value: 'all', label: i18n.t('OptionSidebarBackButtonAll') || 'All Platforms' },
            { value: 'disabled', label: i18n.t('OptionSidebarBackButtonDisabled') || 'Disabled' }
        ];

        const shadowOpts = [
            { value: 'none', label: i18n.t('OptionSidebarIconShadowsNone') || 'None' },
            { value: 'shadow', label: i18n.t('OptionSidebarIconShadowsShadow') || 'Shadow' }
        ];

        const logoColors = [
            { value: 'icon-colors', label: i18n.t('SidebarColorIconColors') || 'Icon Colors' },
            { value: 'follow-theme', label: i18n.t('SidebarColorFollowTheme') || 'Follow Theme' },
            { value: 'white', label: i18n.t('SidebarColorWhite') || 'White' },
            { value: 'black', label: i18n.t('SidebarColorBlack') || 'Black' }
        ];

        const focusControl = '<div class="setting-control" id="sidebar-focus-select-container"><div class="loading-spinner small"></div></div>';

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Sidebar">${i18n.t('Sidebar') || 'Sidebar'}</h2>
                <p class="content-subtitle" data-i18n="SidebarTabDescription">${i18n.t('SidebarTabDescription') || 'Customize navigation bar layout, pin libraries, and manage sidebar shortcuts.'}</p>

                ${this._item(i18n.t('SidebarLayout') || 'Sidebar Layout', i18n.t('SidebarLayoutDescription') || 'Choose the layout mode for the navigation sidebar.', this._drop('sidebar-layout-select', layoutModes, layoutManager.getSidebarLayout() || 'modern-collapsed'))}
                ${this._item(i18n.t('SidebarMode') || 'Sidebar Mode', i18n.t('SidebarModeDescription') || 'Choose how the sidebar behaves when collapsed.', this._drop('sidebar-mode-select', sidebarModes, storage.getItem('pref:sidebarMode') || 'shown'))}
                ${this._item(i18n.t('LabelSidebarItemsAlign') || 'Sidebar Items Alignment', i18n.t('SidebarItemsAlignDescription') || 'Choose the vertical alignment of items inside the sidebar.', this._drop('sidebar-items-align-select', alignModes, storage.getItem('pref:sidebarItemsAlign') || 'center'))}
                
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="InitialSidebarFocus">${i18n.t('InitialSidebarFocus') || 'Initial Sidebar Focus'}</span><span class="setting-description" data-i18n="InitialSidebarFocusDescription">${i18n.t('InitialSidebarFocusDescription') || 'Select which item gets focused first.'}</span></div>
                    ${focusControl}
                </div>

                ${this._item(i18n.t('SidebarSelectedColor') || 'Sidebar Selected Color', i18n.t('SidebarSelectedColorDescription') || 'Choose the color for selected sidebar items.', this._drop('sidebar-selected-color-select', colors, layoutManager.getSidebarSelectedColor()))}
                ${this._item(i18n.t('SidebarUnselectedColor') || 'Sidebar Unselected Color', i18n.t('SidebarUnselectedColorDescription') || 'Choose the color for unselected sidebar items.', this._drop('sidebar-unselected-color-select', unselectedColors, layoutManager.getSidebarUnselectedColor()))}
                ${this._item(i18n.t('LabelCollapsedSidebarColor') || 'Collapsed Sidebar Color', i18n.t('CollapsedSidebarColorDescription') || 'Background style for collapsed sidebar.', this._drop('collapsed-sidebar-color-select', bgStyles, storage.getItem('pref:collapsedSidebarColor') || 'transparent'))}
                ${this._item(i18n.t('LabelExpandedSidebarColor') || 'Expanded Sidebar Color', i18n.t('ExpandedSidebarColorDescription') || 'Background style for expanded sidebar.', this._drop('expanded-sidebar-color-select', bgStyles, storage.getItem('pref:expandedSidebarColor') || 'theme'))}
                ${this._item(i18n.t('LabelBottomNavBarColor') || 'Bottom Nav Bar Color', i18n.t('BottomNavBarColorDescription') || 'Background style for mobile bottom nav bar.', this._drop('bottom-nav-bar-color-select', bgStyles, storage.getItem('pref:bottomNavBarColor') || storage.getItem('pref:collapsedSidebarColor') || 'theme'))}
                ${this._item(i18n.t('LabelLogoSettings') || 'Litefin Logo', i18n.t('LogoSettingsDescription') || 'Top sidebar logo behavior.', this._drop('sidebar-logo-settings-select', logoOpts, logoVal))}
                ${this._item(i18n.t('KeepSidebarNavButton') || 'Keep Dedicated Sidebar Button', i18n.t('KeepSidebarNavButtonDescription') || 'Do not hide Home or Settings button when logo is mapped.', this._toggle('toggle-keep-sidebar-button', storage.getItem('pref:keepSidebarNavButton') === 'true'), 'keep-sidebar-button-item')}
                ${this._item(i18n.t('SidebarBackButton') || 'Sidebar Back Button', i18n.t('SidebarBackButtonDescription') || 'Show back button above logo.', this._drop('sidebar-back-button-select', backOpts, storage.getItem('pref:sidebarBackButton') || 'auto'))}
                ${this._item(i18n.t('SidebarIconShadows') || 'Sidebar Icon Shadows', i18n.t('SidebarIconShadowsDescription') || 'Add subtle drop shadows to sidebar icons.', this._drop('sidebar-icon-shadows-select', shadowOpts, layoutManager.getSidebarIconShadows() ? 'shadow' : 'none'))}
                ${this._item(i18n.t('SidebarLogoColor') || 'Sidebar Logo Color', i18n.t('SidebarLogoColorDescription') || 'Choose color for the Litefin logo.', this._drop('sidebar-logo-color-select', logoColors, layoutManager.getSidebarLogoColor()))}
                ${this._item(i18n.t('DisableSidebarAnimation') || 'Disable Sidebar Animation', i18n.t('DisableSidebarAnimationDescription') || 'Sidebar opens and closes instantly.', this._toggle('toggle-disable-sidebar-animation', storage.getItem('pref:disableSidebarAnimation') === 'true'))}
                ${this._item(i18n.t('ShowCollapsedLibraryIcons') || 'Show Collapsed Library Icons', i18n.t('ShowCollapsedLibraryIconsDescription') || 'Show library icons even when collapsed.', this._toggle('toggle-show-collapsed-library-icons', storage.getItem('pref:showCollapsedLibraryIcons') === 'true'))}
                ${this._item(i18n.t('HideSidebarLibraryHeader') || 'Hide Sidebar Library Header', i18n.t('HideSidebarLibraryHeaderDescription') || 'Hide My Media title and divider.', this._toggle('toggle-hide-sidebar-library-header', storage.getItem('pref:hideSidebarLibraryHeader') === 'true'))}

                <h3 class="setting-section-title" data-i18n="SidebarOrder" style="margin-top: 40px;">${i18n.t('SidebarOrder') || 'Sidebar Order'}</h3>
                <div class="home-layout-container" id="sidebar-layout-container">
                    <div class="setting-item"><div class="setting-label"><div class="loading-spinner small"></div></div></div>
                </div>

                <h3 class="setting-section-title" data-i18n="MyMediaOrder" style="margin-top: 40px;">${i18n.t('MyMediaOrder') || 'My Media Order'}</h3>
                <div class="home-layout-container" id="sidebar-lib-layout-container">
                    <div class="setting-item"><div class="setting-label"><div class="loading-spinner small"></div></div></div>
                </div>
            </div>
        `;
    }

    async setupSidebarLayoutUI() {
        const topContainer = this.page.$('#sidebar-layout-container');
        const libContainer = this.page.$('#sidebar-lib-layout-container');
        const focusSelectContainer = this.page.$('#sidebar-focus-select-container');
        if (!topContainer) return;

        try {
            const viewsResponse = await api.getUserViews();
            const views = viewsResponse.Items || [];

            const liveStaticItems = sidebarLayoutManager.getStaticItems().map((s) => ({ ...s, label: i18n.t(s.label) || s.label }));
            const liveLibraries = views.map((lib) => ({ id: `lib-${lib.Id}`, label: lib.Name }));

            const layoutVars = sidebarLayoutManager.buildSettingsLayout(liveStaticItems);
            const libraryVars = sidebarLayoutManager.buildLibrarySettingsLayout(liveLibraries);

            const buildListHtml = (vars) => {
                return vars.map((item, index) => {
                    const isFirst = index === 0;
                    const isLast = index === vars.length - 1;
                    const isLocked = item.locked;
                    const eye = (!item.hidden || isLocked) ? EYE_ON : EYE_OFF;
                    return `
                    <div class="setting-item layout-row ${item.hidden && !isLocked ? 'layout-row-hidden' : ''}" data-id="${item.id}" data-index="${index}">
                        <div class="setting-label"><span class="setting-name layout-row-title">${item.label}</span></div>
                        <div class="setting-control layout-btns" dir="ltr">
                            <button class="btn btn-icon layout-btn-up" tabindex="0" ${isFirst ? 'disabled' : ''} aria-label="Move Up">${UP_SVG}</button>
                            <button class="btn btn-icon layout-btn-down" tabindex="0" ${isLast ? 'disabled' : ''} aria-label="Move Down">${DOWN_SVG}</button>
                            <button class="btn btn-icon layout-btn-toggle" tabindex="0" ${isLocked ? 'disabled style="opacity:0.3"' : ''} aria-label="${!item.hidden || isLocked ? 'Hide' : 'Show'}">${eye}</button>
                        </div>
                    </div>`;
                }).join('');
            };

            const bindContainer = (containerDOM, varsArray, renderCb) => {
                const save = () => {
                    const cfg = sidebarLayoutManager.getSavedConfig() || { defaultFocus: 'home' };
                    cfg.items = layoutVars.map(({ id, hidden, order }) => ({ id, hidden, order }));
                    cfg.libraryItems = libraryVars.map(({ id, hidden, order }) => ({ id, hidden, order }));
                    sidebarLayoutManager.saveConfig(cfg);
                    eventBus.emit('prefChanged:sidebarLayout');
                };

                containerDOM.onclick = (e) => {
                    const btn = e.target.closest('button');
                    const row = e.target.closest('.layout-row');
                    if (!btn || !row) return;
                    const idx = parseInt(row.dataset.index, 10);

                    if (btn.classList.contains('layout-btn-up') && idx > 0) {
                        [varsArray[idx - 1], varsArray[idx]] = [varsArray[idx], varsArray[idx - 1]];
                        save();
                        renderCb();
                        setTimeout(() => { const r = containerDOM.querySelector(`.layout-row[data-index="${idx - 1}"]`); if (r) focusManager.focusElement(r.querySelector('.layout-btn-up')); }, 50);
                    } else if (btn.classList.contains('layout-btn-down') && idx < varsArray.length - 1) {
                        [varsArray[idx + 1], varsArray[idx]] = [varsArray[idx], varsArray[idx + 1]];
                        save();
                        renderCb();
                        setTimeout(() => { const r = containerDOM.querySelector(`.layout-row[data-index="${idx + 1}"]`); if (r) focusManager.focusElement(r.querySelector('.layout-btn-down')); }, 50);
                    } else if (btn.classList.contains('layout-btn-toggle') && !varsArray[idx].locked) {
                        varsArray[idx].hidden = !varsArray[idx].hidden;
                        if (varsArray[idx].hidden && sidebarLayoutManager.getDefaultFocus() === varsArray[idx].id) {
                            const cfg = sidebarLayoutManager.getSavedConfig() || {};
                            cfg.defaultFocus = 'home';
                            sidebarLayoutManager.saveConfig(cfg);
                        }
                        save();
                        renderCb();
                        setTimeout(() => { const r = containerDOM.querySelector(`.layout-row[data-index="${idx}"]`); if (r) focusManager.focusElement(r.querySelector('.layout-btn-toggle')); }, 50);
                    }
                };
            };

            const renderUI = () => {
                if (!layoutVars.length) {
                    topContainer.innerHTML = `<span class="setting-description">No layout configuration available.</span>`;
                    return;
                }

                if (focusSelectContainer) {
                    const visibleItems = layoutVars.filter((v) => !v.hidden || v.locked);
                    const validTargets = visibleItems.filter((v) => v.id !== 'librariesContainer');
                    const options = validTargets.map((item) => ({ value: item.id, label: item.label }));

                    focusSelectContainer.innerHTML = this._drop('sidebar-default-focus-select', options, sidebarLayoutManager.getDefaultFocus());
                    const btn = focusSelectContainer.querySelector('.select-btn');
                    if (btn) {
                        btn.onclick = () => {
                            const title = i18n.t('InitialSidebarFocus') || 'Initial Sidebar Focus';
                            if (typeof this.page._renderSelectionModal === 'function') {
                                this.page._renderSelectionModal(title, options, btn.dataset.value, (newValue) => {
                                    const newLabel = options.find((o) => String(o.value) === String(newValue))?.label;
                                    const labelSpan = btn.querySelector('.btn-label');
                                    if (labelSpan) labelSpan.innerText = newLabel;
                                    btn.dataset.value = newValue;
                                    const cfg = sidebarLayoutManager.getSavedConfig() || { items: layoutVars, libraryItems: libraryVars };
                                    cfg.defaultFocus = newValue;
                                    sidebarLayoutManager.saveConfig(cfg);
                                    eventBus.emit('prefChanged:sidebarLayout');
                                });
                            }
                        };
                    }
                }

                topContainer.innerHTML = `<div class="home-layout-list">${buildListHtml(layoutVars)}</div>`;
                bindContainer(topContainer, layoutVars, renderUI);

                if (libContainer) {
                    libContainer.innerHTML = `<div class="home-layout-list">${buildListHtml(libraryVars)}</div>`;
                    bindContainer(libContainer, libraryVars, renderUI);
                }

                focusManager.invalidateCache('settings-content');
            };

            renderUI();
        } catch (e) {
            log.error('Failed to load sidebar layouts', e);
            topContainer.innerHTML = `<span class="setting-description">Error loading layouts.</span>`;
        }
    }

    async mount(root) {
        const rootEl = root || (this.page && this.page.element) || document;

        const bindToggle = (sel, key, evt) => {
            const btn = rootEl.querySelector(sel);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const cur = storage.getItem(key) === 'true';
                const next = !cur;
                storage.setItem(key, next.toString());
                storage.flush();
                btn.classList.toggle('active', next);
                if (evt) eventBus.emit(evt, next);
            });
        };

        bindToggle('#toggle-keep-sidebar-button', 'pref:keepSidebarNavButton', 'pref:keepSidebarNavButton');
        bindToggle('#toggle-disable-sidebar-animation', 'pref:disableSidebarAnimation', 'prefChanged:disableSidebarAnimation');
        bindToggle('#toggle-show-collapsed-library-icons', 'pref:showCollapsedLibraryIcons', 'prefChanged:showCollapsedLibraryIcons');
        bindToggle('#toggle-hide-sidebar-library-header', 'pref:hideSidebarLibraryHeader', 'prefChanged:hideSidebarLibraryHeader');

        await this.setupSidebarLayoutUI();
    }

    destroy() {
        this._listeners.forEach((fn) => {
            try { fn(); } catch (_) {}
        });
        this._listeners = [];
    }
}
