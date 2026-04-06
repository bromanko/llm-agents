import * as fs from "node:fs";
import * as path from "node:path";
import { extractUsageRecords } from "./entry-extract.ts";
import type { UsageRecord, ResolvedDateRange } from "./types.ts";

export interface ScanResult {
  records: UsageRecord[];
  filesScanned: number;
  warningCount: number;
}

export interface SessionFileLoader {
  loadEntriesFromFile(filePath: string): unknown[] | Promise<unknown[]>;
  migrateSessionEntries(entries: unknown[]): void;
}

/**
 * Simple JSONL parser used as the default loader when pi runtime functions
 * are not injected. Replicates the behavior of pi's loadEntriesFromFile:
 * reads line by line, skips blank/malformed lines, returns parsed objects.
 */
async function defaultLoadEntriesFromFile(
  filePath: string,
): Promise<unknown[]> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  const entries: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function defaultMigrateSessionEntries(_entries: unknown[]): void {
  // No-op: migration is only meaningful with pi's real implementation
}

const defaultLoader: SessionFileLoader = {
  loadEntriesFromFile: defaultLoadEntriesFromFile,
  migrateSessionEntries: defaultMigrateSessionEntries,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function scanSessionFiles(
  sessionsRoot: string,
  onProgress?: (scanned: number, total: number) => void,
  loader: SessionFileLoader = defaultLoader,
  range?: ResolvedDateRange,
): Promise<ScanResult> {
  const records: UsageRecord[] = [];
  let warningCount = 0;

  try {
    await fs.promises.access(sessionsRoot);
  } catch {
    return { records: [], filesScanned: 0, warningCount: 0 };
  }

  const resolvedRoot = path.resolve(sessionsRoot);

  // Discover all .jsonl files under sessionsRoot/<subdir>/
  const allFiles: string[] = [];

  try {
    const subdirs = await fs.promises.readdir(sessionsRoot, {
      withFileTypes: true,
    });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;

      // Path traversal protection: ensure resolved path stays within root
      const subdirPath = path.resolve(sessionsRoot, subdir.name);
      if (
        subdirPath !== resolvedRoot &&
        !subdirPath.startsWith(resolvedRoot + path.sep)
      ) {
        warningCount++;
        continue;
      }

      try {
        const files = await fs.promises.readdir(subdirPath);
        for (const file of files.sort()) {
          if (file.endsWith(".jsonl")) {
            const filePath = path.resolve(subdirPath, file);
            // Path traversal protection for individual files
            if (!filePath.startsWith(resolvedRoot + path.sep)) {
              warningCount++;
              continue;
            }
            allFiles.push(filePath);
          }
        }
      } catch {
        warningCount++;
      }
    }
  } catch {
    return { records: [], filesScanned: 0, warningCount: 0 };
  }

  const totalFiles = allFiles.length;
  let scannedCount = 0;

  for (const [i, filePath] of allFiles.entries()) {
    // Yield every 10 files to let renders flush
    if (i > 0 && i % 10 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }

    try {
      const entries = await loader.loadEntriesFromFile(filePath);

      if (entries.length === 0) {
        warningCount++;
        scannedCount++;
        onProgress?.(scannedCount, totalFiles);
        continue;
      }

      loader.migrateSessionEntries(entries);

      // Extract header for cwd
      let cwd = "";
      const header = entries.find(
        (e) => isRecord(e) && (e as Record<string, unknown>).type === "session",
      );
      if (header && isRecord(header)) {
        cwd = typeof header.cwd === "string" ? header.cwd : "";
      }

      // Filter out header entries
      const nonHeaders = entries.filter(
        (e) =>
          !(isRecord(e) && (e as Record<string, unknown>).type === "session"),
      );

      const extracted = extractUsageRecords(nonHeaders, filePath, cwd, range);
      for (const record of extracted) {
        records.push(record);
      }
    } catch {
      warningCount++;
    }

    scannedCount++;
    onProgress?.(scannedCount, totalFiles);
  }

  return { records, filesScanned: totalFiles, warningCount };
}
