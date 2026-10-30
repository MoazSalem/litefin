const DISABLED_TIERS = ['legacy', 'ultra-legacy'];

export function ambientEnabled() {
    if (typeof __BUILD_TIER__ !== 'undefined' && DISABLED_TIERS.includes(__BUILD_TIER__)) return false;
    if (typeof document === 'undefined') return true;
    return document.documentElement.getAttribute('data-light-music-player') !== 'true';
}
