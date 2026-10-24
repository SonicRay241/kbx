/**
 * One-shot hand-off from the global search to the board it targets: "open this
 * card and make it obvious". A module-level channel instead of a URL param, so
 * the route contract stays unchanged and nothing lands in history.
 *
 * Two delivery paths are needed: the board may already be mounted (search from
 * its own page → navigate to the same route does not remount), or it may mount
 * right after (any other page → pending is picked up on subscribe).
 */
type Listener = { boardId: number; onHighlight: (cardId: number) => void }

let pending: { boardId: number; cardId: number; at: number } | null = null
const listeners = new Set<Listener>()

/** Stale requests expire so an old search never flashes a card later. */
const TTL_MS = 5000

function deliver(): void {
  if (!pending) return
  if (Date.now() - pending.at > TTL_MS) {
    pending = null
    return
  }
  for (const listener of listeners) {
    if (listener.boardId !== pending.boardId) continue
    const { cardId } = pending
    pending = null
    listener.onHighlight(cardId)
    return
  }
}

export function requestCardHighlight(boardId: number, cardId: number): void {
  pending = { boardId, cardId, at: Date.now() }
  deliver()
}

export function subscribeCardHighlight(
  boardId: number,
  onHighlight: (cardId: number) => void,
): () => void {
  const listener: Listener = { boardId, onHighlight }
  listeners.add(listener)
  deliver()
  return () => {
    listeners.delete(listener)
  }
}
