/**
 * Context File Approval Gate — Prompt stripping
 *
 * Pure functions for removing denied context file content from the
 * system prompt string. Operates on pi's known prompt format.
 *
 * ── FORMAT DEPENDENCY NOTICE ──────────────────────────────────────────
 *
 * This module depends on pi's exact system prompt layout as of v0.65.x.
 * If pi's prompt format changes, stripping may silently fail or produce
 * incorrect results. The verifyStripping() function provides a post-strip
 * sanity check, but it only catches cases where `## <path>` markers
 * remain — it will not detect partial stripping or content leakage from
 * minor formatting shifts (e.g. extra whitespace, different heading level).
 *
 * Assumed layout:
 *
 *   # Project Context
 *   (blank line)
 *   Project-specific instructions and guidelines:
 *   (blank line)
 *   ## /absolute/path/to/AGENTS.md
 *   (blank line)
 *   <content>
 *   (blank line)
 *   ## /path/to/next/file  (or section boundary)
 *
 * Section boundaries recognised after context file content:
 *   - Next `## ` heading
 *   - `\nThe following skills` (skills section)
 *   - `\nCurrent date:` (metadata footer)
 *
 * If the prompt structure does not match these expectations the strip
 * attempt for a given path will be a no-op and verifyStripping() will
 * report the path as failed, allowing the caller to warn or act.
 */

/**
 * Remove all sections for denied paths from the system prompt.
 *
 * Each context file appears as:
 *   ## /absolute/path/to/AGENTS.md\n\n<content>\n\n
 *
 * After stripping all files, if the Project Context section header
 * is left empty, it is removed too.
 */
export function stripDeniedContextFiles(
  systemPrompt: string,
  deniedPaths: Set<string>,
): string {
  if (deniedPaths.size === 0) return systemPrompt;

  let prompt = systemPrompt;

  for (const deniedPath of deniedPaths) {
    // Pi formats context files as:  ## /path/to/AGENTS.md\n\n<content>\n\n
    const marker = `## ${deniedPath}\n\n`;
    const idx = prompt.indexOf(marker);
    if (idx === -1) continue;

    // Find the end of this section: next ## heading or end of Project Context
    const afterMarker = idx + marker.length;
    let endIdx = prompt.length;

    // Look for next ## heading
    const nextHeading = prompt.indexOf("\n## ", afterMarker);
    if (nextHeading !== -1) {
      endIdx = nextHeading + 1; // keep the newline before next heading
    } else {
      // No next heading — find where the section content ends
      // Look for the skills section or date line that follows context
      const skillsMarker = prompt.indexOf(
        "\nThe following skills",
        afterMarker,
      );
      const dateMarker = prompt.indexOf("\nCurrent date:", afterMarker);
      if (skillsMarker !== -1) endIdx = skillsMarker;
      else if (dateMarker !== -1) endIdx = dateMarker;
    }

    prompt = prompt.slice(0, idx) + prompt.slice(endIdx);
  }

  // Clean up empty Project Context section if all files were stripped
  const emptySection =
    "# Project Context\n\nProject-specific instructions and guidelines:\n\n";
  if (prompt.includes(emptySection)) {
    const sectionIdx = prompt.indexOf(emptySection);
    const afterSection = sectionIdx + emptySection.length;
    // Check if there's nothing meaningful after it before the next section
    const nextContent = prompt.slice(afterSection).trimStart();
    if (
      nextContent.startsWith("The following skills") ||
      nextContent.startsWith("Current date:") ||
      nextContent.length === 0
    ) {
      prompt = prompt.slice(0, sectionIdx) + prompt.slice(afterSection);
    }
  }

  // Collapse any runs of 3+ newlines left by stripping into exactly 2
  prompt = prompt.replace(/\n{3,}/g, "\n\n");

  return prompt;
}

/**
 * Check whether any denied path's `## <path>` marker still appears
 * in the prompt after stripping. Returns the list of paths that
 * failed to strip (empty array means success).
 */
export function verifyStripping(
  systemPrompt: string,
  deniedPaths: Set<string>,
): string[] {
  const failed: string[] = [];
  for (const p of deniedPaths) {
    if (systemPrompt.includes(`## ${p}`)) {
      failed.push(p);
    }
  }
  return failed;
}
