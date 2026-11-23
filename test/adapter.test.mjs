// Tests for the parts that decide what goes on the wire: credential shapes,
// the prompt a turn becomes, and the JSON envelope a tool-mode turn answers
// with. Nothing here touches the network.

import { test } from "node:test"
import assert from "node:assert/strict"

import { credsOf, claims, fresh } from "../src/logicc.mjs"
import { rowsOf, rowOf, ENDPOINT_CAP } from "../src/models.mjs"
import { _internal } from "../index.mjs"

const { contentOf, historyText, toolEnvelopePrompt, envelopeOf, stripModel } = _internal

// A JWT whose payload carries a `sid`, in the three-part shape Logicc issues.
function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`
}

test("credsOf takes a bare __client cookie", () => {
  const creds = credsOf({ key: "client_abc123def456" })
  assert.equal(creds.clientCookie, "client_abc123def456")
  // No session id in the cookie: it is looked up from Clerk later.
  assert.equal(creds.sessionId, "")
})

test("credsOf takes a cookie string carrying __client", () => {
  const creds = credsOf({ key: "locale=en; __client=client_xyz; other=1" })
  assert.equal(creds.clientCookie, "client_xyz")
})

test("credsOf takes metadata from the sign-in form", () => {
  const creds = credsOf({ key: "anything", metadata: { clientCookie: "client_q", sessionId: "sess_1" } })
  assert.equal(creds.clientCookie, "client_q")
  assert.equal(creds.sessionId, "sess_1")
})

test("credsOf takes a session JWT alone", () => {
  const token = jwt({ sid: "sess_9", exp: Math.floor(Date.now() / 1000) + 3600 })
  const creds = credsOf({ key: token })
  assert.equal(creds.token, token)
  assert.equal(creds.sessionId, "sess_9")
})

test("credsOf returns null with nothing usable", () => {
  assert.equal(credsOf({}), null)
  assert.equal(credsOf({ key: "" }), null)
})

test("claims reads the payload and fresh respects exp", () => {
  const live = jwt({ sid: "sess_1", exp: Math.floor(Date.now() / 1000) + 3600 })
  assert.equal(claims(live).sid, "sess_1")
  assert.equal(fresh(live), true)

  const dead = jwt({ sid: "sess_1", exp: Math.floor(Date.now() / 1000) - 10 })
  assert.equal(fresh(dead), false)
})

test("claims refuses a value that is not a JWT", () => {
  assert.deepEqual(claims("client_abc"), {})
  assert.deepEqual(claims(""), {})
})

test("contentOf flattens both content shapes", () => {
  assert.equal(contentOf("hello"), "hello")
  assert.equal(
    contentOf([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "image_url", image_url: { url: "x" } },
    ]),
    "one\ntwo\n[image]",
  )
  assert.equal(contentOf(null), "")
})

test("historyText writes roles, tool calls and tool results", () => {
  const text = historyText([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read" } }] },
    { role: "tool", tool_call_id: "c1", content: "the file" },
  ])
  assert.match(text, /\[system\]\nbe brief/)
  assert.match(text, /^hi$/m)
  assert.match(text, /\[Tool calls\]/)
  assert.match(text, /\[Tool result: c1\]\nthe file/)
})

test("toolEnvelopePrompt names the tools and the choice", () => {
  const prompt = toolEnvelopePrompt(
    [{ role: "user", content: "read a file" }],
    [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }],
    { choice: "required", parallel: false },
  )
  assert.match(prompt, /"name":"read"/)
  assert.match(prompt, /MUST request at least one declared client tool/)
  assert.match(prompt, /disabled; return at most one tool call/)
})

test("envelopeOf reads JSON, fenced JSON, and rejects prose", () => {
  assert.deepEqual(envelopeOf('{"content":"hi","tool_calls":[]}'), { content: "hi", tool_calls: [] })
  assert.deepEqual(envelopeOf('```json\n{"content":"hi"}\n```'), { content: "hi" })
  assert.equal(envelopeOf("just an answer"), null)
})

test("stripModel accepts both spellings", () => {
  assert.equal(stripModel("gpt-5"), "gpt-5")
  assert.equal(stripModel("logicc/gpt-5"), "gpt-5")
  assert.equal(stripModel(""), "")
})

test("rowsOf keeps every model and offers tool calls", () => {
  const rows = rowsOf([
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
    { id: "gpt-5", name: "GPT-5" },
    { id: "" },
  ])
  assert.deepEqual(Object.keys(rows), ["claude-sonnet-4-5", "gpt-5"])
  assert.equal(rows["gpt-5"].name, "GPT-5")
  // Client tools are served through the JSON envelope, so this is true.
  assert.equal(rows["gpt-5"].tool_call, true)
  assert.equal(rows["gpt-5"].capabilities.toolcall, true)
  assert.equal(rows["gpt-5"].api.npm, "@ai-sdk/openai-compatible")
})

test("rowOf falls back to the id when there is no name", () => {
  const row = rowOf({ id: "m1" })
  assert.equal(row.name, "m1")
  // No band given: the endpoint's own ceiling applies, not a model's spec sheet.
  assert.equal(row.limit.context, ENDPOINT_CAP)
})

test("rowOf reads Logicc's own field names", () => {
  // The live API sends displayName + a contextWindow band, not name/context.
  const row = rowOf({ id: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", contextWindow: "gigantic", knowledgeCutoff: "2026-06-01" })
  assert.equal(row.name, "GPT-6.2 Sol")
  assert.equal(row.release_date, "2026-06-01")
})

test("the reported context is the endpoint's ceiling, not the vendor's window", () => {
  // Logicc labels these models "gigantic", but its chat endpoint answers 400
  // above roughly 29,000 prompt tokens. Reporting the vendor number makes an
  // agent fill the context and get refused, so every band reports the ceiling.
  for (const band of ["gigantic", "large", "medium", "small"]) {
    assert.equal(rowOf({ id: "x", contextWindow: band }).limit.context, ENDPOINT_CAP, band)
  }
})

test("rowOf caps even an explicit number at the endpoint's ceiling", () => {
  // An unknown band falls back rather than becoming NaN.
  assert.equal(rowOf({ id: "c", contextWindow: "colossal" }).limit.context, ENDPOINT_CAP)
  // A number the endpoint could never accept is not passed through: reporting
  // it would only produce a request Logicc answers with 400.
  assert.equal(rowOf({ id: "d", contextWindow: 1_000_000 }).limit.context, ENDPOINT_CAP)
  // One it can accept is kept as-is.
  assert.equal(rowOf({ id: "e", contextWindow: 16000 }).limit.context, 16000)
})

test("rowOf does not advertise reasoning, which Logicc never streams", () => {
  const row = rowOf({ id: "x", reasoningType: "always-reasoning-configurable" })
  assert.equal(row.reasoning, false)
  assert.equal(row.capabilities.reasoning, false)
})
