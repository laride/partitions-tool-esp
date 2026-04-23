import type { VirtualDirectory, VirtualNode } from '../common/virtual-fs.js';
import { createDir, createFile } from '../common/virtual-fs.js';

/**
 * Convert a browser {@link FileList} (as produced by an `<input type="file" webkitdirectory>`
 * element) into a {@link VirtualDirectory} tree. Uses `File.webkitRelativePath` when
 * available; otherwise treats the list as a flat directory.
 */
export async function fromFileList(files: FileList, rootName = 'root'): Promise<VirtualDirectory> {
  const root = createDir(rootName);
  for (let i = 0; i < files.length; i++) {
    const file = files.item(i);
    if (!file) continue;
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = rel.split('/');
    const baseIdx = parts[0] === rootName ? 1 : 0;
    let current: VirtualDirectory = root;
    for (let j = baseIdx; j < parts.length - 1; j++) {
      const part = parts[j]!;
      let next = current.children.find(
        (c): c is VirtualDirectory => c.kind === 'dir' && c.name === part,
      );
      if (!next) {
        next = createDir(part);
        current.children.push(next);
      }
      current = next;
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const vf = createFile(parts[parts.length - 1]!, buf);
    vf.mtime = new Date(file.lastModified);
    current.children.push(vf);
  }
  return root;
}

/**
 * Read a {@link FileSystemDirectoryHandle} (obtained from the browser's
 * `showDirectoryPicker()`) into a {@link VirtualDirectory}.
 */
export async function fromDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<VirtualDirectory> {
  const children: VirtualNode[] = [];
  for await (const [name, child] of handle.entries()) {
    if (child.kind === 'file') {
      const fileHandle = child as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      const vf = createFile(name, new Uint8Array(await file.arrayBuffer()));
      vf.mtime = new Date(file.lastModified);
      children.push(vf);
    } else if (child.kind === 'directory') {
      children.push(await fromDirectoryHandle(child as FileSystemDirectoryHandle));
    }
  }
  return createDir(handle.name, children);
}
