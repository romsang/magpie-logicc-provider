// Logicc (app.logicc.com) as a magpie provider, on the account you already
// have in the browser.
//
// Why this exists at all: Logicc does publish an OpenAI-compatible API, but a
// key for it is provisioned by hand (mail to their team with a company and a
// use case) — there is no self-service page. So the only way to put the
// subscription you already pay for behind magpie is to talk to the app the
// way the app talks to its own backend, which is what this plugin does:
//
//   sign-in  →  the Clerk `__client` cookie + session id
//   catalog  →  GET  app.logicc.com/api/models
//   a turn   →  POST app.logicc.com/api/chats  →  POST /api/chats/<id>
//               (SSE, AI SDK v6 events)
//
// No sidecar process and no localhost port: the rewrite from OpenAI's request
// shape to Logicc's lives in the `fetch` that auth.loader hands back, which is
// the same trick the WorkBuddy and Tabbit plugins use for their own protocols.

import { randomBytes } from "node:crypto"

import { LogiccError, claims, credsOf, expiresAt, fresh, listModels, createChat, sendPrompt, stale } from "./src/logicc.mjs"
import { turnOf } from "./src/sse.mjs"
import { BOOTSTRAP, CHAT_BASE, NPM, rowsOf, modelIdsOf } from "./src/models.mjs"
import { stateOf, pending, openInChrome, openElsewhere, canReadCookies, dbg, SIGN_IN_URL, APP_ORIGIN } from "./src/signin.mjs"

const ID = "logicc"
const NAME = "Logicc"

// The largest prompt Logicc's chat endpoint takes, in characters. Measured by
// bisection against a live account: 120,000 passed, 122,000 answered 400. The
// cap sits a little under that edge.
const PROMPT_CHAR_LIMIT = 120_000

// The nonce the current browser sign-in put in its redirect, so a callback
// can tell that sign-in's arrival apart from any older Logicc tab.
let signInNonce = ""

// Logicc does not continue a chat on its own: two turns posted to the same id
// treat each other as strangers (measured against the live account). So no
// chat is cached or reused — every turn creates its own and sends the whole
// transcript. That also keeps a second copy of the history from living
// upstream, where Logicc would store and title it.

const clean = (v) => (typeof v === "string" ? v.trim() : "")

// stripModel accepts either the bare id magpie sends the SDK or a
// `logicc/<id>` spelling, so a route written by hand still resolves.
function stripModel(value) {
  const id = clean(value)
  return id.startsWith(`${ID}/`) ? id.slice(ID.length + 1) : id
}

// contentOf flattens one message's content: a string, or the array of parts
// the OpenAI SDK sends. Only text is taken; an image is named so the turn
// still says something about it.
function contentOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = []
  for (const part of content) {
    if (typeof part === "string") parts.push(part)
    else if (part?.type === "text" || typeof part?.text === "string") parts.push(part.text ?? "")
    else if (part?.type === "image_url" || part?.type === "image") parts.push("[image]")
  }
  return parts.join("\n")
}

// --- the prompt ------------------------------------------------------------
//
// Logicc's chat endpoint takes one `prompt` string, not a message array, so a
// turn has to be written out in full.
//
// Measured against the live account: a chat does NOT carry its own history.
// Two turns posted to the same chat id answer each other as strangers — the
// second does not see the first. So the whole transcript is sent every turn
// and no chat is reused for continuity; a fresh chat per turn keeps Logicc's
// own title/retention side effects out of the way and avoids a second copy of
// the same history living upstream.
//
// With tools, Logicc's models have no client-tool channel either, so a request
// that declares tools is rewritten into an instruction to answer with one JSON
// envelope and parsed back. See toolEnvelopePrompt.

function historyText(messages) {
  return messages
    .map((m) => {
      const body = contentOf(m?.content)
      if (m?.tool_calls?.length) return `[Assistant]\n${body}\n[Tool calls]\n${JSON.stringify(m.tool_calls)}`
      if (m?.role === "tool") return `[Tool result: ${m.tool_call_id ?? ""}]\n${body}`
      if (m?.role === "user") return body
      return `[${m?.role ?? "system"}]\n${body}`
    })
    .join("\n\n")
}

function toolEnvelopePrompt(messages, tools, { choice, parallel }) {
  const required = choice === "required" || (typeof choice === "object" && choice !== null)
  return `Serialize the next assistant turn for a client application. The client application executes functions requested in your output; you only select a tool and produce its input. Do not execute the client functions yourself or invent their results.
Return only one JSON object, without markdown fences or explanations, using this envelope:
{"content": "text for the user or null", "tool_calls": [{"name": "a declared tool name", "arguments": {}}]}
If a tool is needed to fulfill the user's request, request it and stop. Use actual values from the conversation, never placeholder values. If a tool result has already been supplied, use it to continue the task and give the final answer when sufficient. For an ordinary answer, put the answer in content and set tool_calls to []. Do not say tools are unavailable: the external client executes the declared functions after receiving your JSON.
Tool choice: ${required ? "You MUST request at least one declared client tool in this turn." : "Choose a tool when needed, otherwise answer the user."}
Parallel calls: ${parallel ? "allowed" : "disabled; return at most one tool call"}.
Declared client tools:
${JSON.stringify(tools)}
Conversation (the actual task to continue):
${JSON.stringify(messages)}
Return the next assistant turn JSON now.`
}

// envelopeOf reads the JSON a tool-mode turn should have answered with.
function envelopeOf(raw) {
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(text)
  if (fenced) text = fenced[1].trim()
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

// --- OpenAI response shapes ------------------------------------------------

const enc = new TextEncoder()
const id = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function chunkLine(model, delta, { finish = null, usage = null } = {}) {
  const payload = {
    id: chunkLine.id ??= id("chatcmpl"),
    object: "chat.completion.chunk",
    created: chunkLine.created ??= Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (usage) payload.usage = usage
  return `data: ${JSON.stringify(payload)}\n\n`
}

function completionBody(model, text, reasoning, usage, finish = "stop") {
  return {
    id: id("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (finish === "tool_calls" ? null : ""),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

const PASS_THROUGH = new Set([400, 401, 403, 404, 429])

function errorResponse(error) {
  const status = Number.isFinite(error?.status) ? error.status : 500
  const headers = { "content-type": "application/json" }
  if (error?.signIn) headers["x-magpie-sign-in"] = "expired"
  const passthrough = PASS_THROUGH.has(status)
  return new Response(
    JSON.stringify({
      error: {
        message: error?.message ?? String(error),
        type: error?.signIn ? "authentication_error" : "logicc_error",
      },
    }),
    { status: passthrough ? status : 502, headers },
  )
}

// --- the plugin ------------------------------------------------------------

function createPlugin() {
  async function chat(getAuth, request) {
    const body = await request.json()
    const model = stripModel(body?.model)
    if (!model) throw new LogiccError("logicc: no model was named", { status: 400 })
    const messages = Array.isArray(body?.messages) ? body.messages : []
    if (!messages.length) throw new LogiccError("logicc: no messages were sent", { status: 400 })

    const auth = await getAuth()
    const creds = credsOf(auth)
    if (!creds) throw Object.assign(new LogiccError("logicc: not signed in", { status: 401 }), { signIn: "expired" })

    // Tools: Logicc's chat takes no tool schema, so a turn that declares any
    // is asked for the JSON envelope instead and parsed back below.
    const tools = Array.isArray(body?.tools) ? body.tools : []
    const activeTools = tools
      .map((t) => {
        const fn = t?.function ?? t
        if (!clean(fn?.name)) return null
        return {
          name: clean(fn.name),
          description: clean(fn.description),
          parameters: fn.parameters ?? { type: "object", properties: {} },
        }
      })
      .filter(Boolean)
    const useTools = activeTools.length > 0
    const toolChoice = body?.tool_choice
    const parallel = body?.parallel_tool_calls !== false

    // Every turn carries its own transcript: Logicc does not continue a chat
    // on its own (measured — see the note above the prompt builders).
    let prompt = historyText(messages)
    if (useTools) prompt = toolEnvelopePrompt(messages, activeTools, { choice: toolChoice, parallel })

    // Logicc's chat endpoint refuses a prompt over roughly 115,000 characters
    // with a bare HTTP 400 — measured by bisection. Saying so here gives magpie
    // a message it can act on (compact, then retry) instead of an opaque
    // upstream failure. The character cap is the measured one; keep a margin.
    if (prompt.length > PROMPT_CHAR_LIMIT) {
      // Nothing is truncated to make this fit. Cutting a system prompt or a
      // transcript silently changes what the agent was told, and the answer
      // that comes back looks normal while being built on a request the user
      // never approved. The limit is the endpoint's, measured; the fix is a
      // smaller context or another provider, and saying so is the honest
      // answer.
      throw new LogiccError(
        `logicc: this turn is ${prompt.length.toLocaleString()} characters, ` +
          `over the ${PROMPT_CHAR_LIMIT.toLocaleString()} Logicc's chat endpoint accepts. ` +
          `Logicc is not usable for a context this large — the system prompt alone is most of it. ` +
          `Use a provider with a bigger window for this agent, or start a fresh, shorter session.`,
        { status: 413 },
      )
    }

    const chatId = await createChat(auth, { signal: request.signal })

    const response = await sendPrompt(auth, chatId, {
      modelId: model,
      prompt,
      reasoning: body?.reasoning_effort,
      signal: request.signal,
    })

    // --- non-streaming: drain the turn and answer once --------------------
    if (body?.stream !== true) {
      const turn = await turnOf(response.body, { signal: request.signal })

      let text = turn.text
      let finish = turn.finishReason
      let toolCalls = null

      if (useTools) {
        const envelope = envelopeOf(turn.text)
        const raw = envelope?.tool_calls ?? (envelope?.tool_call ? [envelope.tool_call] : undefined)
        text = typeof envelope?.content === "string" ? envelope.content : ""
        if (Array.isArray(raw) && raw.length) {
          toolCalls = raw
            .map((call) => {
              const name = clean(call?.function?.name ?? call?.name)
              if (!name || !activeTools.some((t) => t.name === name)) return null
              let args = call?.function?.arguments ?? call?.arguments ?? {}
              if (typeof args === "string") {
                try {
                  args = JSON.parse(args)
                } catch {
                  args = {}
                }
              }
              return { id: id("call"), type: "function", function: { name, arguments: JSON.stringify(args) } }
            })
            .filter(Boolean)
          if (!toolCalls.length) toolCalls = null
          if (!parallel && toolCalls && toolCalls.length > 1) toolCalls = [toolCalls[0]]
        }
        if (toolCalls) finish = "tool_calls"
        else if (toolChoice === "required") {
          // A required call that never came is not an answer.
          throw new LogiccError("logicc: the model returned no tool call", { status: 502 })
        }
      }

      // An empty turn is how Logicc answers a prompt its guard turned away:
      // measured, a prompt naming a system path comes back with no events at
      // all, while the same prompt phrased innocuously answers normally. That
      // is a refusal, not an empty answer, so it must not be passed off as one.
      if (!text && !toolCalls) {
        throw new LogiccError(
          "logicc: the model returned nothing — Logicc's guard drops prompts that look like host filesystem access",
          { status: 502 },
        )
      }

      const answer = completionBody(model, text, turn.reasoning, turn.usage, finish)
      if (toolCalls) answer.choices[0].message.tool_calls = toolCalls
      return Response.json(answer)
    }

    // --- streaming --------------------------------------------------------
    try {
      return await streamTurn(response, { model, useTools, activeTools, toolChoice, parallel, signal: request.signal })
    } catch (error) {
      return errorResponse(error)
    }
  }

  async function streamTurn(response, { model, useTools, activeTools, toolChoice, parallel, signal }) {
    const stop = new AbortController()
    let finished = false

    const stream = new ReadableStream({
      async start(controller) {
        const send = (text) => {
          try {
            controller.enqueue(enc.encode(text))
          } catch {
            /* the reader went away */
          }
        }
        const onAbort = () => stop.abort(new Error("cancelled"))
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        }

        let buffered = ""
        // Tool mode buffers the whole envelope: it is JSON, and half an
        // envelope can't be resolved into a call.
        const emit = (delta) => {
          if (useTools) {
            buffered += delta
            return
          }
          send(chunkLine(model, { content: delta }))
        }

        try {
          send(chunkLine(model, { role: "assistant", content: "" }))

          const turn = await turnOf(response.body, {
            signal: AbortSignal.any(signal ? [signal, stop.signal] : [stop.signal]),
            onText: emit,
            onReasoning: (delta) => send(chunkLine(model, { reasoning_content: delta })),
          })

          if (turn.finishReason === "error") throw new LogiccError("logicc: the turn failed upstream", { status: 502 })

          if (useTools) {
            const envelope = envelopeOf(buffered)
            const raw = envelope?.tool_calls ?? (envelope?.tool_call ? [envelope.tool_call] : undefined)
            const text = typeof envelope?.content === "string" ? envelope.content : ""
            if (text) send(chunkLine(model, { content: text }))

            const kept = (Array.isArray(raw) ? raw : [])
              .map((call) => {
                const name = clean(call?.function?.name ?? call?.name)
                if (!name || !activeTools.some((t) => t.name === name)) return null
                let args = call?.function?.arguments ?? call?.arguments ?? {}
                if (typeof args === "string") {
                  try {
                    args = JSON.parse(args)
                  } catch {
                    args = {}
                  }
                }
                return { id: id("call"), name, arguments: JSON.stringify(args) }
              })
              .filter(Boolean)

            const calls = parallel ? kept : kept.slice(0, 1)
            if (calls.length) {
              calls.forEach((call, index) => {
                send(
                  chunkLine(model, {
                    tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }],
                  }),
                )
                send(
                  chunkLine(model, {
                    tool_calls: [{ index, function: { arguments: call.arguments } }],
                  }),
                )
              })
              send(chunkLine(model, {}, { finish: "tool_calls", usage: turn.usage }))
            } else {
              if (toolChoice === "required") {
                send(`data: ${JSON.stringify({ error: { message: "logicc: the model returned no tool call", type: "logicc_error" } })}\n\n`)
                send("data: [DONE]\n\n")
                return
              }
              send(chunkLine(model, {}, { finish: "stop", usage: turn.usage }))
            }

            finished = true
            send("data: [DONE]\n\n")
            return
          }

          // An empty turn is Logicc's guard dropping the prompt (measured —
          // see the non-streaming branch), and an unfinished one would be
          // taken as the answer. Both are reported as errors, not as an empty
          // reply that looks like the model simply had nothing to say.
          if (turn.truncated) {
            send(
              `data: ${JSON.stringify({
                error: {
                  message: turn.text
                    ? "logicc: the turn ended without finishing"
                    : "logicc: the model returned nothing — Logicc's guard drops prompts that look like host filesystem access",
                  type: "logicc_error",
                },
              })}\n\n`,
            )
            finished = true
            send("data: [DONE]\n\n")
            return
          }

          send(chunkLine(model, {}, { finish: turn.finishReason ?? "stop", usage: turn.usage }))

          finished = true
          send("data: [DONE]\n\n")
        } catch (error) {
          // A stream that has already started can't change its status, so the
          // failure goes out as an event and the stream ends.
          send(`data: ${JSON.stringify({ error: { message: error?.message ?? String(error), type: "logicc_error" } })}\n\n`)
          finished = true
          send("data: [DONE]\n\n")
        } finally {
          signal?.removeEventListener?.("abort", onAbort)
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        if (!finished) stop.abort(new Error("cancelled"))
      },
    })

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    })
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[ID] ??= {}
      const provider = cfg.provider[ID]
      provider.name ??= NAME
      provider.npm ??= NPM
      provider.api ??= CHAT_BASE
      // The bootstrap rows fill in whatever the user hasn't pinned.
      provider.models = { ...rowsOf(BOOTSTRAP), ...(provider.models ?? {}) }
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const creds = credsOf(auth)
        if (!creds) return provider.models
        let catalog
        try {
          catalog = await listModels(auth)
        } catch (error) {
          if (error?.signIn) throw error
          return provider.models
        }
        const rows = rowsOf(catalog)
        return Object.keys(rows).length ? rows : provider.models
      },
    },

    auth: {
      provider: ID,
      maxConcurrency: 1,
      async refresh(auth) {
        // magpie calls this ahead of a request when the JWT is close to its
        // end; a renewal here keeps the account usable without a re-paste.
        if (!stale(auth, 5 * 60 * 1000) && fresh(credsOf(auth)?.token)) return
        try {
          const { sessionToken } = await import("./src/logicc.mjs")
          const renewed = await sessionToken(auth, { force: true })
          if (typeof renewed === "object" && renewed.token) {
            return { ...auth, metadata: { ...(auth?.metadata ?? {}), jwt: renewed.token }, access: renewed.token }
          }
        } catch {
          /* a failed early renewal is not fatal; the request tries again */
        }
      },
      async loader(getAuth) {
        return {
          baseURL: CHAT_BASE,
          apiKey: "",
          async fetch(input, init) {
            const request = new Request(input, init)
            try {
              const path = new URL(request.url).pathname
              if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
                throw new LogiccError(`logicc: ${request.method} ${path} is not served by this provider`, { status: 404 })
              }
              return await chat(getAuth, request)
            } catch (error) {
              return errorResponse(error)
            }
          },
        }
      },

      options: [
        {
          key: "toolEnvelope",
          label: "Client tools through a JSON envelope",
          description:
            "Logicc's chat endpoint takes no tool schema, so a turn that declares tools is asked to answer with one JSON envelope and its calls are parsed back out. Turning this off makes such a request fail instead of being rewritten.",
          labels: { zh: "客户端工具走 JSON 信封" },
          descriptions: {
            zh: "Logicc 的聊天接口不接受工具定义，所以声明了工具的请求会被要求用一个 JSON 信封作答，再把调用解析回来。关掉的话这类请求直接报错，而不是被改写。",
          },
        },
      ],

      // The browser sign-ins are only offered when this process can actually
      // read the cookie store. Where macOS refuses that ("authorization
      // denied" — a magpie running as a launchd-started background service has
      // no GUI session to grant it), a browser sign-in would open a page and
      // then fail whatever the user does. An entry that is guaranteed to fail
      // is worse than none: it reads as broken rather than as an environment
      // limit.
      methods: canReadCookies()
        ? [
        {
          // The main way in: magpie opens Logicc's page in the user's browser,
          // they sign in there as usual, and this picks the result up from the
          // browser by itself. No cookie, no session id, no password here.
          type: "oauth",
          label: "Browser sign-in (OAuth, nothing to paste)",
          labels: {
            zh: "账号登录（浏览器登录，无需复制）",
            "zh-TW": "帳號登錄（瀏覽器登錄，無需複製）",
            en: "Browser sign-in (OAuth, nothing to paste)",
          },
          method: "auto",
          instructions:
            "Sign in on the Logicc page that just opened. magpie picks the account up by itself — nothing to copy, and you can close the tab when the page says you're done.",
          authorize: () => {
            const nonce = randomBytes(9).toString("hex")
            signInNonce = nonce
            const url = `${SIGN_IN_URL}?redirect_url=${encodeURIComponent(`${APP_ORIGIN}/?magpie=${nonce}`)}`

            // Point the user's own Chrome at it when this is a Mac with Chrome
            // running; say so to magpie either way (`opened`), so it doesn't
            // open a second copy in a different browser.
            const opened = openInChrome(url) !== "" ? true : openElsewhere(url)

            return {
              url,
              opened,
              instructions: opened
                ? "Sign in on the Logicc page that just opened. magpie picks the account up by itself — nothing to copy, and you can close the tab when the page says you're done."
                : "Open the Logicc page below and sign in. magpie picks the account up by itself — nothing to copy.",
              instructionsByLang: {
                zh: "在刚打开的 Logicc 页面完成登录即可。magpie 会自动读取账号，不用复制任何东西，看到页面说完成就可以关掉标签页。",
                "zh-TW": "在剛打開的 Logicc 頁面完成登錄即可。magpie 會自動讀取帳號，不用複製任何東西，看到頁面說完成就可以關掉標籤頁。",
              },
              method: "auto",
              callback: async () => {
                // Polled by magpie every ~800ms while the sheet is open. A
                // successful read is idempotent, so being called repeatedly is
                // harmless; before that it answers pending.
                let state
                try {
                  state = stateOf({ nonce })
                } catch (error) {
                  // Whatever goes wrong here has to come back as a reason, not
                  // as a throw: magpie turns an exception into a bare "the
                  // sign-in failed" with the cause dropped.
                  return { type: "failed", error: `Logicc sign-in read failed: ${String(error?.message ?? error).slice(0, 300)}` }
                }

                // macOS refused the cookie store to this process (measured on
                // magpie's own plugin host). Waiting won't change that, so say
                // what will work instead of polling forever.
                if (state.refused) {
                  return {
                    type: "failed",
                    error:
                      "macOS won't let magpie read Chrome's cookies, so this sign-in can't finish on its own. Use \"Paste the Logicc `__client` cookie\" instead — it is the same value, entered once.",
                  }
                }

                if (!state.clientCookie) return pending()
                if (!state.sessionId) return pending()

                // Prove the credential before handing it over, so a stale
                // cookie fails here with a clear reason instead of failing
                // every later request.
                try {
                  const models = await listModels({
                    key: state.clientCookie,
                    metadata: { clientCookie: state.clientCookie, sessionId: state.sessionId },
                  })
                  if (!models.length) return pending()
                } catch (error) {
                  if (error?.signIn) {
                    return {
                      type: "failed",
                      error: "That Logicc sign-in did not take. Sign in again on the page, then retry.",
                    }
                  }
                  return pending()
                }

                signInNonce = ""
                return {
                  type: "success",
                  key: state.clientCookie,
                  metadata: { clientCookie: state.clientCookie, sessionId: state.sessionId },
                }
              },
            }
          },
        },
        {
          // Still here for the case where the browser can't be read: a Linux
          // or Windows magpie, a different browser, or a locked keychain.
          type: "api",
          label: "Paste the Logicc `__client` cookie",
          labels: {
            zh: "粘贴 __client Cookie",
            "zh-TW": "貼上 __client Cookie",
            en: "Paste the `__client` cookie",
          },
          placeholder: "eyJhbGciOi…",
          note: "Only if the browser sign-in above can't be used. DevTools → Application → Cookies → clerk.logicc.com → the `__client` value. It is httpOnly, so it can't be read from the page console.",
          notes: {
            zh: "只在上面那条浏览器登录用不了时才用。开发者工具 → Application → Cookies → clerk.logicc.com → 复制 __client 的值。它是 httpOnly，页面控制台读不到。",
            "zh-TW": "只在上面那條瀏覽器登錄用不了時才用。開發者工具 → Application → Cookies → clerk.logicc.com → 複製 __client 的值。它是 httpOnly，頁面控制檯讀不到。",
          },
          prompts: [],
        },
        {
          // Third button, mirroring AWS Quick's: same browser sign-in, but the
          // link is only shown, never opened — for a remote magpie, or a user
          // who signs in with a different browser.
          type: "oauth",
          label: "Copy the sign-in link (don't open a browser)",
          labels: {
            zh: "复制登录地址（不自动打开浏览器）",
            "zh-TW": "複製登錄地址（不自動打開瀏覽器）",
            en: "Copy the sign-in link (don't open a browser)",
          },
          authorize: () => {
            const nonce = randomBytes(9).toString("hex")
            signInNonce = nonce
            const url = `${SIGN_IN_URL}?redirect_url=${encodeURIComponent(`${APP_ORIGIN}/?magpie=${nonce}`)}`
            return {
              url,
              // Nothing is opened: this variant exists so the user opens it
              // wherever they actually sign in.
              opened: true,
              method: "auto",
              instructions: "Copy the link below into whatever browser you sign in to Logicc with. magpie picks the account up once that browser is signed in.",
              callback: async () => {
                let state
                try {
                  state = stateOf({ nonce })
                } catch (error) {
                  return { type: "failed", error: String(error?.message ?? error).slice(0, 300) }
                }
                if (state.refused) {
                  return {
                    type: "failed",
                    error:
                      "macOS won't let magpie read the browser's cookies, so this sign-in can't finish on its own. Use \"Paste the Logicc `__client` cookie\" instead.",
                  }
                }
                if (!state.clientCookie || !state.sessionId) return pending()
                try {
                  const models = await listModels({
                    key: state.clientCookie,
                    metadata: { clientCookie: state.clientCookie, sessionId: state.sessionId },
                  })
                  if (!models.length) return pending()
                } catch (error) {
                  if (error?.signIn) return { type: "failed", error: "That Logicc sign-in did not take. Sign in again, then retry." }
                  return pending()
                }
                signInNonce = ""
                return {
                  type: "success",
                  key: state.clientCookie,
                  metadata: { clientCookie: state.clientCookie, sessionId: state.sessionId },
                }
              },
            }
          },
        },
          ]
        // Only the paste method survives where the store can't be read: it is
        // the one path that works there.
        : [pasteOnlyMethod()],

      async validate(auth) {
        const creds = credsOf(auth)
        if (!creds) return { ok: false, message: "No `__client` cookie or session JWT was given" }
        try {
          const models = await listModels(auth)
          if (!models.length) return { ok: false, message: "The account listed no models" }
          return { ok: true, message: `${models.length} models · ${creds.sessionId || "JWT"}` }
        } catch (error) {
          return { ok: false, message: error?.message ?? String(error) }
        }
      },

      account(auth) {
        const creds = credsOf(auth)
        const sid = clean(creds?.sessionId)
        const claim = claims(creds?.token)
        const email = clean(claim?.email) || clean((auth?.metadata ?? {}).email)
        return {
          id: sid || clean(claim?.sub) || "logicc",
          name: email || (sid ? `Logicc · ${sid.slice(-8)}` : "Logicc"),
          ...(sid ? { metadata: { sessionId: sid } } : {}),
        }
      },

      expiresAt,
    },

    // Logicc sends no token usage on its stream (measured: `finish` carries
    // no counts, and there is no usage endpoint), so there is nothing honest
    // to report here. Returning null keeps magpie from inventing numbers.
    async usage() {
      return null
    },
  }
}

export const LogiccPlugin = async () => createPlugin()

// pasteOnlyMethod is what a magpie that cannot read the cookie store gets: the
// one sign-in that works there. It is deliberately also the only one shown, so
// nothing offers a path that would fail after the user did their part.
function pasteOnlyMethod() {
  return {
    type: "api",
    label: "Paste the Logicc `__client` cookie",
    labels: {
      zh: "粘贴 __client Cookie",
      "zh-TW": "貼上 __client Cookie",
      en: "Paste the `__client` cookie",
    },
    placeholder: "__client value",
    note: "DevTools → Application → Cookies → clerk.logicc.com → copy the `__client` value. It is httpOnly, so the page console can't read it, and magpie can't read Chrome's cookie store on this Mac — that is why this one value has to come from you.",
    notes: {
      zh: "开发者工具 → Application → Cookies → clerk.logicc.com → 复制 __client 的值。它是 httpOnly，页面控制台读不到；而且这台 Mac 上 macOS 不允许 magpie 读取 Chrome 的 cookie 库，所以这个值需要你手动提供一次。",
      "zh-TW": "開發者工具 → Application → Cookies → clerk.logicc.com → 複製 __client 的值。它是 httpOnly，頁面控制檯讀不到；而且這台 Mac 上 macOS 不允許 magpie 讀取 Chrome 的 cookie 庫，所以這個值需要你手動提供一次。",
    },
    prompts: [],
  }
}

export const _internal = {
  contentOf,
  historyText,
  toolEnvelopePrompt,
  envelopeOf,
  stripModel,
  modelIdsOf,
}
