/**
 * Block mutating git commands in jujutsu repositories.
 *
 * Intercepts bash tool calls and blocks mutating git commands when
 * running inside a jj repo, guiding the user to jj equivalents.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isJjRepo } from "../lib/utils.ts";

const MUTATING_GIT_PATTERN =
  /(^|&&|\|\||;|\|)\s*git\s+(commit|branch|checkout|switch|merge|rebase|reset|stash|add|stage|push|fetch|pull)\b/;

const JJ_GIT_SUBCOMMAND = /\bjj\s+git\b/;

const BLOCK_REASON = `This is a jujutsu repository. Do not use mutating git commands. Use jujutsu equivalents instead:

- git commit → jj commit -m "message" or jj describe -m "message"
- git branch → jj branch create/set/delete
- git checkout/switch → jj edit or jj new
- git merge → jj new commit1 commit2
- git rebase → jj rebase
- git reset → jj restore or jj abandon
- git stash → not needed (auto-snapshotted)
- git add → not needed (auto-tracking)
- git push → jj git push
- git fetch → jj git fetch
- git pull → jj git fetch

Run 'jj --help' for more commands.`;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command ?? "";
    if (!command) return;

    // Guard against a missing or empty cwd before passing it to isJjRepo.
    // ExtensionContext types cwd as `string`, but defensive checks here prevent
    // a TypeError from path.join when the extension is exercised in tests or
    // edge-case runtimes where cwd may not yet be populated.
    if (!ctx.cwd) return;

    if (!isJjRepo(ctx.cwd)) return;

    // Allow jj git subcommands (jj git fetch, jj git push, etc.)
    if (JJ_GIT_SUBCOMMAND.test(command)) return;

    if (MUTATING_GIT_PATTERN.test(command)) {
      return { block: true, reason: BLOCK_REASON };
    }
  });
}
