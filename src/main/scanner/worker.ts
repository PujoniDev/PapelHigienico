import { parentPort, workerData } from 'node:worker_threads';
import { createDirectoryReader } from './reader';
import { runScan, type ScanInput } from './scan';

export interface ScanWorkerData {
  input: ScanInput;
  /** Int32 flag set to 1 by the main thread to request cancellation. */
  cancel: SharedArrayBuffer;
}

const port = parentPort!;
const data = workerData as ScanWorkerData;
const cancelFlag = new Int32Array(data.cancel);

try {
  const reader = createDirectoryReader();
  const result = runScan(reader, data.input, {
    isCancelled: () => Atomics.load(cancelFlag, 0) === 1,
    onProgress: (info) => port.postMessage({ type: 'progress', info }),
  });
  const buffers = [
    result.parent.buffer,
    result.size.buffer,
    result.logicalSize.buffer,
    result.fileCount.buffer,
    result.folderCount.buffer,
    result.directFiles.buffer,
    result.directSize.buffer,
    result.modified.buffer,
    result.flags.buffer,
  ] as ArrayBuffer[];
  port.postMessage({ type: 'done', result }, buffers);
} catch (error) {
  port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}
