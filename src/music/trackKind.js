const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');

/* The gapless engine parses a raw FLAC byte stream, so FLAC wrapped in Ogg/Matroska must stay native. */
export function audioKindOf(mediaSource) {
    if (!mediaSource) return 'native';
    const container = lower(mediaSource.Container);
    if (container) return container === 'flac' ? 'flac' : 'native';
    const audio = (mediaSource.MediaStreams || []).find((stream) => stream.Type === 'Audio');
    return lower(audio?.Codec) === 'flac' ? 'flac' : 'native';
}

export function supportsGaplessEngine(win) {
    if (!win) return false;
    const hasWebAudio = Boolean(win.AudioContext || win.webkitAudioContext);
    return hasWebAudio && typeof win.fetch === 'function' && typeof win.ReadableStream === 'function';
}
