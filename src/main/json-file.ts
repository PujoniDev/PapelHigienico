import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Writes through a temporary file and a rename so a crash never leaves half a file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value), 'utf8');
  await fsp.rename(temp, path);
}

/** Serializes async tasks so concurrent writers never interleave. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
