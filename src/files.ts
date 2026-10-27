// Output directories are user-owned. Never follow a destination-file symlink and never
// expose a half-written note. Parent-directory symlinks are trusted configuration, not a jail.
import { constants, openSync, closeSync, fsyncSync, fchmodSync, fstatSync, readSync,
  writeFileSync, lstatSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function safeWriteFile(path: string, data: string | Uint8Array, overwrite = false, mode = 0o666): void {
  let finalMode = mode & ~process.umask();
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`refusing non-regular output: ${path}`);
    if (overwrite) finalMode = st.mode & 0o666;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const temp = join(dirname(path), `.${basename(path).slice(0, 32)}.${randomUUID()}.part`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeFileSync(fd, data);
    fchmodSync(fd, finalMode);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    if (overwrite) renameSync(temp, path);
    else linkSync(temp, path); // atomic EEXIST, unlike existsSync() followed by writeFileSync()
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
}

export function readTextFileLimited(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`not a regular input file: ${path}`);
    if (st.size > maxBytes) throw new Error(`input exceeds ${maxBytes} byte limit: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      total += n;
      if (total > maxBytes) throw new Error(`input exceeds ${maxBytes} byte limit: ${path}`);
      chunks.push(chunk.subarray(0, n));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { closeSync(fd); }
}
