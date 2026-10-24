import { classifyRoute } from './musicSection.js';

const noop = () => {};

export const NOW_PLAYING_PATH = '/now-playing';

/* A video taking over has already raised its own player:play hold; releasing it here would let the screen sleep. */
const releasesHold = (reason) => reason !== 'video';

const routePath = (path) => (path || '').split('?')[0];

export function wireMusicSession({ session, bus, state, log = { warn: noop } }) {
    const runSafely = (promise) => Promise.resolve(promise).catch((err) => log.warn('Music command failed', err));
    let activeSubscriptions = [];
    let currentItem = null;
    let latestPath = null;

    const bindWhileActive = () => {
        if (activeSubscriptions.length > 0) return;
        activeSubscriptions = [
            bus.on('key:play', () => session.resume()),
            bus.on('key:pause', () => session.pause()),
            bus.on('key:playPause', () => session.togglePlayPause()),
            bus.on('key:next', () => runSafely(session.next())),
            bus.on('key:previous', () => runSafely(session.previous())),
            bus.on('key:stop', () => runSafely(session.stop('user'))),
            bus.on('router:navigate', ({ path }) => {
                latestPath = path;
                if (classifyRoute(routePath(path)) === 'outside') runSafely(session.stop('left-music'));
            }),
            bus.on('music:context', ({ path, isMusic }) => {
                if (path !== latestPath || isMusic) return;
                if (classifyRoute(routePath(path)) === 'pending') runSafely(session.stop('left-music'));
            })
        ];
    };

    const unbindWhileActive = () => {
        activeSubscriptions.forEach((unsubscribe) => unsubscribe());
        activeSubscriptions = [];
        latestPath = null;
    };

    const subscriptions = [
        bus.on('music:track', ({ item }) => {
            currentItem = item;
            state.set('music:currentItemId', item.Id);
            bindWhileActive();
        }),
        bus.on('music:state', ({ isPlaying }) => {
            if (!currentItem) return;
            bus.emit(isPlaying ? 'player:playing' : 'player:paused', { item: currentItem });
        }),
        bus.on('music:stopped', ({ reason }) => {
            const itemId = currentItem ? currentItem.Id : null;
            currentItem = null;
            unbindWhileActive();
            state.set('music:currentItemId', null);
            if (releasesHold(reason)) bus.emit('player:stopped', { itemId, reason });
        })
    ];

    return () => {
        unbindWhileActive();
        subscriptions.forEach((unsubscribe) => unsubscribe());
    };
}

export async function startMusicPlayback(request, deps) {
    const { session, bus, queue, resolve, getCurrentPath, navigate, notifyNothingPlayable, log } = deps;
    const nowPlayingPath = deps.nowPlayingPath || NOW_PLAYING_PATH;
    const releaseHold = (reason) => {
        notifyNothingPlayable();
        bus.emit('player:stopped', { itemId: request.item.Id, reason });
    };
    const startPath = getCurrentPath();
    try {
        const { tracks, startIndex } = await resolve(request);
        if (tracks.length === 0) {
            log.warn('No playable audio tracks found for:', request.item.Id);
            releaseHold('empty');
            return;
        }
        queue.setShuffleMode(Boolean(request.shuffle));
        await session.playItems(tracks, startIndex);
    } catch (err) {
        log.error('Failed to start music playback:', err);
        releaseHold('error');
        return;
    }
    if (!session.isActive) return;
    if (getCurrentPath() !== startPath) {
        await session.stop('left-now-playing');
        return;
    }
    navigate(nowPlayingPath);
}
