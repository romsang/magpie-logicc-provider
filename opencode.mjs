// The face magpie and OpenCode 1.x load: the plugin functions and nothing
// else. Helpers stay in index.mjs and src/, because 1.x refuses a package
// whose exports include anything that isn't a plugin.
export { LogiccPlugin } from "./index.mjs"
