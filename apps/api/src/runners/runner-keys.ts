import { createPublicKey, verify } from 'node:crypto';
import type { RunnerPublicKeys } from '@coffe/protocol';
import { blake2b } from '@noble/hashes/blake2.js';

/** DER prefix that turns a raw 32-byte Ed25519 public key into a SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeKeyMaterial(value: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === length ? bytes : null;
}

export type RunnerKeyCheck =
  | { ok: true; signPublicKey: Buffer }
  | { ok: false; reason: string };

/**
 * Verifies `box_key_signature`: an Ed25519 signature by `sign_public_key` over the raw bytes of
 * `box_public_key` (architecture §14.1).
 */
export function checkRunnerKeys(keys: RunnerPublicKeys): RunnerKeyCheck {
  const signPublicKey = decodeKeyMaterial(keys.sign_public_key, 32);
  const boxPublicKey = decodeKeyMaterial(keys.box_public_key, 32);
  const signature = decodeKeyMaterial(keys.box_key_signature, 64);
  if (!signPublicKey || !boxPublicKey || !signature) {
    return { ok: false, reason: 'keys must be base64 (32-byte public keys, 64-byte signature)' };
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, signPublicKey]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, boxPublicKey, publicKey, signature)) {
    return { ok: false, reason: 'box_key_signature does not match sign_public_key' };
  }
  return { ok: true, signPublicKey };
}

/**
 * Fingerprint shown at pairing (architecture §14.2): RFC 4648 base32 (no padding) of the
 * BLAKE2b-160 digest of the signing key, as 8 groups of 4 characters.
 */
export function runnerFingerprint(signPublicKey: Uint8Array): string {
  const digest = blake2b(signPublicKey, { dkLen: 20 });
  let encoded = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32_ALPHABET.charAt((buffer >>> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return (encoded.match(/.{4}/g) ?? []).join(' ');
}
