import type { ParseWarning, VirtualDirectory } from 'partitions-tool-esp';

export function downloadBinary(data: Uint8Array, filename: string): void {
  const bytes = new Uint8Array(data);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function collectFileNames(dir: VirtualDirectory, prefix = ''): string[] {
  const names: string[] = [];
  for (const child of dir.children) {
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.kind === 'file') {
      names.push(path);
    } else {
      names.push(...collectFileNames(child, path));
    }
  }
  return names;
}

export function toDownloadName(path: string): string {
  const normalized = path.replace(/^\/+/, '');
  return normalized.replace(/[\\/]/g, '__') || 'file.bin';
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function formatHex(n: number, width = 0): string {
  const hex = n.toString(16);
  return `0x${width > 0 ? hex.padStart(width, '0') : hex}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!normalized) return new Uint8Array();
  if (!/^[\da-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('Hex string must contain an even number of hexadecimal characters');
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function formatWarnings(warnings: ParseWarning[]): string[] {
  return warnings.map((warning) => warning.message);
}
