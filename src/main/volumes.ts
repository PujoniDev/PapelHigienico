import { existsSync, promises as fsp } from 'node:fs';
import type { VolumeInfo, VolumeType } from '@shared/types';
import { loadKoffi } from './native/koffi';

type VolumeFns = {
  GetLogicalDrives: () => number;
  GetDriveTypeW: (root: string) => number;
  GetDiskFreeSpaceExW: (root: string, available: Buffer, total: Buffer, free: Buffer) => number;
  GetVolumeInformationW: (
    root: string, name: Buffer, nameSize: number, serial: null, maxComponent: null, flags: null, fsName: Buffer, fsNameSize: number,
  ) => number;
};

let fns: VolumeFns | null | undefined;

function bind(): VolumeFns | null {
  if (fns !== undefined) return fns;
  const koffi = loadKoffi();
  if (!koffi) return (fns = null);
  try {
    const kernel32 = koffi.load('kernel32.dll');
    fns = {
      GetLogicalDrives: kernel32.func('GetLogicalDrives', 'uint32_t', []) as VolumeFns['GetLogicalDrives'],
      GetDriveTypeW: kernel32.func('GetDriveTypeW', 'uint32_t', ['str16']) as VolumeFns['GetDriveTypeW'],
      GetDiskFreeSpaceExW: kernel32.func('GetDiskFreeSpaceExW', 'int', [
        'str16', 'void *', 'void *', 'void *',
      ]) as VolumeFns['GetDiskFreeSpaceExW'],
      GetVolumeInformationW: kernel32.func('GetVolumeInformationW', 'int', [
        'str16', 'void *', 'uint32_t', 'void *', 'void *', 'void *', 'void *', 'uint32_t',
      ]) as VolumeFns['GetVolumeInformationW'],
    };
  } catch {
    fns = null;
  }
  return fns;
}

const DRIVE_TYPES: Record<number, VolumeType> = {
  2: 'removable',
  3: 'fixed',
  4: 'network',
  5: 'cdrom',
  6: 'ramdisk',
};

function systemRoot(): string {
  return ((process.env.SystemDrive ?? 'C:') + '\\').toUpperCase();
}

function nativeVolume(api: VolumeFns, root: string): VolumeInfo | null {
  const type = DRIVE_TYPES[api.GetDriveTypeW(root)] ?? 'unknown';
  const available = Buffer.alloc(8);
  const total = Buffer.alloc(8);
  const free = Buffer.alloc(8);
  // Empty card readers and disconnected network drives fail here; skip them.
  if (!api.GetDiskFreeSpaceExW(root, available, total, free)) return null;
  const name = Buffer.alloc(522);
  const fsName = Buffer.alloc(522);
  let label = '';
  let fileSystem = '';
  if (api.GetVolumeInformationW(root, name, 261, null, null, null, fsName, 261)) {
    label = name.toString('utf16le').replace(/\0.*$/s, '');
    fileSystem = fsName.toString('utf16le').replace(/\0.*$/s, '');
  }
  const totalBytes = Number(total.readBigUInt64LE());
  const freeBytes = Number(available.readBigUInt64LE());
  return {
    root,
    letter: root[0],
    label,
    fileSystem,
    type,
    totalBytes,
    freeBytes,
    usedBytes: Math.max(0, totalBytes - Number(free.readBigUInt64LE())),
    isSystem: root === systemRoot(),
  };
}

async function fallbackVolume(root: string): Promise<VolumeInfo | null> {
  try {
    const stats = await fsp.statfs(root);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      root,
      letter: root[0],
      label: '',
      fileSystem: '',
      type: 'unknown',
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - stats.bfree * stats.bsize),
      isSystem: root === systemRoot(),
    };
  } catch {
    return null;
  }
}

export async function getVolume(root: string): Promise<VolumeInfo | null> {
  const normalized = root.slice(0, 1).toUpperCase() + ':\\';
  const api = bind();
  return api ? nativeVolume(api, normalized) : fallbackVolume(normalized);
}

export async function listVolumes(): Promise<VolumeInfo[]> {
  const api = bind();
  const letters: string[] = [];
  if (api) {
    const mask = api.GetLogicalDrives();
    for (let i = 0; i < 26; i++) if (mask & (1 << i)) letters.push(String.fromCharCode(65 + i));
  } else {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      if (existsSync(`${letter}:\\`)) letters.push(letter);
    }
  }
  const volumes: VolumeInfo[] = [];
  for (const letter of letters) {
    const root = `${letter}:\\`;
    const volume = api ? nativeVolume(api, root) : await fallbackVolume(root);
    if (volume && volume.type !== 'cdrom' && volume.totalBytes > 0) volumes.push(volume);
  }
  return volumes;
}

/** Free bytes on a volume, or null when it cannot be measured. */
export async function freeBytesOf(root: string): Promise<number | null> {
  const volume = await getVolume(root);
  return volume ? volume.freeBytes : null;
}

/** Growth in free space across volumes, or null when any measurement is missing. */
export function measuredGain(before: (number | null)[], after: (number | null)[]): number | null {
  if (before.some((value) => value === null) || after.some((value) => value === null)) return null;
  const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return Math.max(0, sum(after) - sum(before));
}
