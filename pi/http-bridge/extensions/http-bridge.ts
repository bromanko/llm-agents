/**
 * HTTP Bridge Extension
 *
 * Starts a local HTTP server that accepts messages and injects them into the
 * running pi session as if you typed them.
 *
 * Toggle with `/bridge` (or `/bridge start` / `/bridge stop`).
 * Configure the port with the PI_BRIDGE_PORT env var (default: 8789).
 *
 * Usage from any HTTP client:
 *
 *   curl -X POST localhost:8789 \
 *     -H 'Content-Type: application/json' \
 *     -d '{"message": "add milk to my todo list"}'
 *
 * The message appears in the terminal and triggers a full agent turn, exactly
 * as if you had typed it.
 */

import * as http from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const DEFAULT_PORT = 8789;

function getPort(): number {
  const env = process.env.PI_BRIDGE_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

export default function (pi: ExtensionAPI) {
  let server: http.Server | undefined;
  let activePort: number | undefined;
  let ui: ExtensionContext["ui"] | undefined;

  function updateWidget(): void {
    if (!ui) return;
    if (server) {
      ui.setWidget("http-bridge", [`🔌 HTTP bridge listening on localhost:${activePort}`]);
    } else {
      ui.setWidget("http-bridge", undefined);
    }
  }

  function start(ctx: ExtensionContext): void {
    if (server) {
      ctx.ui.notify(`Bridge already running on localhost:${activePort}`, "warning");
      return;
    }

    const port = getPort();

    server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "POST only" }));
        return;
      }

      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk: Buffer) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      try {
        const { message } = JSON.parse(body);
        if (!message?.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "empty message" }));
          return;
        }

        pi.sendUserMessage(message);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON — expected {\"message\": \"...\"}" }));
      }
    });

    server.listen(port, "127.0.0.1", () => {
      activePort = port;
      ui = ctx.ui;
      updateWidget();
      ctx.ui.notify(`Bridge listening on localhost:${port}`, "info");
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        ctx.ui.notify(`Port ${port} already in use`, "error");
      } else {
        ctx.ui.notify(`Bridge error: ${err.message}`, "error");
      }
      server = undefined;
      activePort = undefined;
    });
  }

  function stop(ctx: ExtensionContext): void {
    if (!server) {
      ctx.ui.notify("Bridge is not running", "warning");
      return;
    }
    server.closeAllConnections();
    server.close();
    server = undefined;
    activePort = undefined;
    ui = ctx.ui;
    updateWidget();
    ctx.ui.notify("Bridge stopped", "info");
  }

  const subcommands: AutocompleteItem[] = [
    { value: "start", label: "start", description: "Start the HTTP bridge" },
    { value: "stop", label: "stop", description: "Stop the HTTP bridge" },
    { value: "status", label: "status", description: "Show bridge status" },
  ];

  pi.registerCommand("bridge", {
    description: "Toggle the HTTP bridge (start/stop/status)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const filtered = subcommands.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "start") {
        start(ctx);
      } else if (sub === "stop") {
        stop(ctx);
      } else if (sub === "status") {
        ctx.ui.notify(
          server ? `Bridge running on localhost:${activePort}` : "Bridge is stopped",
          "info",
        );
      } else {
        // Toggle
        if (server) stop(ctx);
        else start(ctx);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    if (server) {
      server.closeAllConnections();
      server.close();
    }
  });
}
