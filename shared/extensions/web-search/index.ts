import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  formatSourcesSection,
  runSearch,
  type SearchInput,
} from "./core.ts";
import { enrichSourcesWithFetch } from "./enrich.ts";
import { BraveSearchProvider } from "./providers/brave.ts";
import type { SearchProvider } from "./providers/base.ts";
import { SearchProviderError, type SearchRecency, type SearchResponse } from "./types.ts";

export interface WebSearchToolParams {
  query: string;
  provider?: "auto" | "brave";
  recency?: SearchRecency;
  limit?: number;
  enrich?: boolean;
  fetchTop?: number;
}

const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query text." },
    provider: {
      type: "string",
      enum: ["auto", "brave"],
      description: "Search provider to use. 'auto' selects the first available provider.",
    },
    recency: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description: "Optional recency filter for results.",
    },
    limit: {
      type: "number",
      description: "Number of sources to return (clamped to 1..10, default 5).",
    },
    enrich: {
      type: "boolean",
      default: false,
      description: "Whether to fetch top results for excerpt enrichment.",
    },
    fetchTop: {
      type: "number",
      default: 0,
      description: "How many top results to enrich via fetch (clamped to 0..5).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

interface ToolComponent {
  render(width: number): string[];
  invalidate(): void;
}

function renderAsSimpleComponent(text: string): ToolComponent {
  return {
    render(_width: number): string[] {
      return text.split("\n");
    },
    invalidate() {},
  };
}

function formatMetaSection(response: SearchResponse): string {
  const lines = ["## Meta", `Provider: ${response.provider}`, `Sources: ${response.sources.length}`];
  if (response.requestId) {
    lines.push(`Request: ${response.requestId}`);
  }
  return lines.join("\n");
}

function formatWarningsSection(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return ["## Warnings", ...warnings.map((warning) => `- ${warning}`)].join("\n");
}

export function formatWebSearchEnvelope(response: SearchResponse, warnings: string[]): string {
  const parts = [formatSourcesSection(response.sources), formatMetaSection(response)];
  const warningsSection = formatWarningsSection(warnings);
  if (warningsSection) {
    parts.push(warningsSection);
  }
  return parts.join("\n\n");
}

export interface WebSearchToolDeps {
  providers?: SearchProvider[];
  searchRunner?: (
    input: SearchInput,
    providers: SearchProvider[],
    signal?: AbortSignal,
  ) => Promise<SearchResponse>;
  enricher?: typeof enrichSourcesWithFetch;
}

export function createWebSearchToolDefinition(deps: WebSearchToolDeps = {}) {
  const providers = deps.providers ?? [new BraveSearchProvider()];
  const searchRunner = deps.searchRunner ?? runSearch;
  const enricher = deps.enricher ?? enrichSourcesWithFetch;

  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Brave and optionally enrich top results with fetched excerpts.",
    parameters,

    async execute(
      _toolCallId: string,
      params: WebSearchToolParams,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      try {
        const response = await searchRunner(
          {
            query: params.query,
            provider: params.provider ?? "auto",
            recency: params.recency,
            limit: params.limit,
          },
          providers,
          signal,
        );

        const enriched = await enricher(response.sources, {
          enrich: params.enrich ?? false,
          fetchTop: params.fetchTop ?? 0,
        });

        const warnings = [...(response.warnings ?? []), ...enriched.warnings];
        const finalResponse: SearchResponse = {
          ...response,
          sources: enriched.sources,
          warnings,
        };

        return {
          content: [{ type: "text" as const, text: formatWebSearchEnvelope(finalResponse, warnings) }],
          details: {
            provider: finalResponse.provider,
            sourceCount: finalResponse.sources.length,
            requestId: finalResponse.requestId,
            warnings,
          },
        };
      } catch (error) {
        const message =
          error instanceof SearchProviderError || error instanceof Error
            ? error.message
            : String(error);

        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: {
            isError: true,
            error: message,
          },
        };
      }
    },

    renderCall(args: WebSearchToolParams) {
      return renderAsSimpleComponent(`web_search ${args.query}`);
    },

    renderResult(result: { details?: Record<string, unknown> }, options: { isPartial?: boolean }) {
      if (options.isPartial) {
        return renderAsSimpleComponent("Searching the web...");
      }

      const sourceCount = Number(result.details?.sourceCount ?? 0);
      const provider = String(result.details?.provider ?? "unknown");
      return renderAsSimpleComponent(`Web search complete (${sourceCount} sources, ${provider})`);
    },
  };
}

export default function registerWebSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool(createWebSearchToolDefinition());
}
