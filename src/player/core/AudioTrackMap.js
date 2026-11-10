/**
 * AudioTrackMap — maps a Jellyfin audio stream to a webOS native track position.
 *
 * Observed on webOS: the TV's audioTracks list leaves out a leading TrueHD track
 * and moves the default track to the front. The rest keep file order. So:
 *   1. drop the leading TrueHD stream (the TV cannot select it natively),
 *   2. move the first remaining default stream to the front,
 *   3. the native position is the index in that list.
 *
 * This applies only when the native list is exactly one shorter than the Jellyfin
 * list and the first stream is TrueHD. Every other case returns null, so the caller
 * keeps its existing strategies.
 *
 * Kept free of imports so it can be unit-tested without a DOM.
 *
 * @module core/AudioTrackMap
 */

/**
 * @param {Array<{Index:number, Codec?:string, IsDefault?:boolean}>} jellyfinStreams - Audio
 *        streams in file order, filtered the same way as the backend track list
 * @param {number} nativeCount - Length of the TV's native audioTracks list
 * @param {number} targetStreamIndex - Jellyfin stream index being selected
 * @returns {number|null} Native position (>= 0); -1 when the target is the dropped TrueHD track;
 *          null when the rule does not apply
 */
export function mapDefaultFirstAudioIndex(jellyfinStreams, nativeCount, targetStreamIndex) {
    if (!Array.isArray(jellyfinStreams) || jellyfinStreams.length === 0) return null;
    if (nativeCount !== jellyfinStreams.length - 1) return null;

    const first = jellyfinStreams[0];
    const firstCodec = String(first?.Codec || '').toLowerCase();
    if (firstCodec !== 'truehd' && firstCodec !== 'mlp') return null;

    if (targetStreamIndex === first.Index) return -1;

    const remaining = jellyfinStreams.slice(1);
    const defaultPos = remaining.findIndex((s) => s.IsDefault);
    const ordered = defaultPos > 0
        ? [remaining[defaultPos], ...remaining.slice(0, defaultPos), ...remaining.slice(defaultPos + 1)]
        : remaining;

    const position = ordered.findIndex((s) => s.Index === targetStreamIndex);
    return position >= 0 ? position : null;
}
