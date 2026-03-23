const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

type TextLikeComponent = {
  render(width: number): string[];
  invalidate(): void;
};

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function fallbackVisibleWidth(text: string): number {
  return [...stripAnsi(String(text))].length;
}

function fallbackTruncateToWidth(text: string, width: number, ellipsis = "…"): string {
  const value = String(text);
  if (!Number.isFinite(width) || width <= 0) return "";
  if (fallbackVisibleWidth(value) <= width) return value;

  const ellipsisWidth = Math.min(width, fallbackVisibleWidth(ellipsis));
  const ellipsisText = [...ellipsis].slice(0, ellipsisWidth).join("");
  if (width <= ellipsisWidth) return ellipsisText;

  const targetWidth = width - ellipsisWidth;
  let output = "";
  let visible = 0;

  for (const char of value) {
    if (visible >= targetWidth) break;
    output += char;
    visible += 1;
  }

  return output + ellipsisText;
}

class FallbackText implements TextLikeComponent {
  private readonly text: string;

  constructor(text: string, ..._args: unknown[]) {
    this.text = text;
  }

  render(width: number): string[] {
    return String(this.text)
      .split("\n")
      .map((line) => fallbackTruncateToWidth(line, width));
  }

  invalidate(): void { }
}

class FallbackMarkdown extends FallbackText { }

let truncateImpl = fallbackTruncateToWidth;
let visibleWidthImpl = fallbackVisibleWidth;
let TextImpl: new (...args: any[]) => TextLikeComponent = FallbackText;
let MarkdownImpl: new (...args: any[]) => TextLikeComponent = FallbackMarkdown;

try {
  const tui = await import("@mariozechner/pi-tui");
  if (typeof tui.truncateToWidth === "function") {
    truncateImpl = tui.truncateToWidth;
  }
  if (typeof tui.visibleWidth === "function") {
    visibleWidthImpl = tui.visibleWidth;
  }
  if (typeof tui.Text === "function") {
    TextImpl = tui.Text as typeof TextImpl;
  }
  if (typeof tui.Markdown === "function") {
    MarkdownImpl = tui.Markdown as typeof MarkdownImpl;
  }
} catch (error) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
}

export type TUI = {
  requestRender(): void;
};

export const truncateToWidth: (text: string, width: number, ellipsis?: string) => string =
  (text, width, ellipsis) => truncateImpl(text, width, ellipsis);

export const visibleWidth: (text: string) => number = (text) => visibleWidthImpl(text);

export const Text = TextImpl;
export const Markdown = MarkdownImpl;
