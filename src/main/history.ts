import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry, HistoryReport } from '@shared/types';
import { readJson, SerialQueue, writeJsonAtomic } from './json-file';

const MAX_ENTRIES = 300;
const MAX_REPORT_ITEMS = 2000;

interface HistoryFile {
  version: 1;
  entries: HistoryEntry[];
}

interface ReportFile {
  version: 1;
  lines: HistoryReport['lines'];
  items: HistoryReport['items'];
  truncatedItems: number;
}

export interface ReportInput {
  lines: HistoryReport['lines'];
  items: HistoryReport['items'];
}

/** Local log of operations. Stores paths and sizes only, never file contents. */
export class HistoryStore {
  private readonly queue = new SerialQueue();

  constructor(readonly directory: string) {}

  private get indexPath(): string {
    return join(this.directory, 'history.json');
  }

  private reportPath(id: string): string {
    return join(this.directory, 'reports', `${id}.json`);
  }

  async list(): Promise<HistoryEntry[]> {
    const file = await readJson<HistoryFile>(this.indexPath);
    return file?.version === 1 && Array.isArray(file.entries) ? file.entries : [];
  }

  async add(entry: Omit<HistoryEntry, 'id' | 'hasReport'>, report?: ReportInput): Promise<HistoryEntry> {
    const full: HistoryEntry = { ...entry, id: randomUUID(), hasReport: Boolean(report) };
    return this.queue.run(async () => {
      if (report) {
        const reportFile: ReportFile = {
          version: 1,
          lines: report.lines,
          items: report.items.slice(0, MAX_REPORT_ITEMS),
          truncatedItems: Math.max(0, report.items.length - MAX_REPORT_ITEMS),
        };
        await writeJsonAtomic(this.reportPath(full.id), reportFile);
      }
      const entries = await this.list();
      entries.unshift(full);
      const removed = entries.splice(MAX_ENTRIES);
      await writeJsonAtomic(this.indexPath, { version: 1, entries } satisfies HistoryFile);
      await Promise.all(removed.map((old) => fsp.rm(this.reportPath(old.id), { force: true })));
      return full;
    });
  }

  async report(id: string): Promise<HistoryReport | null> {
    const entry = (await this.list()).find((candidate) => candidate.id === id);
    if (!entry) return null;
    const file = entry.hasReport ? await readJson<ReportFile>(this.reportPath(id)) : null;
    return {
      entry,
      lines: file?.lines ?? [],
      items: file?.items ?? [],
      truncatedItems: file?.truncatedItems ?? 0,
    };
  }

  async clear(): Promise<void> {
    await this.queue.run(async () => {
      await fsp.rm(join(this.directory, 'reports'), { recursive: true, force: true });
      await fsp.rm(this.indexPath, { force: true });
    });
  }
}
