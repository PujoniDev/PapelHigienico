import { describe, expect, it } from 'vitest';
import { queryRecycleBin } from '../recycle-bin';
import { listVolumes } from '../volumes';

// Read-only smoke tests against the real Windows APIs.
describe.runIf(process.platform === 'win32')('Windows bindings', () => {
  it('lists the system volume with sizes', async () => {
    const volumes = await listVolumes();
    const system = volumes.find((volume) => volume.isSystem);
    expect(system).toBeDefined();
    expect(system!.totalBytes).toBeGreaterThan(system!.freeBytes);
    expect(system!.usedBytes).toBeGreaterThan(0);
    expect(system!.fileSystem).not.toBe('');
  });

  it('reads the Recycle Bin size', () => {
    const bin = queryRecycleBin();
    expect(bin.available).toBe(true);
    expect(bin.size).toBeGreaterThanOrEqual(0);
    expect(bin.itemCount).toBeGreaterThanOrEqual(0);
  });
});
