import MusicSession from './MusicSession.js';
import HybridAudioEngine from './HybridAudioEngine.js';
import GaplessAudioEngine from './GaplessAudioEngine.js';
import NativeAudioBackend from './NativeAudioBackend.js';
import { buildStaticAudioUrl } from './streamUrl.js';
import { audioKindOf, supportsGaplessEngine } from './trackKind.js';
import { api } from '../api/ApiClient.js';
import { buildJellyfinProfile } from '../api/DeviceProfile.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { playQueue } from '../core/PlayQueue.js';
import { toast } from '../ui/Toast.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('MusicSession');

export const NOW_PLAYING_PATH = '/now-playing';

const gaplessAvailable = supportsGaplessEngine(typeof window === 'undefined' ? undefined : window);

let deviceProfile = null;

function getDeviceProfile() {
    if (!deviceProfile) deviceProfile = buildJellyfinProfile();
    return deviceProfile;
}

function describeTrack(item, mediaSource) {
    const url = buildStaticAudioUrl({
        serverUrl: api.serverUrl,
        itemId: item.Id,
        mediaSourceId: mediaSource.Id,
        token: api.accessToken,
        deviceId: api.deviceId,
        isEmby: api.isEmby()
    });
    const kind = gaplessAvailable && audioKindOf(mediaSource) === 'flac' ? 'flac' : 'native';
    return { url, kind };
}

function engineFactory(callbacks) {
    return new HybridAudioEngine({
        ...callbacks,
        createGapless: (routed) => new GaplessAudioEngine(routed),
        createNative: (routed) => new NativeAudioBackend({ ...routed, log: logger.create('NativeAudioBackend') })
    });
}

export const musicSession = new MusicSession({
    engineFactory,
    api,
    queue: playQueue,
    bus: eventBus,
    describeTrack,
    notify: (name) => toast.show(i18n.t('music.trackSkipped', [name])),
    getDeviceProfile,
    log
});

const runSafely = (promise) => Promise.resolve(promise).catch((err) => log.warn('Music command failed', err));

const routePath = (path) => (path || '').split('?')[0];

let activeSubscriptions = [];
let lastItemId = null;

function bindWhileActive() {
    if (activeSubscriptions.length > 0) return;
    activeSubscriptions = [
        eventBus.on('key:play', () => musicSession.resume()),
        eventBus.on('key:pause', () => musicSession.pause()),
        eventBus.on('key:playPause', () => musicSession.togglePlayPause()),
        eventBus.on('key:next', () => runSafely(musicSession.next())),
        eventBus.on('key:previous', () => runSafely(musicSession.previous())),
        eventBus.on('key:stop', () => runSafely(musicSession.stop('user'))),
        eventBus.on('router:navigate', ({ path }) => {
            if (routePath(path) !== NOW_PLAYING_PATH) runSafely(musicSession.stop('left-now-playing'));
        })
    ];
}

function unbindWhileActive() {
    activeSubscriptions.forEach((unsubscribe) => unsubscribe());
    activeSubscriptions = [];
}

eventBus.on('music:track', ({ item }) => {
    lastItemId = item.Id;
    state.set('music:currentItemId', item.Id);
    bindWhileActive();
});

/* Lets the global player:play listeners (screensaver, webOS keep-screen-on, SmartHub) release their playback hold. */
eventBus.on('music:stopped', ({ reason }) => {
    unbindWhileActive();
    state.set('music:currentItemId', null);
    eventBus.emit('player:stopped', { itemId: lastItemId, reason });
    lastItemId = null;
});
