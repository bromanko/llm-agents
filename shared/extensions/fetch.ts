import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fetchUrl, type FetchRequest, type FetchResponse } from "../lib/fetch-core.ts";

export interface FetchToolParams {
  url: string;
  timeout?: number;
  raw?: boolean;
  maxBytes?: number;
  maxLines?: number;
}

type FetchExecutor = (request: FetchRequest) => Promise<FetchResponse>;

const parameters = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to fetch" },
    timeout: { type: "number", description: "Timeout in seconds (default: 20)" },
    raw: { type: "boolean", description: "Return raw content without text transforms" },
    maxBytes: { type: "number", description: "Maximum output bytes before truncation" },
    maxLines: { type: "number", description: "Maximum output lines before truncation" },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

function formatTruncationNotice(response: FetchResponse): string {
  const note = response.notes.find((entry) => entry.includes("Output truncated"));
  if (note) return note;

  if (response.truncation) {
    return (
      `[Output truncated: showing ${response.truncation.outputLines} of ${response.truncation.totalLines} lines` +
      ` (${response.truncation.outputBytes} of ${response.truncation.totalBytes} bytes).` +
      (response.fullOutputPath ? ` Full output saved to: ${response.fullOutputPath}]` : "]")
    );
  }

  if (response.fullOutputPath) {
    return `[Output truncated. Full output saved to: ${response.fullOutputPath}]`;
  }

  return "[Output truncated.]";
}

export function formatFetchEnvelope(response: FetchResponse): string {
  const lines: string[] = [];
  lines.push(`URL: ${response.requestUrl}`);

  if (response.finalUrl && response.finalUrl !== response.requestUrl) {
    lines.push(`Final URL: ${response.finalUrl}`);
  }

  lines.push(`Status: ${response.status}`);
  lines.push(`Content-Type: ${response.contentType}`);
  lines.push(`Method: ${response.method}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(response.content);

  if (response.truncated) {
    lines.push("");
    lines.push(formatTruncationNotice(response));
  }

  const nonTruncationNotes = response.notes.filter((entry) => !entry.includes("Output truncated"));
  if (nonTruncationNotes.length > 0) {
    lines.push("");
    for (const note of nonTruncationNotes) {
      lines.push(`Note: ${note}`);
    }
  }

  return lines.join("\n");
}

/**
 * Minimal component matching the pi TUI Component interface.
 * See {@link https://github.com/nickg/pi-tui Component} for the full contract.
 */
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

export function createFetchToolDefinition(fetchImpl: FetchExecutor = fetchUrl) {
  return {
    name: "fetch",
    label: "Fetch",
    description:
      "Fetch a URL (http/https) and return readable content with metadata. " +
      "Output is truncated when needed to keep context bounded.",
    parameters,

    async execute(
      _toolCallId: string,
      params: FetchToolParams,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      const response = await fetchImpl({
        url: params.url,
        timeoutSeconds: params.timeout,
        raw: params.raw,
        maxBytes: params.maxBytes,
        maxLines: params.maxLines,
      });

      return {
        content: [{ type: "text" as const, text: formatFetchEnvelope(response) }],
        details: {
          requestUrl: response.requestUrl,
          finalUrl: response.finalUrl,
          status: response.status,
          contentType: response.contentType,
          method: response.method,
          truncated: response.truncated,
          fullOutputPath: response.fullOutputPath,
          notes: response.notes,
          truncation: response.truncation,
        },
      };
    },

    renderCall(args: FetchToolParams) {
      return renderAsSimpleComponent(`fetch ${args.url}`);
    },

    renderResult(result: { details?: Record<string, unknown> }, options: { isPartial?: boolean }) {
      if (options.isPartial) return renderAsSimpleComponent("Fetching...");
      const status = result.details?.status ?? "?";
      const contentType = result.details?.contentType ?? "unknown";
      return renderAsSimpleComponent(`Fetch complete (${status}, ${contentType})`);
    },
  };
}

export default function registerFetchExtension(pi: ExtensionAPI): void {
  pi.registerTool(createFetchToolDefinition());
}
