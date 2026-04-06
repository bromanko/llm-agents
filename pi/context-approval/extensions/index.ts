/**
 * Context File Approval Gate
 *
 * Intercepts AGENTS.md / CLAUDE.md context files and requires explicit
 * approval before their content reaches the LLM. Files are tracked by
 * SHA-256 hash — if a file is new or has changed since last approval,
 * the user is prompted to approve or deny it.
 *
 * Approvals are persisted in ~/.pi/agent/context-approvals.json.
 * Files inside ~/.pi/agent/ are auto-trusted (user's own config).
 *
 * Commands:
 *   /context-approvals          — list all tracked files and their status
 *   /context-approvals revoke   — revoke a specific approval
 *   /context-approvals reset    — clear all approvals
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  type ApprovalStore,
  type ContextFile,
  type FileVerdict,
  discoverContextFiles,
  isUserOwnedConfig,
  loadApprovals,
  saveApprovals,
  sha256,
  shortenPath,
} from "../lib/helpers.ts";
import { stripDeniedContextFiles, verifyStripping } from "../lib/prompt.ts";

export default function contextApprovalExtension(pi: ExtensionAPI) {
  /** Files denied in this session (including persisted denials). */
  let deniedPaths = new Set<string>();
  /** Full map of discovered files for this session. */
  let discoveredFiles: ContextFile[] = [];

  // ── Session start: discover, hash, prompt ──────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    deniedPaths = new Set();
    discoveredFiles = await discoverContextFiles(ctx.cwd);

    if (discoveredFiles.length === 0) return;

    let store: ApprovalStore;
    try {
      store = await loadApprovals();
    } catch {
      store = {};
    }
    let storeChanged = false;

    const pending: Array<{
      file: ContextFile;
      hash: string;
      reason: "new" | "changed";
    }> = [];

    for (const file of discoveredFiles) {
      // Auto-trust user's own config dir
      if (isUserOwnedConfig(file.path)) continue;

      const hash = sha256(file.content);
      const record = store[file.path];

      if (record?.denied) {
        // Previously permanently denied — keep denied, no prompt
        deniedPaths.add(file.path);
        continue;
      }

      if (record && record.hash === hash) {
        // Previously approved, unchanged — pass through
        continue;
      }

      const reason = record ? "changed" : "new";
      pending.push({ file, hash, reason });
    }

    if (pending.length === 0) return;

    // Non-interactive mode: deny all pending
    if (!ctx.hasUI) {
      for (const { file } of pending) deniedPaths.add(file.path);
      return;
    }

    ctx.ui.notify(
      `${pending.length} context file${pending.length > 1 ? "s" : ""} need${pending.length === 1 ? "s" : ""} review`,
      "warning",
    );

    for (const { file, hash, reason } of pending) {
      const verdict = await promptForApproval(file, hash, reason, store, ctx);
      if (verdict === "approved") {
        store[file.path] = {
          hash,
          approvedAt: new Date().toISOString(),
        };
        storeChanged = true;
      } else {
        deniedPaths.add(file.path);
      }
    }

    if (storeChanged) {
      try {
        await saveApprovals(store);
      } catch {
        try {
          ctx.ui.notify(
            "⚠️ Failed to save approval store — approvals are session-only",
            "warning",
          );
        } catch {
          /* UI may be unavailable */
        }
      }
    }

    // Status summary
    const approved = discoveredFiles.filter(
      (f) => !deniedPaths.has(f.path),
    ).length;
    const denied = deniedPaths.size;
    if (denied > 0) {
      ctx.ui.notify(
        `Context files: ${approved} approved, ${denied} denied`,
        "info",
      );
    }
  });

  // ── Before agent start: strip denied file content from system prompt ─

  pi.on("before_agent_start", async (event) => {
    if (deniedPaths.size === 0) return;

    const prompt = stripDeniedContextFiles(event.systemPrompt, deniedPaths);

    // Post-strip verification
    const failed = verifyStripping(prompt, deniedPaths);
    if (failed.length > 0) {
      console.warn(
        `[context-approval] ⚠️ Failed to strip ${failed.length} denied context file(s) — pi's prompt format may have changed: ${failed.join(", ")}`,
      );
    }

    return { systemPrompt: prompt };
  });

  // ── Approval prompt UI ─────────────────────────────────────────────

  async function promptForApproval(
    file: ContextFile,
    hash: string,
    reason: "new" | "changed",
    store: ApprovalStore,
    ctx: ExtensionContext,
  ): Promise<FileVerdict> {
    const short = shortenPath(file.path, ctx.cwd);
    const tag = reason === "new" ? "NEW" : "CHANGED";
    const lines = file.content.split("\n").length;
    const size =
      file.content.length < 1024
        ? `${file.content.length}B`
        : `${(file.content.length / 1024).toFixed(1)}KB`;

    while (true) {
      try {
        const choice = await ctx.ui.select(
          `Context file review: ${short} [${tag}] (${lines} lines, ${size})`,
          [
            "Approve — include in context",
            "Deny — exclude this session",
            "Permanently deny — always exclude until revoked",
            "View content",
          ],
        );

        if (
          choice === undefined ||
          choice === "Deny — exclude this session"
        ) {
          return "denied";
        }

        if (choice === "Approve — include in context") {
          return "approved";
        }

        if (choice === "Permanently deny — always exclude until revoked") {
          store[file.path] = {
            hash,
            approvedAt: new Date().toISOString(),
            denied: true,
          };
          try {
            await saveApprovals(store);
          } catch {
            /* store write failure — denial still applies for this session */
          }
          return "denied";
        }

        if (choice === "View content") {
          try {
            await ctx.ui.editor(
              `${short} (read-only preview)`,
              file.content,
            );
          } catch {
            /* editor may fail — loop back to prompt */
          }
          continue;
        }

        return "denied";
      } catch {
        // UI call failed — fail-safe to denied
        try {
          ctx.ui.notify(
            `⚠️ Approval prompt failed for ${short} — denying by default`,
            "warning",
          );
        } catch {
          /* UI unavailable */
        }
        return "denied";
      }
    }
  }

  // ── /context-approvals command ──────────────────────────────────────

  const subcommands = [
    { value: "revoke", label: "revoke", description: "Revoke a specific approval" },
    { value: "reset", label: "reset", description: "Clear all approvals" },
  ];

  pi.registerCommand("context-approvals", {
    description: "Manage context file (AGENTS.md / CLAUDE.md) approvals",
    getArgumentCompletions: (prefix: string) => {
      const filtered = subcommands.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const subcommand = args?.trim().toLowerCase();

      if (subcommand === "reset") {
        try {
          await saveApprovals({});
        } catch {
          ctx.ui.notify("⚠️ Failed to reset approval store", "warning");
          return;
        }
        deniedPaths.clear();
        ctx.ui.notify(
          "All context file approvals cleared. Run /reload to re-evaluate.",
          "info",
        );
        return;
      }

      if (subcommand === "revoke") {
        const store = await loadApprovals();
        const paths = Object.keys(store);
        if (paths.length === 0) {
          ctx.ui.notify("No approvals to revoke.", "info");
          return;
        }

        const items = paths.map((p) => {
          const record = store[p];
          const status = record.denied ? "[denied]" : "[approved]";
          return `${status}  ${shortenPath(p, ctx.cwd)}`;
        });

        const selected = await ctx.ui.select("Revoke approval for:", items);
        if (!selected) return;

        // Find the path from the selected label
        const idx = items.indexOf(selected);
        if (idx === -1) return;

        const pathToRevoke = paths[idx];
        delete store[pathToRevoke];
        try {
          await saveApprovals(store);
        } catch {
          ctx.ui.notify("⚠️ Failed to save after revoke", "warning");
          return;
        }
        deniedPaths.delete(pathToRevoke);
        ctx.ui.notify(
          `Revoked: ${shortenPath(pathToRevoke, ctx.cwd)}. Run /reload to re-evaluate.`,
          "info",
        );
        return;
      }

      // Default: list
      const store = await loadApprovals();
      const allPaths = new Set([
        ...discoveredFiles.map((f) => f.path),
        ...Object.keys(store),
      ]);

      if (allPaths.size === 0) {
        ctx.ui.notify("No context files discovered or tracked.", "info");
        return;
      }

      const lines: string[] = [];
      for (const p of allPaths) {
        const short = shortenPath(p, ctx.cwd);
        const record = store[p];
        const discovered = discoveredFiles.some((f) => f.path === p);
        const autoTrusted = isUserOwnedConfig(p);
        const denied = deniedPaths.has(p);

        let status: string;
        if (autoTrusted) {
          status = "auto-trusted (user config)";
        } else if (record?.denied) {
          status = "permanently denied";
        } else if (denied) {
          status = "denied (this session)";
        } else if (record) {
          status = `approved (${record.approvedAt.slice(0, 10)})`;
        } else {
          status = "unknown";
        }

        const presence = discovered ? "" : " [not found on disk]";
        lines.push(`  ${short}${presence}\n    ${status}`);
      }

      ctx.ui.notify(
        `Context file approvals:\n\n${lines.join("\n\n")}\n\nUse /context-approvals revoke to remove an entry\nUse /context-approvals reset to clear all`,
        "info",
      );
    },
  });
}
