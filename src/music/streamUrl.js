export function buildStaticAudioUrl({ serverUrl, itemId, mediaSourceId, token, deviceId, isEmby }) {
    const authKey = isEmby ? 'api_key' : 'ApiKey';
    const query = [
        'static=true',
        `mediaSourceId=${encodeURIComponent(mediaSourceId)}`,
        `deviceId=${encodeURIComponent(deviceId)}`,
        `${authKey}=${encodeURIComponent(token)}`
    ].join('&');
    return `${serverUrl}/Audio/${itemId}/stream?${query}`;
}

// Never request eac3 here: the server would re-encode and drop Atmos; Atmos passes through via audioCodec=copy.
export function buildHlsAudioUrl({
    serverUrl,
    itemId,
    mediaSourceId,
    token,
    deviceId,
    playSessionId,
    audioCodec,
    sampleRate
}) {
    const query = [
        `mediaSourceId=${encodeURIComponent(mediaSourceId)}`,
        `deviceId=${encodeURIComponent(deviceId)}`,
        `PlaySessionId=${encodeURIComponent(playSessionId)}`,
        'segmentContainer=mp4',
        `audioCodec=${audioCodec}`,
        ...(sampleRate ? [`audioSampleRate=${sampleRate}`] : []),
        'segmentLength=4',
        `ApiKey=${encodeURIComponent(token)}`
    ].join('&');
    return `${serverUrl}/Audio/${itemId}/main.m3u8?${query}`;
}
