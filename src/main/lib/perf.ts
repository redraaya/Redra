/**
 * Minimal perf instrumentation: console lines + an in-memory log
 * queryable over IPC ('perf:get'). Budgets (cold start < 1.5 s,
 * save < 100 ms) are only measured and logged at this stage.
 */

import type { PerfEntry } from '../../shared/ipc.js';

export type { PerfEntry };

export class PerfLog {
  private entries: PerfEntry[] = [];

  record(name: string, ms: number, detail?: Record<string, number>): PerfEntry {
    const entry: PerfEntry = {
      name,
      ms: Math.round(ms * 10) / 10,
      at: Date.now(),
      ...(detail ? { detail } : {}),
    };
    this.entries.push(entry);
    const detailStr = detail
      ? ' (' +
        Object.entries(detail)
          .map(([k, v]) => `${k} ${Math.round(v * 10) / 10}ms`)
          .join(', ') +
        ')'
      : '';
    console.log(`[perf] ${entry.name}: ${entry.ms}ms${detailStr}`);
    return entry;
  }

  all(): PerfEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
}
