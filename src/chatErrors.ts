// Error banners for the chat screen.
//
// A message is either global (about the server or the app, shown in every
// session) or tied to one session (shown only while that session is open).
// Everything here is pure: each function returns a new state and leaves the
// one it was given untouched, so the owner of a message lives in the same
// React state as the message itself.

export type SessionError = {
  message: string
  // True when the message was copied from the server's run for that session.
  // Those are cleared only when the run's error clears, not by the user acting.
  fromRun: boolean
}

export type ChatErrors = {
  global: string | null
  bySession: Record<string, SessionError>
}

export const emptyChatErrors: ChatErrors = { global: null, bySession: {} }

function without(
  bySession: Record<string, SessionError>,
  sessionId: string,
): Record<string, SessionError> {
  if (!(sessionId in bySession)) return bySession
  const next = { ...bySession }
  delete next[sessionId]
  return next
}

// Show a message in every session. Null clears it.
export function setGlobal(state: ChatErrors, message: string | null): ChatErrors {
  if (state.global === message) return state
  return { ...state, global: message }
}

// Show a message only in one session. Null clears that session's entry.
export function setSession(
  state: ChatErrors,
  sessionId: string,
  message: string | null,
  fromRun = false,
): ChatErrors {
  if (message === null) {
    const bySession = without(state.bySession, sessionId)
    return bySession === state.bySession ? state : { ...state, bySession }
  }
  const current = state.bySession[sessionId]
  if (current && current.message === message && current.fromRun === fromRun) return state
  return { ...state, bySession: { ...state.bySession, [sessionId]: { message, fromRun } } }
}

// Copy the server run's error for a session. A message sets a run entry (unless
// the same one is already there); null clears the entry only if it came from
// the run, so a refusal shown beside it is left alone.
export function mirrorRun(
  state: ChatErrors,
  sessionId: string,
  runError: string | null,
): ChatErrors {
  if (runError !== null) return setSession(state, sessionId, runError, true)
  const current = state.bySession[sessionId]
  if (!current || !current.fromRun) return state
  const bySession = without(state.bySession, sessionId)
  return { ...state, bySession }
}

// Sending again: drop the session's old refusal, but never a run error.
export function clearSendRefusal(state: ChatErrors, sessionId: string): ChatErrors {
  const current = state.bySession[sessionId]
  if (!current || current.fromRun) return state
  return { ...state, bySession: without(state.bySession, sessionId) }
}

// Leaving a session: drop its own message, but keep a run error because the
// run is still going on in the server.
export function leaveSession(state: ChatErrors, sessionId: string): ChatErrors {
  return clearSendRefusal(state, sessionId)
}

// The chat shows again: drop the global message and the open session's own
// message, but keep a run error.
export function clearOnShow(state: ChatErrors, openId: string | null): ChatErrors {
  const cleared = openId === null ? state : clearSendRefusal(state, openId)
  return setGlobal(cleared, null)
}

// The session is gone: forget everything about it.
export function dropSession(state: ChatErrors, sessionId: string): ChatErrors {
  const bySession = without(state.bySession, sessionId)
  return bySession === state.bySession ? state : { ...state, bySession }
}

// What the banner shows: the open session's own message, else the global one.
export function visibleError(state: ChatErrors, openId: string | null): string | null {
  if (openId !== null) {
    const own = state.bySession[openId]
    if (own) return own.message
  }
  return state.global
}
