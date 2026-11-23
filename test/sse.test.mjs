// The stream reader and the turn it folds into. The events below are the AI
// SDK v6 shapes Logicc actually sends, and the chunks below arrive split the
// way a network splits them — mid-frame, and mid-multibyte.

import { test } from "node:test"
import assert from "node:assert/strict"

import { readEvents, turnOf } from "../src/sse.mjs"

// body turns a list of strings into the async byte stream fetch hands over.
function body(...chunks) {
  const encoder = new TextEncoder()
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk)
  })()
}

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`

test("readEvents yields one object per frame", async () => {
  const events = []
  for await (const e of readEvents(body(frame({ type: "start" }), frame({ type: "finish", finishReason: "stop" })))) {
    events.push(e)
  }
  assert.deepEqual(events.map((e) => e.type), ["start", "finish"])
})

test("readEvents reassembles a frame split across chunks", async () => {
  const whole = frame({ type: "text-delta", delta: "hello" })
  const split = [whole.slice(0, 9), whole.slice(9, 20), whole.slice(20)]
  const events = []
  for await (const e of readEvents(body(...split))) events.push(e)
  assert.equal(events.length, 1)
  assert.equal(events[0].delta, "hello")
})

test("readEvents ignores [DONE] and blank frames", async () => {
  const events = []
  for await (const e of readEvents(body(frame({ type: "text-delta", delta: "a" }), "data: [DONE]\n\n", "\n\n"))) {
    events.push(e)
  }
  assert.equal(events.length, 1)
})

test("readEvents keeps a multibyte character split across chunks", async () => {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(frame({ type: "text-delta", delta: "你好" }))
  const cut = bytes.length - 6 // inside the closing quote, after the CJK bytes
  const pieces = (async function* () {
    yield bytes.slice(0, cut)
    yield bytes.slice(cut)
  })()
  const events = []
  for await (const e of readEvents(pieces)) events.push(e)
  assert.equal(events[0].delta, "你好")
})

test("turnOf collects text, reasoning and usage", async () => {
  const seen = []
  const turn = await turnOf(
    body(
      frame({ type: "start" }),
      frame({ type: "reasoning-delta", delta: "thinking…" }),
      frame({ type: "text-delta", delta: "Hel" }),
      frame({ type: "text-delta", delta: "lo" }),
      frame({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 12, outputTokens: 3 } }),
    ),
    { onText: (d) => seen.push(d) },
  )
  assert.equal(turn.text, "Hello")
  assert.equal(turn.reasoning, "thinking…")
  assert.equal(turn.finishReason, "stop")
  assert.deepEqual(turn.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
  // The deltas streamed out as they arrived, not in one piece at the end.
  assert.deepEqual(seen, ["Hel", "lo"])
})

test("turnOf assembles a tool call from start, deltas and available", async () => {
  const turn = await turnOf(
    body(
      frame({ type: "tool-input-start", toolCallId: "c1", toolName: "read" }),
      frame({ type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"pa' }),
      frame({ type: "tool-input-delta", toolCallId: "c1", inputTextDelta: 'th":"a.txt"}' }),
      frame({ type: "finish", finishReason: "tool_calls" }),
    ),
  )
  assert.equal(turn.calls.length, 1)
  assert.equal(turn.calls[0].name, "read")
  assert.equal(turn.calls[0].arguments, '{"path":"a.txt"}')
})

test("turnOf takes an available event's input as the arguments", async () => {
  const turn = await turnOf(
    body(
      frame({ type: "tool-input-start", toolCallId: "c1", toolName: "read" }),
      frame({ type: "tool-input-available", toolCallId: "c1", toolName: "read", input: { path: "b.txt" } }),
      frame({ type: "finish", finishReason: "tool_calls" }),
    ),
  )
  assert.deepEqual(JSON.parse(turn.calls[0].arguments), { path: "b.txt" })
})

test("turnOf raises on an upstream error event", async () => {
  await assert.rejects(
    () => turnOf(body(frame({ type: "error", errorText: "upstream said no" }))),
    /upstream said no/,
  )
})

test("turnOf marks an empty unfinished turn as truncated", async () => {
  const turn = await turnOf(body(frame({ type: "start" })))
  assert.equal(turn.text, "")
  assert.equal(turn.truncated, true)
})
