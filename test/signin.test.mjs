// The browser sign-in's two halves: the oauth contract magpie expects, and the
// cookie reading the callback relies on.
//
// The cookie tests read the real Chrome store when one is there, and are
// skipped otherwise — they never write to it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { chromeCookies, stateOf, pending, openInChrome, canReadCookies, SIGN_IN_URL } from "../src/signin.mjs"
import { LogiccPlugin } from "../index.mjs"

const hasChrome = () =>
  existsSync(join(homedir(), "Library/Application Support/Google/Chrome/Default/Cookies"))

test("the oauth method follows magpie's contract", async () => {
  const plugin = await LogiccPlugin()
  const oauth = plugin.auth.methods.find((m) => m.type === "oauth")
  assert.ok(oauth, "an oauth method is declared")
  assert.equal(typeof oauth.authorize, "function")

  const a = oauth.authorize()
  // url: what magpie opens in the browser
  assert.ok(a.url.startsWith(SIGN_IN_URL), `url points at Logicc's sign-in: ${a.url}`)
  // method "auto": magpie calls callback() itself, no code to paste
  assert.equal(a.method, "auto")
  // instructions: what the sign-in sheet shows the user
  assert.equal(typeof a.instructions, "string")
  assert.ok(a.instructions.length > 20)
  assert.equal(typeof a.callback, "function")
})

test("authorize puts a fresh nonce in the redirect each time", async () => {
  const plugin = await LogiccPlugin()
  const oauth = plugin.auth.methods.find((m) => m.type === "oauth")
  const one = new URL(oauth.authorize().url)
  const two = new URL(oauth.authorize().url)

  assert.notEqual(one.href, two.href, "each sign-in gets its own nonce")
  assert.ok(one.searchParams.has("redirect_url"), "the redirect is named")

  // The nonce rides inside the encoded redirect_url, so parse it back out
  // rather than looking for a literal "magpie=" in the outer URL.
  const inner = new URL(one.searchParams.get("redirect_url"))
  assert.ok(inner.searchParams.get("magpie"), `the nonce rides on the redirect: ${inner.href}`)
  assert.notEqual(
    inner.searchParams.get("magpie"),
    new URL(two.searchParams.get("redirect_url")).searchParams.get("magpie"),
    "the two nonces differ",
  )
})

test("pending is not a failure, so magpie keeps polling", () => {
  const p = pending()
  assert.equal(p.type, "pending")
  assert.notEqual(p.type, "failed")
  assert.equal(typeof p.instructions, "string")
})

test("the paste fallback is still offered", async () => {
  const plugin = await LogiccPlugin()
  const api = plugin.auth.methods.find((m) => m.type === "api")
  assert.ok(api, "an api method remains for when the browser can't be read")
})

test("the callback hands back the cookie shape the plugin reads", { skip: !hasChrome() && "no Chrome store" }, async () => {
  const state = stateOf({ nonce: "test" })
  if (!state.clientCookie) {
    // Signed out of Logicc in Chrome: nothing to assert on the value.
    return
  }
  assert.ok(state.clientCookie.length > 100, "the __client value came through")
  // And it is what the account code reads it as.
  const { credsOf } = await import("../src/logicc.mjs")
  const creds = credsOf({
    key: state.clientCookie,
    metadata: { clientCookie: state.clientCookie, sessionId: state.sessionId },
  })
  assert.equal(creds.clientCookie, state.clientCookie)
  assert.ok(creds.sessionId.startsWith("sess_"), `session id looks right: ${creds.sessionId.slice(0, 12)}…`)
})

test("chromeCookies separates 'refused' from 'nothing there'", { skip: !hasChrome() && "no Chrome store" }, () => {
  const { cookies, refused } = chromeCookies("logicc.com")

  // Whether the read is allowed depends on which process asks, so both
  // outcomes are legitimate here — what must never happen is a blank value
  // being returned as if it were a credential.
  for (const value of Object.values(cookies)) assert.ok(value.length > 0)

  if (refused) {
    // macOS said no to this process. Nothing is claimed from a refused read.
    assert.deepEqual(cookies, {})
    return
  }
  if (Object.keys(cookies).length === 0) return // signed out of Logicc in Chrome

  if (cookies.__client) assert.ok(cookies.__client.length > 100, "__client decrypted")
  if (cookies.__session) assert.equal(cookies.__session.split(".").length, 3, "__session is a JWT")
})

test("stateOf reports a refusal instead of an empty sign-in", { skip: !hasChrome() && "no Chrome store" }, () => {
  const state = stateOf({ nonce: "n" })
  assert.equal(typeof state.refused, "boolean")
  // A refused read must not look like a signed-out browser with a cookie.
  if (state.refused) assert.equal(state.clientCookie, "")
})

test("openInChrome never throws, whatever the browser is doing", () => {
  // A URL no Logicc tab matches, and Chrome possibly not running: this must
  // come back quietly rather than take a sign-in down.
  const result = openInChrome("https://app.logicc.com/?magpie=test")
  assert.equal(typeof result, "string")
})

test("an entry that cannot work is not offered", async () => {
  // The rule: where the cookie store can't be read, a browser sign-in opens a
  // page and then fails whatever the user does. It must not be shown there.
  const plugin = await LogiccPlugin()
  const methods = plugin.auth.methods
  assert.ok(methods.length >= 1, "at least one way in is always offered")

  assert.ok(
    methods.some((m) => m.type === "api"),
    "the paste method is always available — it is the one that works everywhere",
  )

  if (!canReadCookies()) {
    const hasBrowser = methods.some((m) => m.type === "oauth")
    assert.equal(hasBrowser, false, "no browser sign-in when the store can't be read")
    assert.equal(methods.length, 1, "and nothing else is offered either")
  }
})
