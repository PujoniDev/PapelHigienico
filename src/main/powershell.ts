import { execFile } from 'node:child_process';
import { join } from 'node:path';

const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

/**
 * Runs a fixed script. Dynamic values are passed through environment variables,
 * never interpolated into the script text.
 */
export function runPowerShell(script: string, env: Record<string, string> = {}, timeoutMs = 60_000): Promise<string> {
  const prelude = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n';
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}
