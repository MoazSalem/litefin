export const FEED_STEP = Object.freeze({
    APPEND: 'append',
    CLOSE: 'close',
    START_NEXT: 'startNext',
    WAIT: 'wait',
    END: 'end'
});

export const NEXT_STATE = Object.freeze({
    NONE: 'none',
    PENDING: 'pending',
    STARTED: 'started',
    BLOCKED: 'blocked'
});

export function nextState({ track, key, blocked }) {
    if (!track) return NEXT_STATE.NONE;
    if (blocked) return NEXT_STATE.BLOCKED;
    return key ? NEXT_STATE.STARTED : NEXT_STATE.PENDING;
}

/* a pending init segment is appended even with a full buffer; it is tiny and announces the next track's codec.
   The stream ends only when nothing is left to append and no appendable next track is known */
export function nextFeedStep({ head, bufferFull, next }) {
    if (head) {
        if (head.init) return FEED_STEP.APPEND;
        if (head.index >= head.playlist.segments.length) return FEED_STEP.CLOSE;
        return bufferFull ? FEED_STEP.WAIT : FEED_STEP.APPEND;
    }
    if (next === NEXT_STATE.PENDING) return FEED_STEP.START_NEXT;
    return next === NEXT_STATE.STARTED ? FEED_STEP.WAIT : FEED_STEP.END;
}
