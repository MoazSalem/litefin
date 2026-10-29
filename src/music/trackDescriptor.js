import { buildHlsAudioUrl, buildStaticAudioUrl } from './streamUrl.js';
import { mseSourceFor } from './mseFormat.js';
import { routeTrack } from './trackKind.js';

export function describeMusicTrack({ item, mediaSource, soundOutput, platform, supportsMse, api, now }) {
    const mseSource = mseSourceFor(mediaSource);
    const kind = routeTrack({
        soundOutput,
        isWebOS: platform.isWebOS,
        isEmby: platform.isEmby,
        gaplessAvailable: platform.gaplessAvailable,
        mseAvailable: supportsMse(mseSource.mime),
        mediaSource
    });
    if (kind === 'mse') {
        const url = buildHlsAudioUrl({
            serverUrl: api.serverUrl,
            itemId: item.Id,
            mediaSourceId: mediaSource.Id,
            token: api.accessToken,
            deviceId: api.deviceId,
            playSessionId: `${api.deviceId}-${item.Id}-${now}`,
            audioCodec: mseSource.audioCodec,
            sampleRate: mseSource.sampleRate
        });
        return { url, kind, mime: mseSource.mime };
    }
    const url = buildStaticAudioUrl({
        serverUrl: api.serverUrl,
        itemId: item.Id,
        mediaSourceId: mediaSource.Id,
        token: api.accessToken,
        deviceId: api.deviceId,
        isEmby: platform.isEmby
    });
    return { url, kind };
}
