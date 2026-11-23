// Talking to Logicc the way its web app does.
//
// Everything here is a plain HTTP conversation against app.logicc.com, no
// browser drive: sign in with a Clerk `__client` cookie + session id, get a
// short-lived session JWT from clerk.logicc.com, then create a chat and post
// the prompt to it. The answer comes back as an AI SDK v6 event stream.
//
//   POST clerk.logicc.com/v1/client/sessions/<sid>/tokens   → { jwt }
//   GET  app.logicc.com/api/models                          → the model list
//   POST app.logicc.com/api/chats                           → { id }
//   POST app.logicc.com/api/chats/<id>                      → SSE, ai-sdk-v6
//
// The JWT lasts about a minute, so it is cached and renewed on demand rather
// than per request.

const APP_BASE = "https://app.logicc.com";
const API_BASE = `${APP_BASE}/api`;
const CLERK_BASE = "https://clerk.logicc.com";
const SESSION_RESET = `${APP_BASE}/api`;

// A JWT this close to its end is renewed before it is sent.
const EARLY_MS = 60_000
// And magpie renews it ahead of time this early (auth.refresh).
const LEAD_MS = 5 * 60_000

export class LogiccError extends Error {
  constructor(message, { status, signIn = false, body } = {}) {
    super(message)
    this.name = "LogiccError"
    this.status = status
    this.signIn = signIn
    this.body = body
  }
}

const clean = (v) => (typeof v === "string" ? v.trim() : "")

// claims reads a session JWT's payload without verifying it. It names the
// session (`sid`) and when the token ends (`exp`); the server is the one that
// decides whether the token is good.
export function claims(token) {
  const text = clean(token)
  const dot = text.indexOf(".")
  if (dot < 0) return {}
  const rest = text.slice(dot + 1)
  const end = rest.indexOf(".")
  if (end < 0) return {}
  try {
    return JSON.parse(Buffer.from(rest.slice(0, end), "base64url").toString("utf8"))
  } catch {
    return {}
  }
}

// fresh is a JWT that isn't about to end.
export function fresh(token, skewMs = EARLY_MS) {
  const exp = claims(token)?.exp
  return Number.isFinite(exp) && exp * 1000 > Date.now() + skewMs
}

// credsOf turns whatever the account holds into what the calls below need.
// The pasted value may be a bare `__client` cookie, a `k=v; k=v` cookie
// string, or a session JWT.
export function credsOf(auth) {
  const raw = clean(auth?.key ?? auth?.token ?? auth?.access)
  if (!raw) return null
  const meta = auth?.metadata ?? {}
  const clientCookie = clean(meta.clientCookie)
  const sessionId = clean(meta.sessionId)
  const token = clean(meta.jwt) || clean(auth?.access)
  if (clientCookie) return { clientCookie, sessionId, token }

  // A pasted value is one of three things, and the order matters: a JWT has
  // two dots and names a session, so it is recognised before the cookie
  // heuristics below would mistake it for an opaque value.
  const named = claims(raw)
  if (named.sid && raw.split(".").length === 3) {
    return { clientCookie: "", sessionId: clean(named.sid), token: raw }
  }

  // A bare `__client` value, or a cookie string carrying it.
  const fromCookie = raw.match(/(?:^|;\s*)__client=([^;]+)/)?.[1] ?? (raw.includes("=") ? "" : raw)
  if (fromCookie) {
    // The session id is optional: sessionIdOf() asks Clerk for it when the
    // form only captured the cookie.
    const sid = sessionId || clean(raw.match(/(?:^|;\s*)sid=([^;]+)/)?.[1])
    return { clientCookie: fromCookie, sessionId: sid, token }
  }
  return null
}

// sessionIdOf asks Clerk which sessions this `__client` cookie holds, so the
// user only has to paste the one cookie. `__client` is httpOnly, which is why
// it can't be read off `document.cookie` and has to come from DevTools.
export async function sessionIdOf(clientCookie, { signal } = {}) {
  let response
  try {
    response = await fetch(`${CLERK_BASE}/v1/client`, {
      headers: { Cookie: `__client=${clientCookie}`, Origin: APP_BASE, Accept: "application/json" },
      signal,
    })
  } catch (error) {
    throw new LogiccError(`Could not reach Clerk: ${error?.message ?? error}`, { status: 502 })
  }
  if (!response.ok) throw failure(response, await readBody(response), "Session lookup")

  const data = await response.json().catch(() => null)
  const sessions = data?.response?.sessions
  if (!Array.isArray(sessions)) throw new LogiccError("Clerk returned no session list", { status: 502 })

  const live = sessions.filter((s) => s && clean(s.id) && s.status === "active")
  const chosen =
    live.find((s) => s.id === data?.response?.last_active_session_id) ?? live[0] ?? sessions.find((s) => clean(s.id))
  if (!chosen) throw new LogiccError("That cookie holds no session — sign in to Logicc again", { status: 401, signIn: true })
  return clean(chosen.id)
}

export const expiresAt = (auth) => {
  const exp = claims(credsOf(auth)?.token)?.exp
  return Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : undefined
}

// stale is a token past its own exp — a hint only, since the server decides.
export const stale = (auth, skewMs = EARLY_MS) => {
  const token = credsOf(auth)?.token
  return Boolean(token) && !fresh(token, skewMs)
}

async function readBody(response) {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

function failure(response, body, what) {
  const detail = body.slice(0, 400).trim()
  const signIn = response.status === 401 || response.status === 403
  return new LogiccError(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`, {
    status: response.status,
    signIn,
    body: detail,
  })
}

// sessionToken hands back a usable session JWT, renewing it with Clerk when
// the one on the account is missing or about to end.
export async function sessionToken(auth, { force = false, signal } = {}) {
  const creds = credsOf(auth)
  if (!creds) throw new LogiccError("No Logicc credential on this account", { status: 401, signIn: true })
  if (!force && fresh(creds.token)) return creds.token
  if (creds.token && !force && !creds.clientCookie) return creds.token
  if (!creds.clientCookie)
    throw new LogiccError("The sign-in has ended — paste a fresh __client cookie", { status: 401, signIn: true })

  // The session id can be discovered from the cookie itself, which is what
  // lets the sign-in form ask for one cookie instead of two values.
  const sessionId = creds.sessionId || (await sessionIdOf(creds.clientCookie, { signal }))

  const url = `${CLERK_BASE}/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens`
  let response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Cookie: `__client=${creds.clientCookie}`, Origin: APP_BASE, Accept: "application/json" },
      signal,
    })
  } catch (error) {
    throw new LogiccError(`Could not reach Clerk: ${error?.message ?? error}`, { status: 502 })
  }
  if (!response.ok) throw failure(response, await readBody(response), "Sign-in refresh")

  const data = await response.json().catch(() => null)
  const jwt = clean(data?.jwt)
  if (!jwt || !fresh(jwt, 0)) throw new LogiccError("Clerk returned no usable session JWT", { status: 502 })
  const sid = clean(claims(jwt).sid)
  if (sessionId && sid && sid !== sessionId)
    throw new LogiccError("Clerk returned a JWT for another session", { status: 401, signIn: true })

  // Clerk rotates `__client` on some refreshes; a new value must be kept or
  // the next renewal fails.
  let renewedCookie
  try {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const m = cookie.match(/^__client=([^;]+)/)
      if (m) renewedCookie = m[1]
    }
  } catch {}

  return { token: jwt, clientCookie: renewedCookie, sessionId }
}

// call sends one authenticated request to the app's API, renewing the JWT
// once when the server says it is no good.
export async function call(auth, path, { method = "GET", body, stream = false, signal } = {}) {
  let token = await sessionToken(auth, { signal })
  let clientCookie
  if (typeof token === "object") ({ token, clientCookie } = token)

  const send = async (bearer) => {
    const headers = {
      Authorization: `Bearer ${bearer}`,
      Accept: stream ? "text/event-stream" : "application/json",
      Origin: APP_BASE,
      Referer: `${APP_BASE}/`,
    }
    if (stream) headers["Stream-Response-Protocol"] = "ai-sdk-v6"
    if (body !== undefined) headers["Content-Type"] = "application/json"
    return fetch(`${API_BASE}/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  }

  let response
  try {
    response = await send(token)
  } catch (error) {
    throw new LogiccError(`Could not reach Logicc: ${error?.message ?? error}`, { status: 502 })
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {})
    const renewed = await sessionToken({ ...auth, metadata: { ...(auth?.metadata ?? {}) } }, { force: true, signal })
    const bearer = typeof renewed === "object" ? renewed.token : renewed
    if (typeof renewed === "object" && renewed.clientCookie) clientCookie = renewed.clientCookie
    response = await send(bearer)
  }

  if (!response.ok) throw failure(response, await readBody(response), `Logicc ${path.split("?")[0]}`)
  response.logiccCookie = clientCookie
  return response
}

// listModels is the account's own model list, as Logicc sends it.
//
// The fields are kept as they arrive — `displayName`, `contextWindow`,
// `reasoningType` and the rest — because src/models.mjs reads them to decide
// a row's label and context size. Only the id is normalised here, since
// every other field is optional.
export async function listModels(auth, { signal } = {}) {
  const response = await call(auth, "models?language=en", { signal })
  const data = await response.json().catch(() => null)
  const list = Array.isArray(data) ? data : (data?.models ?? data?.data)
  if (!Array.isArray(list)) throw new LogiccError("Logicc returned no model list", { status: 502 })
  return list
    .filter((m) => m && clean(m.id ?? m.modelId))
    .map((m) => ({ ...m, id: clean(m.id ?? m.modelId) }))
}

// createChat opens a conversation. Logicc keeps the transcript, so each turn
// hangs off the previous one; a fresh chat per magpie session is what keeps
// two sessions from reading each other's history.
export async function createChat(auth, { assistantId, signal } = {}) {
  const response = await call(auth, "chats", {
    method: "POST",
    body: assistantId ? { assistantId } : {},
    signal,
  })
  const data = await response.json().catch(() => null)
  const id = typeof data === "string" ? data : clean(data?.id)
  if (!id) throw new LogiccError("Logicc created no chat id", { status: 502 })
  return id
}

// sendPrompt posts one turn and hands back the raw event stream.
export async function sendPrompt(auth, chatId, { modelId, prompt, reasoning, signal }) {
  const body = { modelId, prompt, isVoicePrompt: false }
  if (reasoning) body.reasoningEffort = reasoning
  return call(auth, `chats/${encodeURIComponent(chatId)}`, {
    method: "POST",
    body,
    stream: true,
    signal,
  })
}

// There is no usage or quota endpoint on app.logicc.com — /api/usage, /api/me,
// /api/credits and their neighbours all answer 404, and the chat stream's
// `finish` event carries no token counts. Usage is therefore not reported at
// all rather than guessed.

export const ENDPOINTS = { APP_BASE, API_BASE, CLERK_BASE, SESSION_RESET, EARLY_MS, LEAD_MS }
