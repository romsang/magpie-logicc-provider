// Reading Logicc's answer stream.
//
// Logicc answers a prompt with server-sent events of the AI SDK v6 shape —
// one JSON object per `data:` frame, `type` naming what happened:
//
//   text-delta              { delta }
//   reasoning-delta         { delta }
//   tool-input-start        { toolCallId, toolName }
//   tool-input-delta        { toolCallId, inputTextDelta }
//   tool-input-available    { toolCallId, toolName, input }
//   finish                  { finishReason }
//   finish-step / start / start-step / error
//
// Frames are separated by a blank line and one frame's `data:` may arrive in
// pieces, so the buffer is only drained on a separator.

import { LogiccError } from "./logicc.mjs"

export async function* readEvents(body) {
  const decoder = new TextDecoder()
  let buffer = ""

  const parse = (frame) => {
    const text = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!text || text === "[DONE]") return null
    try {
      return JSON.parse(text)
    } catch {
      throw new LogiccError("Logicc sent an event that is not JSON", { status: 502 })
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let at
    while ((at = /\r?\n\r?\n/.exec(buffer))) {
      const event = parse(buffer.slice(0, at.index))
      buffer = buffer.slice(at.index + at[0].length)
      if (event) yield event
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) {
    const event = parse(buffer)
    if (event) yield event
  }
}

// turnOf folds the event stream into what one turn produced: the text, the
// reasoning, the tool calls, why it stopped, and the token counts.
export async function turnOf(body, { onText, onReasoning, signal } = {}) {
  let text = ""
  let reasoning = ""
  let finishReason = "stop"
  let usage = null
  const calls = new Map()

  for await (const event of readEvents(body)) {
    if (signal?.aborted) break
    const type = event?.type

    if (type === "error") {
      throw new LogiccError(`Logicc stream error: ${event.errorText ?? event.error ?? "unknown"}`, { status: 502 })
    }
    if (type === "text-delta" && typeof event.delta === "string") {
      text += event.delta
      if (event.delta) onText?.(event.delta)
      continue
    }
    if (type === "reasoning-delta" && typeof event.delta === "string") {
      reasoning += event.delta
      if (event.delta) onReasoning?.(event.delta)
      continue
    }
    if (type === "tool-input-start") {
      const id = event.toolCallId ?? event.id
      if (id) calls.set(id, { id, name: event.toolName ?? "", arguments: "" })
      continue
    }
    if (type === "tool-input-delta") {
      const call = calls.get(event.toolCallId ?? event.id)
      if (call) call.arguments += event.inputTextDelta ?? event.delta ?? ""
      continue
    }
    if (type === "tool-input-available") {
      const id = event.toolCallId ?? event.id
      if (id) {
        const existing = calls.get(id) ?? { id, name: event.toolName ?? "", arguments: "" }
        if (event.toolName) existing.name = event.toolName
        if (event.input !== undefined) {
          existing.arguments = typeof event.input === "string" ? event.input : JSON.stringify(event.input)
        }
        calls.set(id, existing)
      }
      continue
    }
    if (type === "finish") {
      if (["stop", "length", "content_filter", "tool_calls"].includes(event.finishReason)) {
        finishReason = event.finishReason
      }
      const counted = event.totalUsage ?? event.usage ?? event.messageMetadata?.usage
      if (counted) {
        const input = counted.inputTokens ?? counted.prompt_tokens
        const output = counted.outputTokens ?? counted.completion_tokens
        if (Number.isFinite(input) && Number.isFinite(output)) {
          usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
        }
      }
    }
  }

  return {
    text,
    reasoning,
    finishReason,
    usage,
    // An unfinished stream is not a clean stop.
    truncated: finishReason === "stop" && !text && calls.size === 0,
    calls: [...calls.values()].filter((c) => c.name),
  }
}
