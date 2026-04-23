import { InputError } from '../common/errors.js';
import type { NvsEntryDef } from './writer.js';

/**
 * Parse an ESP-IDF NVS CSV (`key,type,encoding,value` header) into a list of
 * logical entries ready for {@link generate}. File-type rows are passed
 * through with `value` as the raw path; callers must pre-load the file bytes.
 */
export function parseCSV(
  csv: string,
  opts: { fileLoader?: (path: string) => Uint8Array } = {},
): NvsEntryDef[] {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  const expected = ['key', 'type', 'encoding', 'value'];
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) {
      throw new InputError(
        `expected CSV header '${expected.join(',')}' but got '${rows[0]!.join(',')}'`,
      );
    }
  }

  const entries: NvsEntryDef[] = [];
  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!;
    if (row.length === 0 || (row.length === 1 && row[0]!.trim() === '')) continue;
    if (row[0]!.startsWith('#')) continue;
    if (row.length < 4) {
      throw new InputError(`CSV row ${rowIdx + 1}: expected 4 columns, got ${row.length}`);
    }
    const [key, datatype, encoding, value] = row as [string, string, string, string];

    if (datatype === 'namespace') {
      entries.push({ type: 'namespace', key });
      continue;
    }

    const enc = encoding.toLowerCase();
    if (['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64'].includes(enc)) {
      entries.push({ type: enc as NvsEntryDef['type'], key, value } as NvsEntryDef);
      continue;
    }
    if (enc === 'string') {
      entries.push({ type: 'string', key, value });
      continue;
    }
    if (enc === 'binary') {
      if (datatype === 'file') {
        if (!opts.fileLoader) {
          throw new InputError(
            `CSV row ${rowIdx + 1}: file entry '${key}' requires a fileLoader callback`,
          );
        }
        entries.push({ type: 'binary', key, value: opts.fileLoader(value), encoding: 'raw' });
      } else {
        // raw ASCII value interpreted as bytes.
        entries.push({ type: 'binary', key, value, encoding: 'raw' });
      }
      continue;
    }
    if (enc === 'hex2bin') {
      entries.push({ type: 'binary', key, value, encoding: 'hex2bin' });
      continue;
    }
    if (enc === 'base64') {
      entries.push({ type: 'binary', key, value, encoding: 'base64' });
      continue;
    }
    throw new InputError(`CSV row ${rowIdx + 1}: unsupported encoding '${encoding}'`);
  }
  return entries;
}

function parseCsvRows(csv: string): string[][] {
  // Minimal CSV parser matching ESP-IDF's simple comma-separated format.
  // Supports double-quote fields with "" escape; no multiline fields.
  const rows: string[][] = [];
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    if (line === '') continue;
    rows.push(parseCsvLine(line));
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i >= line.length) {
      out.push('');
      break;
    }
    if (line[i] === '"') {
      let val = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          val += line[i];
          i++;
        }
      }
      out.push(val);
      if (line[i] === ',') i++;
      else break;
    } else {
      let val = '';
      while (i < line.length && line[i] !== ',') {
        val += line[i];
        i++;
      }
      out.push(val);
      if (line[i] === ',') i++;
      else break;
    }
  }
  return out;
}
