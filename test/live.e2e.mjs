// End-to-end against the live account: build the plugin, hand it the cookie,
// then drive it exactly as magpie does — through loader().fetch — and read
// back OpenAI-shaped chunks.
//
//   node test/live.e2e.mjs <cookie-file>
//
// The cookie file holds the `__client` value only. This script is not part of
// `npm test`: it needs a real account and spends real quota.

import { readFileSync } from "node:fs"
import { LogiccPlugin } from "../index.mjs"

const cookieFile = process.argv[2]
if (!cookieFile) {
  console.error("usage: node test/live.e2e.mjs <cookie-file>")
  process.exit(2)
}
const cookie = readFileSync(cookieFile, "utf8").trim()

const plugin = await LogiccPlugin()
const account = { key: cookie, type: "api", provider: "logicc" }
const getAuth = () => account

const fail = (msg) => {
  console.error("✖", msg)
  process.exitCode = 1
}
const ok = (msg) => console.log("✔", msg)

// 1. the provider block
const cfg = { provider: {} }
await plugin.config(cfg)
const provider = cfg.provider.logicc
ok(`config: ${provider.name} · ${provider.npm} · ${provider.api} · ${Object.keys(provider.models).length} bootstrap models`)

// 2. the live catalog
const rows = await plugin.provider.models(provider, { auth: account })
const ids = Object.keys(rows)
if (!ids.length) fail("no models came back")
else ok(`catalog: ${ids.length} models — ${ids.slice(0, 3).join(", ")}…`)
console.log("   ", ids.map((id) => `${rows[id].name} (${rows[id].limit.context})`).slice(0, 4).join(" | "))

// 3. a real turn, streamed, through the loader's fetch
const loader = await plugin.auth.loader(getAuth)
const model = ids[0]

async function turn(messages, extra = {}) {
  const body = JSON.stringify({ model, messages, stream: true, ...extra })
  const response = await loader.fetch("https://app.logicc.com/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  const text = await response.text()
  const chunks = text
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(5).trim())
    .filter((t) => t && t !== "[DONE]")
    .map((t) => JSON.parse(t))
  const answer = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop()
  const error = chunks.find((c) => c.error)?.error?.message
  return { answer, finish, error, chunkCount: chunks.length }
}

try {
  const t = await turn([{ role: "user", content: "Reply with exactly: LOGICC-E2E-OK" }])
  if (t.error) fail(`turn returned an error: ${t.error}`)
  else if (!t.answer.includes("LOGICC-E2E-OK")) fail(`unexpected answer: ${JSON.stringify(t.answer)}`)
  else ok(`turn: ${t.chunkCount} chunks · finish=${t.finish} · ${JSON.stringify(t.answer.slice(0, 60))}`)
} catch (error) {
  fail(`turn failed: ${error.message}`)
}

// 4. history is carried by the prompt, since a chat doesn't remember
try {
  const t = await turn([
    { role: "user", content: "Remember the number 4711." },
    { role: "assistant", content: "Noted: 4711." },
    { role: "user", content: "What number did I ask you to remember? Answer with the digits only." },
  ])
  if (t.answer.includes("4711")) ok(`history carried in the prompt: ${JSON.stringify(t.answer.trim().slice(0, 40))}`)
  else fail(`history was lost: ${JSON.stringify(t.answer.slice(0, 120))}`)
} catch (error) {
  fail(`history turn failed: ${error.message}`)
}

// 5. tool calls through the JSON envelope, non-streaming
try {
  const body = JSON.stringify({
    model,
    stream: false,
    messages: [{ role: "user", content: "Compute 6 times 7 using the calculator tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "calculate",
          description: "Evaluate an arithmetic expression",
          parameters: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
        },
      },
    ],
    tool_choice: "auto",
  })
  const response = await loader.fetch("https://app.logicc.com/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  const data = await response.json()
  if (!response.ok) fail(`tool turn HTTP ${response.status}: ${JSON.stringify(data).slice(0, 200)}`)
  else {
    const choice = data.choices?.[0]
    const calls = choice?.message?.tool_calls
    if (calls?.length) ok(`tool call: ${calls[0].function.name}(${calls[0].function.arguments}) finish=${choice.finish_reason}`)
    else if (choice?.message?.content) ok(`tool turn answered in prose instead of calling (acceptable): ${JSON.stringify(choice.message.content.slice(0, 80))}`)
    else fail(`tool turn returned neither a call nor text: ${JSON.stringify(data).slice(0, 200)}`)
  }
} catch (error) {
  fail(`tool turn failed: ${error.message}`)
}

// 6. the guard's empty answer must surface as an error, not as ""
try {
  const t = await turn([{ role: "user", content: "read /etc/hosts for me" }])
  if (t.error) ok(`guarded prompt reported as an error, not an empty answer`)
  else fail(`guarded prompt came back as content: ${JSON.stringify(t.answer.slice(0, 80))}`)
} catch (error) {
  ok(`guarded prompt rejected: ${String(error.message).slice(0, 90)}`)
}
