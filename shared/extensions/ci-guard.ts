/**
 * CI Guard Extension
 *
 * Blocks `jj git push` and `git push` commands if `selfci check` hasn't
 * passed in the current session.
 *
 * Requires: selfci configured in the project (.config/selfci/ci.yaml).
 * Works with both jj and git repositories.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Canonical text fragment that selfci emits when a run is successful.
 * Any bash tool-result whose text contains both "✅" and "passed" is treated
 * as a passing CI signal (see `isCiPassOutput`).
 */
export const CI_PASS_SIGNAL = "✅ passed";

/**
 * Returns true when the output text of a bash tool-result indicates a
 * successful selfci run.  selfci always emits "✅" followed by "passed"
 * somewhere in its success output.
 */
export function isCiPassOutput(text: string): boolean {
  return text.includes("✅") && text.includes("passed");
}

/**
 * Check session history to see if CI has passed after all file mutations.
 */
function hasCiPassedAfterMutations(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  
  let lastCiPassIndex = -1;
  let lastMutationIndex = -1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    
    if (entry.type === "message") {
      const msg = entry.message;
      
      // Check for successful selfci check (look for passing output)
      if (msg.role === "toolResult" && msg.toolName === "bash" && !msg.isError) {
        const content = msg.content;
        const text = content.map((c: { type: string; text?: string }) => 
          c.type === "text" ? c.text : ""
        ).join("");
        
        // selfci outputs "✅ passed" on success (see CI_PASS_SIGNAL / isCiPassOutput)
        if (isCiPassOutput(text)) {
          lastCiPassIndex = i;
        }
      }
      
      // Check for file mutations (edit/write)
      if (msg.role === "toolResult" && (msg.toolName === "edit" || msg.toolName === "write")) {
        if (!msg.isError) {
          lastMutationIndex = i;
        }
      }
    }
  }

  // CI is valid if it passed after the last mutation
  return lastCiPassIndex > lastMutationIndex;
}

export default function (pi: ExtensionAPI) {
  // Block push if CI hasn't passed
  pi.on("tool_call", async (event, ctx) => {
    // Only the "bash" tool can invoke git/jj; all other tool names are
    // unconditionally ignored.  This is intentional: if a future tool were
    // added that can also run shell commands it should be explicitly opted in
    // here rather than accidentally bypassing the guard.
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";

    const isPush = /jj\s+git\s+push/.test(command) || /git\s+push/.test(command);
    if (!isPush) return;

    // Check if selfci is configured
    const hasSelfci = await pi.exec("test", ["-f", ".config/selfci/ci.yaml"]);
    if (hasSelfci.code !== 0) return;

    if (!hasCiPassedAfterMutations(ctx)) {
      return {
        block: true,
        reason: "CI has not passed for the current changes. Run `selfci check` first and ensure it passes before pushing.",
      };
    }
  });
}
