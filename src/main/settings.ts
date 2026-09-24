import { join } from 'node:path';
import { z } from 'zod';
import type { Settings } from '@shared/types';
import { readJson, SerialQueue, writeJsonAtomic } from './json-file';

export const LARGE_FILE_THRESHOLDS_MB = [100, 250, 500, 1000, 2000] as const;

export const settingsSchema = z.object({
  defaultVolume: z.string().regex(/^[A-Z]:\\$/),
  largeFileThresholdMB: z.number().int().min(50).max(100_000),
  confirmTransfers: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
  lastDestination: z.string().max(1024).nullable(),
});

export function defaultSettings(): Settings {
  return {
    defaultVolume: ((process.env.SystemDrive ?? 'C:') + '\\').toUpperCase(),
    largeFileThresholdMB: 500,
    confirmTransfers: true,
    theme: 'system',
    lastDestination: null,
  };
}

export class SettingsStore {
  private readonly queue = new SerialQueue();
  private current: Settings | null = null;

  constructor(
    private readonly directory: string,
    private readonly onChange?: (settings: Settings) => void,
  ) {}

  private get path(): string {
    return join(this.directory, 'settings.json');
  }

  async get(): Promise<Settings> {
    if (this.current) return this.current;
    const stored = await readJson<{ version: number; settings: unknown }>(this.path);
    const merged = { ...defaultSettings(), ...(stored?.settings && typeof stored.settings === 'object' ? stored.settings : {}) };
    const parsed = settingsSchema.safeParse(merged);
    this.current = parsed.success ? parsed.data : defaultSettings();
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    return this.queue.run(async () => {
      const next = settingsSchema.parse({ ...(await this.get()), ...patch });
      await writeJsonAtomic(this.path, { version: 1, settings: next });
      this.current = next;
      this.onChange?.(next);
      return next;
    });
  }
}
