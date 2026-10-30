import { buildHlsAudioUrl, buildStaticAudioUrl } from './streamUrl.js';
import { mseSourceFor } from './mseFormat.js';
import { routeTrack } from './trackKind.js';

export function describeMusicTrack({ item, mediaSource, playSessionId, soundOutput, platform, supportsMse, api }) {
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
            playSessionId,
            audioCodec: mseSource.audioCodec,
            sampleRate: mseSource.sampleRate
        });
        const playMethod = mseSource.audioCodec === 'copy' ? 'DirectStream' : 'Transcode';
        return { url, kind, mime: mseSource.mime, playMethod };
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
