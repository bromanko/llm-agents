import type { ResolvedDateRange } from "./types.ts";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function resolveDateRange(
  input: string,
  now?: Date,
): ResolvedDateRange {
  const n = now ?? new Date();
  const normalized = input.trim().toLowerCase();

  const today = startOfDay(n);
  const tomorrow = addDays(today, 1);

  switch (normalized) {
    case "today":
      return {
        label: "today",
        startMs: today.getTime(),
        endMsExclusive: tomorrow.getTime(),
      };

    case "yesterday": {
      const yesterday = addDays(today, -1);
      return {
        label: "yesterday",
        startMs: yesterday.getTime(),
        endMsExclusive: today.getTime(),
      };
    }

    case "this week": {
      const day = n.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const diffToMonday = day === 0 ? 6 : day - 1;
      const monday = addDays(today, -diffToMonday);
      return {
        label: "this week",
        startMs: monday.getTime(),
        endMsExclusive: tomorrow.getTime(),
      };
    }

    case "last week": {
      const day = n.getDay();
      const diffToMonday = day === 0 ? 6 : day - 1;
      const thisMonday = addDays(today, -diffToMonday);
      const lastMonday = addDays(thisMonday, -7);
      return {
        label: "last week",
        startMs: lastMonday.getTime(),
        endMsExclusive: thisMonday.getTime(),
      };
    }

    case "this month": {
      const firstOfMonth = new Date(n.getFullYear(), n.getMonth(), 1);
      return {
        label: "this month",
        startMs: firstOfMonth.getTime(),
        endMsExclusive: tomorrow.getTime(),
      };
    }

    case "last month": {
      const firstOfThisMonth = new Date(n.getFullYear(), n.getMonth(), 1);
      const firstOfLastMonth = new Date(
        n.getFullYear(),
        n.getMonth() - 1,
        1,
      );
      return {
        label: "last month",
        startMs: firstOfLastMonth.getTime(),
        endMsExclusive: firstOfThisMonth.getTime(),
      };
    }

    case "all time":
      return {
        label: "all time",
        startMs: 0,
        endMsExclusive: n.getTime() + 365 * 24 * 60 * 60 * 1000,
      };
  }

  // "last N days"
  const lastNMatch = normalized.match(/^last\s+(\d+)\s+days?$/);
  if (lastNMatch) {
    const days = parseInt(lastNMatch[1], 10);
    const start = addDays(tomorrow, -days);
    return {
      label: `last ${days} days`,
      startMs: start.getTime(),
      endMsExclusive: tomorrow.getTime(),
    };
  }

  // Explicit YYYY-MM-DD..YYYY-MM-DD
  const explicitMatch = normalized.match(
    /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/,
  );
  if (explicitMatch) {
    const [, startStr, endStr] = explicitMatch;
    const [sy, sm, sd] = startStr.split("-").map(Number);
    const [ey, em, ed] = endStr.split("-").map(Number);
    const startDate = new Date(sy, sm - 1, sd);
    const endDate = new Date(ey, em - 1, ed);
    const endExclusive = addDays(endDate, 1);

    if (startDate.getTime() > endDate.getTime()) {
      throw new Error(
        `Start date is after end date: ${startStr} .. ${endStr}`,
      );
    }

    return {
      label: `${startStr} .. ${endStr}`,
      startMs: startDate.getTime(),
      endMsExclusive: endExclusive.getTime(),
    };
  }

  throw new Error(`Unknown range: '${input.trim()}'`);
}
