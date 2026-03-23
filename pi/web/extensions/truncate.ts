export { truncateToWidth } from "../../lib/tui-shim.ts";

// This file lives under `extensions/`, so pi auto-loads it on `/reload`.
// Export a no-op extension factory to keep reload happy while preserving the
// helper export used by `fetch.ts` and `web-search/index.ts`.
export default function() { }
