import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VirtualDirectory, VirtualNode } from '../common/virtual-fs.js';
import { createDir, createFile } from '../common/virtual-fs.js';

/**
 * Recursively read a real filesystem directory into a {@link VirtualDirectory}.
 * Symbolic links are followed; all file contents are read into memory.
 */
export async function readDir(dirPath: string, name?: string): Promise<VirtualDirectory> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const children: VirtualNode[] = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      children.push(await readDir(full, entry.name));
    } else if (stat.isFile()) {
      const buf = await fs.readFile(full);
      const file = createFile(
        entry.name,
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      );
      file.mtime = stat.mtime;
      children.push(file);
    }
  }
  const dir = createDir(name ?? path.basename(dirPath), children);
  return dir;
}

/**
 * Recursively write a {@link VirtualDirectory} to the local filesystem, creating
 * the target directory if needed.
 */
export async function writeDir(root: VirtualDirectory, outDir: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  for (const child of root.children) {
    const target = path.join(outDir, child.name);
    if (child.kind === 'dir') {
      await writeDir(child, target);
    } else {
      await fs.writeFile(target, child.content);
      if (child.mtime) await fs.utimes(target, child.mtime, child.mtime);
    }
  }
}
