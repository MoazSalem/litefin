/**
 * ============================================================================
 * Litefin - Streaming availability presentation shared by title details pages
 * ============================================================================
 */

import { watchProviderCountryNames } from './WatchProviderCountryNames.js';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Returns the configured ISO country code, defaulting to Italy. */
export function watchProviderRegion(value) {
    return typeof value === 'string' && /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : 'IT';
}

/** Uses localized country names, including on TVs without Intl.DisplayNames. */
export function watchProviderRegionName(region, language) {
    const code = watchProviderRegion(region);
    try {
        if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
            const name = new Intl.DisplayNames([language], { type: 'region' }).of(code);
            if (name && name !== code) return name;
        }
    } catch (_) {
        // Fall back to bundled names when the TV cannot resolve localized regions.
    }
    const locale = String(language || 'en')
        .toLowerCase()
        .split(/[-_]/)[0];
    const names = watchProviderCountryNames[locale] || watchProviderCountryNames.en;
    return names[code] || code;
}

/** Only film and series IDs identify the title whose streaming availability is requested. */
export function watchProviderTarget(item) {
    if (!item || (item.Type !== 'Movie' && item.Type !== 'Series')) return null;
    const ids = item.ProviderIds || {};
    const id = String(ids.Tmdb || ids.tmdb || ids.TMDB || '');
    if (!/^[1-9][0-9]*$/.test(id)) return null;
    return { mediaType: item.Type === 'Series' ? 'tv' : 'movie', tmdbId: id };
}

/** Selects a single market; never substitutes availability from a different country. */
export function providersForRegion(providers, region) {
    const market = Array.isArray(providers) ? providers.find((entry) => entry && entry.iso_3166_1 === region) : null;
    const normalize = (entries) => {
        const seen = new Set();
        return (Array.isArray(entries) ? entries : [])
            .filter((entry) => {
                if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) return false;
                const key = entry.id == null ? entry.name.trim().toLowerCase() : entry.id;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice()
            .sort((a, b) => (a.displayPriority || 0) - (b.displayPriority || 0));
    };
    return { flatrate: normalize(market && market.flatrate), buy: normalize(market && market.buy) };
}

/** Renders informational availability without introducing TV focus targets. */
export function renderWatchProviders(providers, region, translate, language) {
    const groups = providersForRegion(providers, region);
    const cards = (entries) =>
        entries
            .map((entry) => {
                // Only TMDB image paths are accepted, never arbitrary URLs or markup.
                const logo =
                    typeof entry.logoPath === 'string' && /^\/[a-zA-Z0-9._-]+$/.test(entry.logoPath)
                        ? `<img src="https://image.tmdb.org/t/p/w92${entry.logoPath}" alt="" width="40" height="40">`
                        : '';
                const content = `${logo}<span>${escapeHtml(entry.name)}</span>`;
                return `<li class="watch-provider">${content}</li>`;
            })
            .join('');
    const rows = [
        ['flatrate', 'WatchProvidersSubscription'],
        ['buy', 'WatchProvidersBuy']
    ]
        .filter(([key]) => groups[key].length)
        .map(
            ([key, label]) => `<div class="watch-provider-group">
            <h3>${escapeHtml(translate(label))}</h3>
            <ul class="watch-provider-list">${cards(groups[key])}</ul>
        </div>`
        )
        .join('');
    return `<section class="watch-providers" aria-label="${escapeHtml(translate('WatchProvidersTitle'))}">
        <h2>${escapeHtml(translate('WatchProvidersTitle'))} — ${escapeHtml(watchProviderRegionName(region, language))}</h2>
        ${rows || `<p class="watch-providers-empty">${escapeHtml(translate('WatchProvidersEmpty'))}</p>`}
    </section>`;
}
