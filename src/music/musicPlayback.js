import MusicSession from './MusicSession.js';
import HybridAudioEngine from './HybridAudioEngine.js';
import GaplessAudioEngine from './GaplessAudioEngine.js';
import NativeAudioBackend from './NativeAudioBackend.js';
import MseAudioEngine from './MseAudioEngine.js';
import { supportsMse } from './mseFormat.js';
import { describeMusicTrack } from './trackDescriptor.js';
import { supportsGaplessEngine } from './trackKind.js';
import { watchSoundOutput } from './soundOutput.js';
import { NOW_PLAYING_PATH, wireMusicSession } from './musicWiring.js';
import { api } from '../api/ApiClient.js';
import { buildJellyfinProfile } from '../api/DeviceProfile.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { playQueue } from '../core/PlayQueue.js';
import { toast } from '../ui/Toast.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { platformInfo } from '../utils/PlatformInfo.js';

const log = logger.create('MusicSession');

export { NOW_PLAYING_PATH };

const gaplessAvailable = supportsGaplessEngine(typeof window === 'undefined' ? undefined : window);

let soundOutput = null;

if (platformInfo.isWebOS && typeof window !== 'undefined' && window.PalmServiceBridge) {
    try {
        watchSoundOutput(
            () => new window.PalmServiceBridge(),
            (value) => {
                soundOutput = value;
                log.info('Sound output:', value, value === 'tv_speaker' ? '(gapless engine)' : '(MSE)');
            }
        );
    } catch (err) {
        log.warn('Could not watch the sound output setting:', err);
    }
}

let deviceProfile = null;

function getDeviceProfile() {
    if (!deviceProfile) deviceProfile = buildJellyfinProfile();
    return deviceProfile;
}

function describeTrack(item, mediaSource) {
    const win = typeof window === 'undefined' ? undefined : window;
    const descriptor = describeMusicTrack({
        item,
        mediaSource,
        soundOutput,
        platform: { isWebOS: platformInfo.isWebOS, isEmby: api.isEmby(), gaplessAvailable },
        supportsMse: (mime) => supportsMse(win, mime),
        api,
        now: Date.now()
    });
    log.debug(`Track ${item.Id} routed to ${descriptor.kind} (sound output: ${soundOutput || 'unknown'})`);
    return descriptor;
}

function engineFactory(callbacks) {
    return new HybridAudioEngine({
        ...callbacks,
        createGapless: (routed) => new GaplessAudioEngine(routed),
        createMse: (routed) => new MseAudioEngine(routed),
        createNative: (routed) =>
            new NativeAudioBackend({
                ...routed,
                preloadNextElement: !platformInfo.isWebOS,
                log: logger.create('NativeAudioBackend')
            })
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

wireMusicSession({ session: musicSession, bus: eventBus, state, nowPlayingPath: NOW_PLAYING_PATH, log });
