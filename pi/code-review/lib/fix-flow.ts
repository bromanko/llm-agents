/**
 * Helper functions for queued fix follow-up behavior in interactive code review.
 */

import type { Finding } from "./parser.ts";

export type QueueFixResult =
  | { ok: true }
  | { ok: false; error: unknown };

export type FindingAction =
  | { type: "fix" }
  | { type: "fix-custom"; instructions: string }
  | { type: "skip" }
  | { type: "stop" };

export type BuildFixMessage = (
  finding: Finding,
  customInstructions?: string,
) => string;

export type QueueSummary = {
  queuedFixCount: number;
  queueFailures: number;
};

export type NotificationLevel = "info" | "warning" | "error" | "success";

export type ReviewUiContext = {
  ui: {
    notify(message: string, level: NotificationLevel): void;
  };
};

export interface FollowUpMessenger {
  sendUserMessage(
    message: string,
    options: { deliverAs: "followUp" },
  ): Promise<void>;
}

/**
 * Queue a fix as a follow-up user message.
 * Follow-ups are processed by the runtime in the background.
 */
export async function queueFixFollowUp(
  pi: FollowUpMessenger,
  message: string,
): Promise<QueueFixResult> {
  try {
    await pi.sendUserMessage(message, { deliverAs: "followUp" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Convert unknown queue errors to a short user-facing reason.
 */
export function formatQueueError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "";
}

/**
 * Process finding actions and queue fix requests without blocking on waitForIdle.
 */
export async function processFindingActions({
  pi,
  ctx,
  findings,
  showFinding,
  buildFixMessage,
}: {
  pi: FollowUpMessenger;
  ctx: ReviewUiContext;
  findings: Finding[];
  showFinding: (
    finding: Finding,
    index: number,
    total: number,
  ) => Promise<FindingAction>;
  buildFixMessage: BuildFixMessage;
}): Promise<QueueSummary & { stoppedAt: number | null }> {
  let queuedFixCount = 0;
  let queueFailures = 0;
  let stoppedAt: number | null = null;

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!;
    const action = await showFinding(finding, i, findings.length);

    if (action.type === "stop") {
      stoppedAt = i;
      break;
    }

    if (action.type === "skip") {
      continue;
    }

    if (action.type === "fix" || action.type === "fix-custom") {
      const message = buildFixMessage(
        finding,
        action.type === "fix-custom" ? action.instructions : undefined,
      );

      const queueResult = await queueFixFollowUp(pi, message);
      if (queueResult.ok) {
        queuedFixCount += 1;
      } else {
        queueFailures += 1;
        const reason = formatQueueError(queueResult.error);
        ctx.ui.notify(
          `Failed to queue fix: ${finding.title}${reason ? ` (${reason})` : ""}`,
          "error",
        );
      }
    }
  }

  return {
    queuedFixCount,
    queueFailures,
    stoppedAt,
  };
}

/**
 * Show summary notification for queued fix results.
 */
export function notifyQueueSummary(ctx: ReviewUiContext, result: QueueSummary): void {
  if (result.queuedFixCount > 0) {
    ctx.ui.notify(
      `Queued ${result.queuedFixCount} follow-up fix request${result.queuedFixCount > 1 ? "s" : ""}. They will run while you continue reviewing.`,
      result.queueFailures === 0 ? "info" : "warning",
    );
  } else if (result.queueFailures > 0) {
    ctx.ui.notify("No fixes were queued due to send errors", "error");
  }
}
