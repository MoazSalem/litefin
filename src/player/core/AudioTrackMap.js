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
 * @param {Array<{Index:number, Codec?:string, IsDefault?:boolean}>} containerAudioStreams - Physical
 *        container audio streams in container file order (unfiltered)
 * @param {number} nativeCount - Length of the TV's native audioTracks list
 * @param {number} targetStreamIndex - Jellyfin stream index being selected
 * @returns {number|null} Native position (>= 0); -1 when the target is the dropped TrueHD track;
 *          null when the rule does not apply
 */
export function mapDefaultFirstAudioIndex(containerAudioStreams, nativeCount, targetStreamIndex) {
    // Basic argument validation: ensure container streams collection is non-empty
    if (!Array.isArray(containerAudioStreams) || containerAudioStreams.length === 0) return null;

    // The heuristic applies exclusively when the TV demuxer dropped exactly one stream
    if (nativeCount !== containerAudioStreams.length - 1) return null;

    // Inspect the leading physical container stream
    const first = containerAudioStreams[0];
    const firstCodec = String(first?.Codec || '').toLowerCase();

    // Verify whether the dropped stream is indeed TrueHD or MLP
    if (firstCodec !== 'truehd' && firstCodec !== 'mlp') return null;

    // If target stream is the dropped TrueHD track, signal that it is not selectable
    if (targetStreamIndex === first.Index) return -1;

    // Exclude the dropped primary TrueHD track and inspect remaining streams
    const remaining = containerAudioStreams.slice(1);

    // Locate the first designated default track among remaining streams
    const defaultPos = remaining.findIndex((s) => s.IsDefault);

    // If a default track exists downstream, shift it to native position 0
    const ordered = defaultPos > 0
        ? [remaining[defaultPos], ...remaining.slice(0, defaultPos), ...remaining.slice(defaultPos + 1)]
        : remaining;

    // Resolve native index of the target stream within the reconstructed list
    const position = ordered.findIndex((s) => s.Index === targetStreamIndex);
    return position >= 0 ? position : null;
}
