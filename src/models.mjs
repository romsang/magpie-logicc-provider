// Turning Logicc's model list into the rows magpie shows.
//
// Logicc's `/api/models` returns one entry per model this account may use:
//
//   { id, displayName, provider, contextWindow, reasoningType, answerStyle,
//     knowledgeCutoff, regions }
//
// `contextWindow` is a band, not a number ("gigantic" | "medium"), so it is
// mapped to a known size rather than invented per model. Logicc sends no
// reasoning deltas on the wire — measured — even for a model declared
// `always-reasoning-configurable`, so `reasoning` is false: advertising it
// would make agents wait for tokens that never come.

export const NPM = "@ai-sdk/openai-compatible"
export const CHAT_BASE = "https://app.logicc.com/api/v1"

// The bands Logicc publishes, as what its chat endpoint actually accepts.
//
// `contextWindow` describes the model's own window at the vendor, NOT what
// this endpoint will take: measured, a prompt above roughly 115,000 characters
// (~29,000 tokens) is rejected with HTTP 400 no matter which band the model
// carries. Telling magpie the vendor's number makes an agent fill the context
// and get refused, so the cap below is the endpoint's, not the model's.
const BANDS = { gigantic: 30_000, large: 30_000, medium: 30_000, small: 30_000 }

// The ceiling this endpoint accepts, in tokens, before its own 400.
// Verified by bisection: ~28,900 tokens passed, ~31,250 did not.
export const ENDPOINT_CAP = Number(process.env.LOGICC_ENDPOINT_CAP || 28_000)

// The context a model is reported with: the endpoint's own ceiling, since a
// larger number only invites a request Logicc answers with 400.
export const DEFAULT_CONTEXT = Number(process.env.LOGICC_CONTEXT || ENDPOINT_CAP)
export const DEFAULT_OUTPUT = Number(process.env.LOGICC_OUTPUT || 32_000)

// A bootstrap list so the Providers page shows something before a sign-in and
// the plugin reports a non-empty model list. The live catalog replaces it.
export const BOOTSTRAP = [
  { id: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", provider: "open-ai", contextWindow: "gigantic" },
  { id: "gpt-6-luna", displayName: "GPT-6 Luna", provider: "open-ai", contextWindow: "gigantic" },
  { id: "claude-opus-4-5", displayName: "Claude Opus 4.5", provider: "anthropic", contextWindow: "gigantic" },
]

const clean = (v) => (typeof v === "string" ? v.trim() : "")

// contextOf turns a band into a token count, and respects an explicit number
// if Logicc ever starts sending one.
function contextOf(band, fallback = DEFAULT_CONTEXT) {
  const asked = Number.isFinite(band) && band > 0
    ? band
    : (BANDS[clean(band).toLowerCase()] ?? fallback)
  // Never report more than the endpoint accepts: a bigger number does not
  // give an agent more room, it only produces a request Logicc answers 400 to.
  return Math.min(asked, ENDPOINT_CAP)
}

// rowOf is the descriptor both magpie readers take: the config hook reads the
// top-level fields, the models hook reads `capabilities`.
//
// tool_call is true because this plugin does offer client tools — through the
// JSON envelope, not through Logicc itself. See toolEnvelopePrompt.
export function rowOf(model, { output = DEFAULT_OUTPUT, context } = {}) {
  const id = clean(model?.id ?? model?.modelId)
  if (!id) return null
  // Logicc calls the display name `displayName`; older/other shapes use
  // `name`. A missing name falls back to the id rather than an empty label.
  const name = clean(model?.displayName) || clean(model?.name) || id
  return {
    id,
    providerID: "logicc",
    name,
    api: { id, url: CHAT_BASE, npm: NPM },
    limit: { context: contextOf(model?.contextWindow, context), output },
    reasoning: false,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning: false,
      toolcall: true,
      attachment: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    options: {},
    headers: {},
    variants: {},
    status: "active",
    release_date: clean(model?.knowledgeCutoff),
  }
}

// rowsOf turns a catalog into { id: row }, the shape config and the models
// hook both return.
export function rowsOf(models, options) {
  const out = {}
  for (const model of Array.isArray(models) ? models : []) {
    const row = rowOf(model, options)
    if (row) out[row.id] = row
  }
  return out
}

// modelIdsOf is only what a turn needs: the ids, in catalog order.
export function modelIdsOf(models) {
  return (Array.isArray(models) ? models : []).map((m) => clean(m?.id ?? m?.modelId)).filter(Boolean)
}

export const BAND_SIZES = BANDS
