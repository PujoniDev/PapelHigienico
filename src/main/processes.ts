import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** Lower-case image names of running processes, or null when they cannot be listed. */
export function runningProcessNames(): Promise<Set<string> | null> {
  const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
  return new Promise((resolve) => {
    execFile(tasklist, ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      const names = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^"([^"]+)"/.exec(line);
        if (match) names.add(match[1].toLowerCase());
      }
      resolve(names);
    });
  });
}
