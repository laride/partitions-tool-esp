import { InputError } from '../common/errors.js';
import { NvsEntryDef } from './writer.js';

/** Width of an integral NVS value. */
export type NvsIntType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64';
export type NvsFloatType = 'float' | 'double';

/**
 * Short-hand value description for {@link NvsObject}. The shape determines
 * how the value is stored:
 *
 * - `number`: always encoded as `i32` / `u32` based on sign.
 * - `bigint`: always encoded as `i64` / `u64` based on sign.
 * - `string`: stored as NVS `string`.
 * - `Uint8Array`: stored as NVS `binary`.
 * - `{ type, value }` object: explicit primitive/string/binary entry.
 */
export type NvsValue =
  | number
  | bigint
  | string
  | Uint8Array
  | { type: NvsIntType; value: number | bigint | string }
  | { type: NvsFloatType; value: number | string }
  | { type: 'string'; value: string }
  | { type: 'binary'; value: Uint8Array | string; encoding?: 'raw' | 'hex2bin' | 'base64' };

/**
 * Structured representation of an NVS partition:
 * `{ [namespace]: { [key]: value } }`.
 *
 * Iteration order is preserved: namespaces in insertion order, keys in
 * insertion order. Use a `Map` for namespace when strict order matters across
 * serialization boundaries.
 */
export type NvsObject =
  | Record<string, Record<string, NvsValue>>
  | Map<string, Map<string, NvsValue> | Record<string, NvsValue>>;

/**
 * Translate an {@link NvsObject} (plain object or `Map`) into the linear
 * `NvsEntryDef[]` consumed by {@link generate}. Namespaces are emitted as
 * dedicated namespace entries; each key/value inherits the most recent one.
 */
export function fromObject(obj: NvsObject): NvsEntryDef[] {
  const out: NvsEntryDef[] = [];
  const namespaces = obj instanceof Map ? obj : new Map(Object.entries(obj));
  for (const [ns, entries] of namespaces) {
    if (typeof ns !== 'string' || ns.length === 0) {
      throw new InputError(`invalid NVS namespace '${String(ns)}'`);
    }
    out.push({ type: 'namespace', key: ns });
    const iter = entries instanceof Map ? entries : new Map(Object.entries(entries));
    for (const [key, value] of iter) {
      out.push(...valueToEntry(key, value));
    }
  }
  return out;
}

function valueToEntry(key: string, value: NvsValue): NvsEntryDef[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new InputError(
        `key '${key}': non-integer number ${value}; use bigint or an explicit type`,
      );
    }
    const type: NvsIntType = value < 0 ? 'i32' : 'u32';
    return [{ type, key, value }];
  }
  if (typeof value === 'bigint') {
    const type: NvsIntType = value < 0n ? 'i64' : 'u64';
    return [{ type, key, value }];
  }
  if (typeof value === 'string') {
    return [{ type: 'string', key, value }];
  }
  if (value instanceof Uint8Array) {
    return [{ type: 'binary', key, value }];
  }
  if (value && typeof value === 'object' && 'type' in value) {
    switch (value.type) {
      case 'string':
        return [{ type: 'string', key, value: value.value }];
      case 'binary':
        return [
          {
            type: 'binary',
            key,
            value: value.value,
            encoding: value.encoding ?? 'raw',
          },
        ];
      case 'u8':
      case 'i8':
      case 'u16':
      case 'i16':
      case 'u32':
      case 'i32':
      case 'u64':
      case 'i64':
        return [{ type: value.type, key, value: value.value }];
      case 'float':
      case 'double':
        return [{ type: value.type, key, value: value.value }];
      default:
        throw new InputError(`unknown NVS value type for key '${key}'`);
    }
  }
  throw new InputError(`unsupported NVS value for key '${key}'`);
}

/**
 * Fluent builder for NVS entries.
 *
 * @example
 * ```ts
 * const entries = new NvsBuilder()
 *   .namespace('storage')
 *   .string('greeting', 'hello world')
 *   .u32('counter', 42)
 *   .binary('blob', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
 *   .namespace('settings')
 *   .u8('flag', 1)
 *   .build();
 *
 * const bin = generate(entries, { size: 0x6000 });
 * ```
 */
export class NvsBuilder {
  private readonly entries: NvsEntryDef[] = [];
  private activeNamespace: string | null = null;

  namespace(name: string): this {
    if (!name) throw new InputError('namespace name cannot be empty');
    this.entries.push({ type: 'namespace', key: name });
    this.activeNamespace = name;
    return this;
  }

  private requireNs(): void {
    if (!this.activeNamespace) {
      throw new InputError('no active namespace; call builder.namespace(name) first');
    }
  }

  u8(key: string, value: number): this {
    return this.addInt('u8', key, value);
  }
  i8(key: string, value: number): this {
    return this.addInt('i8', key, value);
  }
  u16(key: string, value: number): this {
    return this.addInt('u16', key, value);
  }
  i16(key: string, value: number): this {
    return this.addInt('i16', key, value);
  }
  u32(key: string, value: number): this {
    return this.addInt('u32', key, value);
  }
  i32(key: string, value: number): this {
    return this.addInt('i32', key, value);
  }
  u64(key: string, value: number | bigint): this {
    return this.addInt('u64', key, value);
  }
  i64(key: string, value: number | bigint): this {
    return this.addInt('i64', key, value);
  }
  float(key: string, value: number): this {
    return this.addFloat('float', key, value);
  }
  double(key: string, value: number): this {
    return this.addFloat('double', key, value);
  }

  string(key: string, value: string): this {
    this.requireNs();
    this.entries.push({ type: 'string', key, value });
    return this;
  }

  binary(key: string, value: Uint8Array | string, encoding?: 'raw' | 'hex2bin' | 'base64'): this {
    this.requireNs();
    const entry: NvsEntryDef = { type: 'binary', key, value };
    if (encoding !== undefined) entry.encoding = encoding;
    this.entries.push(entry);
    return this;
  }

  /** Ingest a bulk value using the same inference rules as {@link fromObject}. */
  set(key: string, value: NvsValue): this {
    this.requireNs();
    this.entries.push(...valueToEntry(key, value));
    return this;
  }

  build(): NvsEntryDef[] {
    return [...this.entries];
  }

  private addInt(type: NvsIntType, key: string, value: number | bigint): this {
    this.requireNs();
    this.entries.push({ type, key, value });
    return this;
  }

  private addFloat(type: NvsFloatType, key: string, value: number): this {
    this.requireNs();
    this.entries.push({ type, key, value });
    return this;
  }
}
