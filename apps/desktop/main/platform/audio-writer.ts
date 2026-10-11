import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  ftruncateSync,
  writeSync,
  unlinkSync,
} from 'node:fs';
import { TurnnoteError, requireCondition } from '@shared/result';

const HEADER_SIZE = 44;
const MAX_DATA = 0xffffffff - 36;

function header(bytes: number): Buffer {
  const result = Buffer.alloc(HEADER_SIZE);
  result.write('RIFF', 0);
  result.writeUInt32LE(36 + bytes, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(bytes, 40);
  return result;
}

function writeAll(fd: number, data: Buffer, position: number): void {
  let offset = 0;
  while (offset < data.length) {
    const count = writeSync(fd, data, offset, data.length - offset, position + offset);
    if (!count) throw new TurnnoteError('WRITE_FAILED');
    offset += count;
  }
}

export interface AudioWriter {
  append(chunk: Int16Array): void;
  finalize(): Promise<void>;
}

/** Exclusive creation prevents overwriting recoverable audio. */
export function createAudioWriter(outputPath: string): AudioWriter {
  let fd: number;
  try {
    fd = openSync(outputPath, 'wx', 0o600);
  } catch {
    throw new TurnnoteError('WRITE_FAILED');
  }
  let closed = false;
  let failed = false;
  let bytes = 0;
  try {
    writeAll(fd, header(0), 0);
  } catch {
    try {
      closeSync(fd);
    } catch {
      /* Still attempt to remove the file created exclusively by this call. */
    }
    try {
      unlinkSync(outputPath);
    } catch {
      /* Preserve the safe WRITE_FAILED error if cleanup also fails. */
    }
    throw new TurnnoteError('WRITE_FAILED');
  }
  return {
    append(chunk) {
      requireCondition(
        chunk instanceof Int16Array && chunk.length > 0 && chunk.length <= 32000,
        'INVALID_INPUT',
      );
      requireCondition(!closed && !failed, 'INVALID_STATE');
      requireCondition(bytes + chunk.byteLength <= MAX_DATA, 'WRITE_FAILED');
      // WAV is little-endian regardless of host architecture.
      const data = Buffer.allocUnsafe(chunk.byteLength);
      chunk.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
      try {
        writeAll(fd, data, HEADER_SIZE + bytes);
        bytes += data.length;
      } catch {
        failed = true;
        throw new TurnnoteError('WRITE_FAILED');
      }
    },
    async finalize() {
      if (closed) {
        if (failed) throw new TurnnoteError('WRITE_FAILED');
        return;
      }
      try {
        // Include complete samples left by a partial write, preserving recoverable data.
        const actual = Math.floor((fstatSync(fd).size - HEADER_SIZE) / 2) * 2;
        ftruncateSync(fd, HEADER_SIZE + actual);
        writeAll(fd, header(actual), 0);
        fsyncSync(fd);
      } catch {
        failed = true;
      } finally {
        closed = true;
        try {
          closeSync(fd);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new TurnnoteError('WRITE_FAILED');
    },
  };
}

/** Repairs only our canonical PCM WAV files; unknown formats are never rewritten. */
export async function repairWavHeader(path: string): Promise<boolean> {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const size = fstatSync(fd).size;
    if (size < HEADER_SIZE + 2 || size - HEADER_SIZE > MAX_DATA) return false;
    const existing = Buffer.alloc(HEADER_SIZE);
    if (readSync(fd, existing, 0, HEADER_SIZE, 0) !== HEADER_SIZE) return false;
    const expected = header(0);
    if (
      !existing.subarray(0, 4).equals(expected.subarray(0, 4)) ||
      !existing.subarray(8, 40).equals(expected.subarray(8, 40))
    )
      return false;
    const bytes = Math.floor((size - HEADER_SIZE) / 2) * 2;
    ftruncateSync(fd, HEADER_SIZE + bytes);
    writeAll(fd, header(bytes), 0);
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Best effort after repair failure. */
      }
    }
  }
}
