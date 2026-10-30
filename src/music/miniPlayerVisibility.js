import { classifyRoute } from './musicSection.js';

const NOW_PLAYING_PATH = '/now-playing';

export function miniPlayerVisible({ active, path }) {
    if (!active) return false;
    const route = (path || '').split('?')[0];
    return route !== NOW_PLAYING_PATH && classifyRoute(route) !== 'outside';
}
