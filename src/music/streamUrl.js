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
