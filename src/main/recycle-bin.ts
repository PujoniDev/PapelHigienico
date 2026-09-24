import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { RecycleBinEmptyResult, RecycleBinInfo } from '@shared/types';
import { loadKoffi } from './native/koffi';

type BinFns = {
  SHQueryRecycleBinW: (root: string | null, info: Buffer) => number;
  SHEmptyRecycleBinW: (hwnd: number, root: string | null, flags: number) => number;
};

let fns: BinFns | null | undefined;

function bind(): BinFns | null {
  if (fns !== undefined) return fns;
  const koffi = loadKoffi();
  if (!koffi) return (fns = null);
  try {
    const shell32 = koffi.load('shell32.dll');
    fns = {
      SHQueryRecycleBinW: shell32.func('SHQueryRecycleBinW', 'int32_t', ['str16', 'void *']) as BinFns['SHQueryRecycleBinW'],
      SHEmptyRecycleBinW: shell32.func('SHEmptyRecycleBinW', 'int32_t', [
        'intptr_t', 'str16', 'uint32_t',
      ]) as BinFns['SHEmptyRecycleBinW'],
    };
  } catch {
    fns = null;
  }
  return fns;
}

const SHERB_NOCONFIRMATION = 0x1;
const SHERB_NOPROGRESSUI = 0x2;
const SHERB_NOSOUND = 0x4;

/** Size and item count of the Recycle Bin across all drives. */
export function queryRecycleBin(): RecycleBinInfo {
  const api = bind();
  if (!api) return { available: false, itemCount: 0, size: 0 };
  // SHQUERYRBINFO on x64: DWORD cbSize, (padding), __int64 i64Size, __int64 i64NumItems.
  const info = Buffer.alloc(24);
  info.writeUInt32LE(24, 0);
  const hr = api.SHQueryRecycleBinW(null, info);
  if (hr < 0) return { available: false, itemCount: 0, size: 0 };
  return {
    available: true,
    size: Number(info.readBigInt64LE(8)),
    itemCount: Number(info.readBigInt64LE(16)),
  };
}

/** Permanently empties the Recycle Bin of every drive. The caller must confirm first. */
export function emptyRecycleBin(): RecycleBinEmptyResult {
  const api = bind();
  if (!api) return { ok: false, freedBytes: null, message: 'Recurso indisponível neste computador.' };
  const before = queryRecycleBin();
  if (before.available && before.itemCount === 0) {
    return { ok: true, freedBytes: 0, message: 'A Lixeira já estava vazia.' };
  }
  const hr = api.SHEmptyRecycleBinW(0, null, SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND);
  const after = queryRecycleBin();
  if (hr < 0 && after.itemCount > 0) {
    return { ok: false, freedBytes: null, message: 'O Windows não conseguiu esvaziar a Lixeira.' };
  }
  return {
    ok: true,
    freedBytes: before.available && after.available ? Math.max(0, before.size - after.size) : null,
    message: after.itemCount > 0 ? 'Alguns itens não puderam ser removidos.' : undefined,
  };
}

export function openRecycleBin(): void {
  const explorer = join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
  spawn(explorer, ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref();
}
