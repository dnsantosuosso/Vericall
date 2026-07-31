// ---------------------------------------------------------------------------
// Layer 1 (Core) — Frame signer.
//
// Owns the local keypair, the monotonic counter, and the tamper switch. Given
// the raw bytes of a captured video frame (produced by a platform adapter), it
// returns a ready-to-send signed-frame message. All signing/tampering logic
// lives here so adapters never touch cryptography.
// ---------------------------------------------------------------------------

import { exportPublicKey, generateKeyPair, hashBytes, signPayload } from './crypto.js';
import type { SignedFrameMessage } from './types.js';

export type TamperMode = 'off' | 'bad-signature' | 'silent';

export class FrameSigner {
  private keyPair: CryptoKeyPair | null = null;
  private counter = 0;
  private tamper: TamperMode = 'off';

  /** Generate this session's in-memory keypair. Call once before signing. */
  async init(): Promise<JsonWebKey> {
    this.keyPair = await generateKeyPair();
    return this.exportPublicKey();
  }

  async exportPublicKey(): Promise<JsonWebKey> {
    if (!this.keyPair) throw new Error('FrameSigner not initialized');
    return exportPublicKey(this.keyPair.publicKey);
  }

  /**
   * Control the tamper demo:
   *   'off'           — sign honestly.
   *   'bad-signature' — send a real message with a corrupted signature.
   *   'silent'        — stop producing frames entirely (peer goes stale).
   */
  setTamperMode(mode: TamperMode): void {
    this.tamper = mode;
  }

  getTamperMode(): TamperMode {
    return this.tamper;
  }

  /**
   * Hash + sign a frame's bytes and return the wire message, or `null` when in
   * 'silent' tamper mode (nothing should be sent).
   */
  async signFrame(
    frameBytes: Uint8Array,
  ): Promise<Omit<SignedFrameMessage, 'type' | 'from'> | null> {
    if (!this.keyPair) throw new Error('FrameSigner not initialized');
    if (this.tamper === 'silent') return null;

    const counter = ++this.counter;
    const timestamp = Date.now();
    const hash = await hashBytes(frameBytes);
    let signature = await signPayload(this.keyPair.privateKey, { counter, timestamp, hash });

    if (this.tamper === 'bad-signature') {
      signature = corrupt(signature);
    }

    return { counter, timestamp, hash, signature };
  }
}

/** Flip a character in the base64 signature so verification will fail. */
function corrupt(sigB64: string): string {
  if (sigB64.length === 0) return 'AA==';
  const idx = Math.floor(sigB64.length / 2);
  const ch = sigB64[idx];
  const replacement = ch === 'A' ? 'B' : 'A';
  return sigB64.slice(0, idx) + replacement + sigB64.slice(idx + 1);
}
