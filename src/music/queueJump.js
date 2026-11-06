/* QueueModal has already moved the queue cursor; with shuffle on that reorders the queue, so the picked index is stale. */
export function playFromQueueCursor(queue, session) {
    return session.playItems(queue.getQueue().slice(), queue.getCurrentIndex());
}
