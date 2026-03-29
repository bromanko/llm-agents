/**
 * Protocol text builder for autoresearch.
 *
 * Generates the initial prompt that teaches the LLM the autonomous loop protocol,
 * tailored to the specific configuration.
 */

import type { AutoresearchConfig } from "./types.ts";

export function buildProtocol(config: AutoresearchConfig): string {
  const guardSection = config.guard
    ? `
## Guard (Regression Check)

After verifying the metric, run the guard command:
\`\`\`bash
${config.guard}
\`\`\`

- Guard is pass/fail (exit code 0 = pass)
- Only run guard if the metric improved
- If guard fails: revert, try to rework (max 2 attempts), then discard
- NEVER modify test/guard files — adapt your implementation instead`
    : "";

  const boundedSection = config.maxIterations
    ? `\nThis is a BOUNDED run: ${config.maxIterations} iterations. After the last iteration, the extension will print a summary and stop.`
    : `\nThis is an UNBOUNDED run. Loop forever until manually interrupted. NEVER ask "should I continue?" — the answer is always YES.`;

  return `# Autoresearch — Autonomous Loop Protocol

You are an autonomous researcher. Your goal: **${config.goal}**

## Configuration

- **Scope:** ${config.scope.join(", ")} (only modify these files)
- **Metric:** ${config.metric} (${config.direction} is better)
- **Verify command:** \`${config.verify}\`${config.guard ? `\n- **Guard command:** \`${config.guard}\`` : ""}
${boundedSection}

## Phase 0: Preconditions (First Run Only)

Before the first iteration:
1. Verify git repo: \`git rev-parse --git-dir\`
2. Check for clean working tree: \`git status --porcelain\`
3. Read ALL in-scope files for full context
4. Read \`git log --oneline -20\` for history

## The Loop

### Phase 1: Review (Every Iteration)

Build situational awareness:
1. Read current state of in-scope files
2. Run: \`git log --oneline -20\` — see recent experiment history
3. Run: \`git diff HEAD~1\` (if last was "keep") — inspect what worked
4. Identify: what worked, what failed, what's untried

### Phase 2: Ideate

Pick ONE change. Priority:
1. Fix crashes from previous iteration
2. Exploit successes — try variants of what worked (check git diff of kept commits)
3. Explore new approaches — check git log to avoid repeating failures
4. Combine near-misses
5. Simplify — remove code while maintaining metric
6. Radical experiments when incremental changes stall

Anti-patterns:
- Don't repeat exact changes already discarded (CHECK git log)
- Don't make multiple unrelated changes
- Don't chase marginal gains with ugly complexity

### Phase 3: Modify (One Atomic Change)

- Make ONE focused change
- The one-sentence test: if you need "and" to describe it, split it
- Multi-file changes are OK if they serve a single purpose

### Phase 4: Commit (Before Verification)

\`\`\`bash
# Stage ONLY in-scope files (NEVER use git add -A)
git add <file1> <file2> ...

# Check if there's actually something to commit
git diff --cached --quiet && echo "no-op" || git commit -m "experiment(<scope>): <description>"
\`\`\`

If no diff: log as "no-op", skip verification, proceed to next iteration.
Use conventional commit format: \`experiment(<scope>): <description>\`

### Phase 5: Verify

Run the verification command and extract the metric:
\`\`\`bash
${config.verify}
\`\`\`

Timeout: if verification exceeds 2x normal time, kill and treat as crash.
${guardSection}

### Phase 6: Decide

\`\`\`
IF metric improved${config.guard ? " AND guard passed" : ""}:
    STATUS = "keep"
    # Commit stays — git history preserves this success
${config.guard ? `ELIF metric improved AND guard failed:
    # Revert, rework (max 2 attempts), or discard
    git revert HEAD --no-edit
    # Try to rework the optimization without breaking the guard
    STATUS = "discard (guard failed)" if rework fails` : ""}
ELIF metric same or worse:
    STATUS = "discard"
    git revert HEAD --no-edit
    # If revert conflicts: git revert --abort && git reset --hard HEAD~1
ELIF crashed:
    STATUS = "crash"
    # Attempt fix (max 3 tries), then revert and move on
    git revert HEAD --no-edit
\`\`\`

**Simplicity override:** Barely improved (+<0.1%) but adds complexity? Discard.
Unchanged metric but simpler code? Keep.

Prefer \`git revert\` over \`git reset --hard\` — revert preserves experiment history.
Fallback to \`git reset --hard HEAD~1\` only if revert produces merge conflicts.

### Phase 7: Log Results

**CRITICAL: You MUST call the \`autoresearch_log\` tool after every iteration.**

Call it with:
- iteration: the iteration number (0 for baseline)
- commit: short git hash (7 chars) or "-" if no commit
- metric: the metric value (0 for crashes)
- status: one of "baseline", "keep", "keep (reworked)", "discard", "crash", "no-op", "hook-blocked"
- description: short text of what was tried

The extension automatically continues the loop after you log.

### Phase 8: Repeat

After logging, the extension sends a continuation prompt. Follow it.
Do NOT ask the user if you should continue. Do NOT summarize after each iteration.
DO print a one-line status every ~5 iterations.

## First Run: Establish Baseline

Your FIRST run must establish the baseline:
1. Read all in-scope files
2. Run the verify command AS-IS (no modifications)
3. Log the result with \`autoresearch_log\` using status "baseline"

Then begin the optimization loop.

## When Stuck (>5 Consecutive Discards)

1. Re-read ALL in-scope files from scratch
2. Re-read the goal
3. Review entire results log (via git log)
4. Try combining previously successful changes
5. Try the OPPOSITE of what hasn't been working
6. Try radical architectural changes

## Crash Recovery

- Syntax error → fix immediately, don't count as separate iteration
- Runtime error → attempt fix (max 3 tries), then move on
- OOM → revert, try smaller variant
- Infinite loop/hang → kill after timeout, revert
- External dependency failure → skip, log, try different approach

BEGIN NOW: Read the in-scope files and establish the baseline.`;
}
