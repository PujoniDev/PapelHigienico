import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const PARTIAL_SUFFIX = '.limpac-parcial';
const CHUNK = 1024 * 1024;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(path: string, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: CHUNK, signal });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    onBytes?.((chunk as Buffer).length);
  }
  return hash.digest('hex');
}

export interface VerifiedCopyOptions {
  signal?: AbortSignal;
  expectedSize: number;
  /** When set, the source content must match this hash (used when copying back). */
  expectedHash?: string;
  onBytes?(bytes: number, phase: 'copying' | 'verifying'): void;
}

/**
 * Copies `source` to `destination` without ever overwriting: data goes to a
 * partial file (hashing on the way), is flushed, re-read and compared, and only
 * then renamed into place. On any failure the partial file is removed and the
 * source is untouched. Returns the SHA-256 of the content.
 */
export async function copyVerified(source: string, destination: string, options: VerifiedCopyOptions): Promise<string> {
  const partial = destination + PARTIAL_SUFFIX;
  if (await pathExists(destination)) {
    throw Object.assign(new Error('Já existe um arquivo com esse nome no destino.'), { code: 'EEXIST' });
  }
  const hash = createHash('sha256');
  try {
    await pipeline(
      createReadStream(source, { highWaterMark: CHUNK }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          options.onBytes?.(chunk.length, 'copying');
          callback(null, chunk);
        },
      }),
      createWriteStream(partial, { flags: 'w', flush: true }),
      { signal: options.signal },
    );
    const sourceHash = hash.digest('hex');
    if (options.expectedHash && options.expectedHash !== sourceHash) {
      throw new Error('O arquivo de origem não confere com a cópia registrada.');
    }
    const written = await fsp.stat(partial);
    if (written.size !== options.expectedSize) {
      throw new Error('O tamanho da cópia não confere com o original.');
    }
    const copyHash = await hashFile(partial, options.signal, (n) => options.onBytes?.(n, 'verifying'));
    if (copyHash !== sourceHash) throw new Error('A verificação falhou: a cópia não é idêntica ao original.');
    if (await pathExists(destination)) {
      throw Object.assign(new Error('Já existe um arquivo com esse nome no destino.'), { code: 'EEXIST' });
    }
    await fsp.rename(partial, destination);
    return sourceHash;
  } catch (error) {
    await fsp.rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** "foto.jpg" -> "foto (2).jpg", skipping names that exist or are already claimed. */
export async function uniqueName(path: string, claimed: Set<string>): Promise<string> {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('\\');
  const hasExtension = dot > slash + 1;
  const base = hasExtension ? path.slice(0, dot) : path;
  const extension = hasExtension ? path.slice(dot) : '';
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})${extension}`;
    if (!claimed.has(candidate.toLowerCase()) && !(await pathExists(candidate))) return candidate;
  }
  throw new Error('Não foi possível encontrar um nome livre no destino.');
}
