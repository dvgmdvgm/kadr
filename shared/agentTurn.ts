// Where a turn of the embedded Claude begins (card B8). The pty carries no turn
// boundary, so main infers one from the bridge: the first /eval after the
// user's last keystroke in the panel, or after 20 s with no eval running, is a
// new turn — and the page checkpoints the project before running it.
// Silence counts from the END of the last eval, so a long tool call (an
// export) never splits a turn; errs towards more checkpoints otherwise.

export const TURN_SILENCE_MS = 20_000

// what xterm sends on its own: focus in/out, cursor-position and device-attribute replies
const TERMINAL_REPLY = /^(?:\x1b\[[IO]|\x1b\[\??\d+(?:;\d+)*R|\x1b\[[?>][\d;]*c)+$/

/** true for input the user produced (keys, paste), false for terminal replies */
export const isUserInput = (data: string): boolean => data.length > 0 && !TERMINAL_REPLY.test(data)

export function turnTracker() {
  let lastInput = -Infinity
  let lastStart = -Infinity
  let lastActive = -Infinity
  return {
    input(data: string, now = Date.now()) {
      if (isUserInput(data)) lastInput = now
    },
    /** an eval begins; true when it opens a new turn */
    evalStart(now = Date.now()): boolean {
      const fresh = lastInput >= lastStart || now - lastActive > TURN_SILENCE_MS
      lastStart = now
      lastActive = Math.max(lastActive, now)
      return fresh
    },
    evalEnd(now = Date.now()) {
      lastActive = Math.max(lastActive, now)
    }
  }
}
