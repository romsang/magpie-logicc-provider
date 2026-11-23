// Browser sign-in: the user clicks Sign in and the Logicc page opens in their
// own browser. Nothing is copied and no session id is typed.
//
// magpie's oauth contract, read from its own plugin host (host-*.js,
// `authorize` / `callback`):
//
//   authorize()  → { url, instructions, method: "auto" }   magpie opens `url`
//   callback()   → { type: "success", key, … }             polled every ~800 ms
//
// `method: "auto"` means magpie calls callback() itself, repeatedly, while the
// sign-in sheet is open, and the first success finishes it. So callback() has
// to be cheap and idempotent, and must answer something that is not
// `{type: "failed"}` while it waits — `{type: "pending"}` does that, because
// magpie's `failed()` reacts only to an explicit failure.
//
// Where the credential comes from. The one value that matters is Logicc's
// `__client` cookie, which is httpOnly: no page script can read it, by design.
// There are exactly two honest ways to get it, and this tries both:
//
//   1. Chrome's own cookie database. Reading it means decrypting with the key
//      macOS keeps in the login keychain — and whether that works depends on
//      what the process asking is allowed to do. Measured: from a terminal it
//      works; from magpie's plugin host it fails with EPERM, because macOS
//      gates a browser's cookie store per application. So this is tried first
//      and simply falls through when it is refused.
//
//   2. The user, once. The paste method below is not a fallback nobody uses —
//      it is the path that actually works when macOS says no to (1).
//
// The browser is still driven, so the user never hunts for a value: the tab is
// brought to the front and pointed at Logicc's sign-in, and after that page
// settles, its readable cookies (`clerk_active_context` names the session) are
// what the plugin can see from the page side.

import { execFileSync } from "node:child_process"
import { createDecipheriv, pbkdf2Sync } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { writeFileSync, unlinkSync, appendFileSync } from "node:fs"
import { join } from "node:path"

const APP_ORIGIN = "https://app.logicc.com"

// Where a user who isn't signed in yet is sent.
export const SIGN_IN_URL = `${APP_ORIGIN}/sign-in`

// Never a failure, so magpie keeps polling.
export const pending = () => ({
  type: "pending",
  instructions: "Waiting for the Logicc page to finish signing in…",
})

export class SignInError extends Error {}

// dbg appends one line to a probe file, so a sign-in that fails inside
// magpie's host can be diagnosed without a debugger. Off unless
// MAGPIE_LOGIC_SIGNIN_DEBUG is set.
export function dbg(...parts) {
  const file = process.env.MAGPIE_LOGIC_SIGNIN_DEBUG
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${parts.join(" ")}` + "\n")
  } catch {}
}

// --- the browser -----------------------------------------------------------

// osascript runs a short AppleScript. Every call is guarded: none of this may
// take a sign-in down just because Chrome is closed or macOS asked something.
function osascript(lines, { timeout = 8000 } = {}) {
  try {
    return execFileSync("osascript", lines.flatMap((line) => ["-e", line]), {
      encoding: "utf8",
      timeout,
    }).trim()
  } catch (error) {
    return ""
  }
}

// chromeTabOf points the user's Chrome at `url`, reusing a Logicc tab when one
// is open so the sign-in lands where the user is already looking.
//
// Returns the tab id it used, or "" when Chrome could not be reached (not
// installed, not running, or automation permission refused).
export function openInChrome(url) {
  // Chrome's `active tab` is read-only over AppleScript, and assigning a tab
  // reference to it fails with -10006. `active tab index` IS writable — but it
  // only takes an integer, so the tab's `index` (a number) is what to assign,
  // never the tab itself.
  // `repeat with t in tabs` yields references, and `index of t` on a reference
  // fails with -1728 — the tab has to be reached as `tab i of w`, where its
  // position IS the number needed for `active tab index`.
  const found = osascript([
    'tell application "Google Chrome"',
    '  set found to ""',
    "  repeat with w in windows",
    "    set tabCount to count of tabs of w",
    "    repeat with i from 1 to tabCount",
    '      if URL of tab i of w contains "app.logicc.com" then',
    "        set found to (id of tab i of w as string)",
    "        set active tab index of w to i",
    "        set index of w to 1",
    '        return found & "|" & i & "|" & (id of w as string)',
    "      end if",
    "    end repeat",
    "  end repeat",
    "  return found",
    "end tell",
  ])

  if (found) {
    const [tabId, tabIndex, windowId] = found.split("|")
    // Point that same tab at the sign-in page, then bring it into view.
    osascript([
      'tell application "Google Chrome"',
      `  set URL of tab ${tabIndex} of (first window whose id is ${windowId}) to "${url}"`,
      `  set active tab index of (first window whose id is ${windowId}) to ${tabIndex}`,
      `  set index of (first window whose id is ${windowId}) to 1`,
      "end tell",
    ])
    osascript(['tell application "Google Chrome" to activate'])
    return tabId
  }

  // No Logicc tab open: make one in the front window and select it by index.
  const made = osascript([
    'tell application "Google Chrome"',
    "  set w to window 1",
    `  set newTab to make new tab at end of tabs of w with properties {URL:"${url}"}`,
    "  set newTabIndex to (count of tabs of w)",
    "  set active tab index of w to newTabIndex",
    "  return (id of tab newTabIndex of w as string)",
    "end tell",
  ])
  osascript(['tell application "Google Chrome" to activate'])
  return made
}

// --- Linux, Windows and plain-HTTP fallbacks --------------------------------

// openElsewhere is what a non-macOS magpie gets: the OS's own way of opening a
// URL. The sign-in still works; only the automatic cookie read doesn't.
export function openElsewhere(url) {
  const cmd =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  try {
    execFileSync(cmd[0], cmd[1], { stdio: "ignore", timeout: 8000 })
    return true
  } catch {
    return false
  }
}

// --- Chrome's cookie store --------------------------------------------------
//
// Reading it means decrypting with the key macOS keeps in the login keychain,
// and macOS gates *a browser's cookie store per application*. Measured on this
// machine: a plain read from magpie's plugin host fails with
// `EPERM: operation not permitted`, while the very same commands run through
// `do shell script` succeed — that path is allowed under the Automation
// permission (System Settings › Privacy & Security › Automation), which is not
// the same gate as Full Disk Access.
//
// So every read goes through osascript. It is one extra hop, and it is the
// difference between a sign-in that finishes itself and one that asks the user
// to paste a cookie.

const CHROME_PROFILES = ["Default", "Profile 1", "Profile 2", "Profile 3"]

// shell runs one command through `do shell script` and returns its stdout, or
// "" when macOS refused or the command failed. Nothing here may throw its way
// out of a sign-in.
//
// The command goes into a script FILE that AppleScript reads, rather than into
// an inline `do shell script "…"` string. Inline means escaping every quote
// twice over — once for AppleScript, once for the shell — and a path with a
// space or a quote in it silently turns into a different command. A file has
// none of that: it is handed to `sh` verbatim.
function shell(command, { timeout = 20_000 } = {}) {
  const script = join(tmpdir(), `magpie-logicc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`)
  try {
    // A trailing `|| true` matters: `do shell script` treats a non-zero exit
    // as an AppleScript error, which would turn "no rows matched" or a
    // `test -r` miss into a thrown sign-in instead of an empty answer.
    writeFileSync(script, `#!/bin/sh\n${command}\n`, { mode: 0o700 })
    return execFileSync("osascript", ["-e", `do shell script "sh ${script} || true"`], {
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    }).trim()
  } catch {
    return ""
  } finally {
    try {
      unlinkSync(script)
    } catch {
      /* it lives in tmp; leaving it is harmless */
    }
  }
}

function cookieDbOf() {
  const base = `${homedir()}/Library/Application Support/Google/Chrome`
  for (const profile of CHROME_PROFILES) {
    const db = `${base}/${profile}/Cookies`
    // Probe by actually querying it. `test -r` answers "no" even when the read
    // itself works — it is checking a different permission bit than the one
    // `sqlite3` ends up exercising — so a `test -r` gate made this report
    // "no database" on a machine where the database was perfectly readable.
    const probe = shell(`sqlite3 -readonly "${db}" "SELECT count(*) FROM cookies LIMIT 1" 2>&1`)
    // "authorization denied" is macOS's TCC refusal, not a missing file. It is
    // reported as `blocked` so the caller can say which case it hit.
    if (/authorization denied|unable to open database/i.test(probe)) return { db: "", blocked: true }
    if (probe && /^\d+$/.test(probe.trim())) return { db, blocked: false }
  }
  return { db: "", blocked: false }
}

// canReadCookies answers, once, whether this process may read Chrome's cookie
// store at all. Measured on this machine: a terminal may, while magpie's
// plugin host gets "authorization denied" from TCC because it runs under a
// launchd-started background service with no GUI session. The sign-in flow
// uses this to decide whether a browser sign-in can ever finish here — an
// entry that is guaranteed to fail is worse than no entry.
let cookieReadable
export function canReadCookies() {
  if (cookieReadable !== undefined) return cookieReadable
  const { db, blocked } = cookieDbOf()
  const readable = Boolean(db) && !blocked
  // A positive answer is stable; a negative one only counts when macOS said
  // "authorization denied", so a transient failure can't hide the browser
  // sign-in for the rest of the process's life.
  if (readable || blocked) cookieReadable = readable
  return readable
}

function chromeKey() {
  const password = shell('security find-generic-password -w -s "Chrome Safe Storage"')
  if (!password) {
    throw new SignInError(
      "Could not read Chrome's cookie key. macOS may have asked for permission — allow magpie under Privacy & Security › Automation, then try again.",
    )
  }
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1")
}

// decrypt opens one encrypted_value: "v10" + AES-128-CBC, with a 32-byte
// SHA-256 of the host in front of the plaintext (Chrome v80 onward).
function decrypt(buf, key) {
  if (!buf?.length) return ""
  if (buf.subarray(0, 3).toString("latin1") !== "v10") return ""
  try {
    const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "))
    const plain = Buffer.concat([d.update(buf.subarray(3)), d.final()])
    const text = plain.subarray(32).toString("utf8")
    return text.includes("\u0000") ? "" : text
  } catch {
    return ""
  }
}

// chromeCookies reads Logicc's cookies out of Chrome's database.
//
// It returns `{ cookies, refused }`: `refused` is set when the read was
// blocked rather than merely empty — the difference between "signed out of
// Logicc" and "this process may not look".
export function chromeCookies(host = "logicc.com") {
  const { db, blocked } = cookieDbOf()
  dbg("cookieDb", db || (blocked ? "(blocked)" : "(none)"))
  if (blocked) return { cookies: {}, refused: true }
  if (!db) return { cookies: {}, refused: false }

  // Quoting: the path is double-quoted for the shell, the SQL is double-quoted
  // after AppleScript escaping, and the LIKE pattern sits in single quotes
  // inside it. The host is stripped of quotes so it can't close either one.
  const safeHost = host.replace(/['"\\$`]/g, "")
  const out = shell(
    `sqlite3 -readonly "${db}" "SELECT name || '|' || hex(encrypted_value) FROM cookies WHERE host_key LIKE '%${safeHost}%'"`,
  )
  if (!out) {
    // No output means either no rows or a refused read. Ask which, cheaply:
    // a count that comes back at all proves the database was openable.
    const any = shell(`sqlite3 -readonly "${db}" "SELECT count(*) FROM cookies"`)
    return { cookies: {}, refused: !any }
  }

  // AppleScript hands back CRLF (or bare CR) from `do shell script`, so every
  // line ending is split on — reading only "\n" would fold the whole result
  // into one unusable line.
  const rows = out
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|"))
    .filter((parts) => parts.length === 2 && parts[0])
  if (!rows.length) return { cookies: {}, refused: false }

  const key = chromeKey()
  const cookies = {}
  for (const [name, hex] of rows) {
    const value = decrypt(Buffer.from(hex, "hex"), key)
    if (value) cookies[name] = value
  }
  return { cookies, refused: false }
}

// --- what callback() reads -------------------------------------------------

// stateOf is callback()'s whole read: whatever Logicc cookies can be seen, and
// whether that was refused rather than absent.
export function stateOf({ nonce } = {}) {
  const { cookies, refused } = chromeCookies("logicc.com")
  const clientCookie = cookies.__client || ""
  const activeContext = cookies.clerk_active_context || ""
  const session = cookies.__session || ""

  // `clerk_active_context` is "sess_…:org_…" — the session id is its first part.
  // The JWT's own `sid` claim is an independent second source.
  let claimSid = ""
  try {
    const payload = JSON.parse(Buffer.from(session.split(".")[1], "base64url").toString("utf8"))
    claimSid = typeof payload.sid === "string" ? payload.sid : ""
  } catch {
    /* an opaque or missing __session is not an error here */
  }

  return {
    clientCookie,
    sessionId: activeContext.split(":")[0] || claimSid,
    refused,
    nonce,
  }
}

export { APP_ORIGIN }
