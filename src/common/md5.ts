import { md5 as nobleMd5 } from '@noble/hashes/legacy';

export function md5(data: Uint8Array): Uint8Array {
  return nobleMd5(data);
}
