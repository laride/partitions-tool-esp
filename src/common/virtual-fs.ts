export interface VirtualFile {
  kind: 'file';
  name: string;
  content: Uint8Array;
  mtime?: Date;
}

export interface VirtualDirectory {
  kind: 'dir';
  name: string;
  children: VirtualNode[];
  mtime?: Date;
}

export type VirtualNode = VirtualFile | VirtualDirectory;

export function createDir(name: string, children: VirtualNode[] = []): VirtualDirectory {
  return { kind: 'dir', name, children };
}

export function createFile(name: string, content: Uint8Array): VirtualFile {
  return { kind: 'file', name, content };
}

/**
 * Walk a directory tree in pre-order, yielding `[path, node]` pairs where
 * `path` is a POSIX-style relative path (e.g. `dir/sub/file.txt`). The root
 * directory itself is NOT yielded.
 */
export function* walk(dir: VirtualDirectory, prefix = ''): Generator<[string, VirtualNode]> {
  for (const child of dir.children) {
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    yield [path, child];
    if (child.kind === 'dir') {
      yield* walk(child, path);
    }
  }
}

export function flattenFiles(dir: VirtualDirectory): Array<{ path: string; file: VirtualFile }> {
  const out: Array<{ path: string; file: VirtualFile }> = [];
  for (const [path, node] of walk(dir)) {
    if (node.kind === 'file') out.push({ path, file: node });
  }
  return out;
}
