const COPY_MIMES = {
    eac3: 'audio/mp4; codecs="ec-3"',
    ac3: 'audio/mp4; codecs="ac-3"',
    aac: 'audio/mp4; codecs="mp4a.40.2"'
};
const FLAC_SOURCE = { audioCodec: 'flac', sampleRate: 48000, mime: 'audio/mp4; codecs="flac"' };

export function mseSourceFor(mediaSource) {
    const stream = mediaSource?.MediaStreams?.find((s) => s.Type === 'Audio');
    const codec = String(stream?.Codec ?? '').toLowerCase();
    const mime = COPY_MIMES[codec];
    if (mime) return { audioCodec: 'copy', sampleRate: null, mime, format: mime };
    /* the server keeps the source bit depth in the flac it transcodes to, and that changes the init segment */
    return { ...FLAC_SOURCE, format: stream?.BitDepth ? `flac/${stream.BitDepth}` : 'flac' };
}

export function supportsMse(win, mime) {
    const MediaSource = win?.MediaSource;
    return Boolean(
        MediaSource && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(mime)
    );
}
