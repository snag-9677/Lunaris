/**
 * Time-ordered UUIDv7 generation (RFC 9562) with no external deps.
 *
 * Layout: 48-bit unix ms timestamp | ver(4)=7 | 12-bit monotonic counter |
 * var(2)=10 | 62 bits random. The 12-bit rand_a field is used as a counter
 * (seeded randomly each new millisecond, with headroom) so that ids minted
 * within the same millisecond in this process are still strictly ordered.
 */
import { randomBytes } from 'node:crypto';

let lastMs = -1;
let seq = 0; // 12-bit counter within a millisecond

export function uuidv7(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    // Same (or rewound) millisecond: bump the counter to stay monotonic.
    ms = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) {
      // Counter overflow: borrow the next millisecond.
      ms = lastMs + 1;
    }
  } else {
    // New millisecond: seed counter randomly but keep the top bit clear
    // so we have at least 2048 increments of headroom.
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  lastMs = ms;

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(ms, 0, 6); // 48-bit timestamp
  bytes.writeUInt8(0x70 | ((seq >> 8) & 0x0f), 6); // version 7 + seq high
  bytes.writeUInt8(seq & 0xff, 7); // seq low
  randomBytes(8).copy(bytes, 8);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // variant 10

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mint an id for an LLM call (CallMeta.callId). */
export function newCallId(): string {
  return uuidv7();
}

/** Mint an id for a goal (Goal.goalId). */
export function newGoalId(): string {
  return uuidv7();
}
