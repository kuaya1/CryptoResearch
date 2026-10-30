'use strict';
// Keccak-256 as Ethereum uses it (the original Keccak padding, 0x01 ... 0x80),
// in pure JavaScript with no package. Node's OpenSSL "sha3-256" is FIPS-202
// SHA-3 (padding 0x06) and gives different hashes, so code hashes, function
// selectors, event topics, ERC-1967 slots and CREATE2 addresses are all
// derived here. Pinned by tests against published vectors: "" →
// c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.
//
// Keccak-f[1600] on 25 lanes of 64 bits (BigInt). The round constants and the
// rotation offsets are generated from their definitions (the LFSR of the
// Keccak reference and the (t+1)(t+2)/2 rule), not typed in.

const M64 = (1n << 64n) - 1n;
const RATE = 136; // bytes, for a 256-bit output (capacity 512)

const RC = (() => {
  const bit = (t) => {
    if (t % 255 === 0) return 1;
    let r = 1;
    for (let i = 1; i <= t % 255; i++) {
      r <<= 1;
      if (r & 0x100) r ^= 0x171;
    }
    return r & 1;
  };
  const out = [];
  for (let round = 0; round < 24; round++) {
    let c = 0n;
    for (let j = 0; j <= 6; j++) if (bit(j + 7 * round)) c |= 1n << BigInt((1 << j) - 1);
    out.push(c);
  }
  return out;
})();

// ROT[x + 5y], the rho offsets.
const ROT = (() => {
  const r = new Array(25).fill(0);
  let x = 1;
  let y = 0;
  for (let t = 0; t < 24; t++) {
    r[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  return r.map(BigInt);
})();

const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & M64);

function permute(A) {
  const C = new Array(5);
  const B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & M64 & B[((x + 2) % 5) + y]);
    }
    A[0] ^= RC[round];
  }
}

// Bytes in: a Buffer/Uint8Array, a 0x-hex string (hexIn), or text (UTF-8).
function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  throw new TypeError('keccak256 takes bytes or text');
}

// The 32-byte digest, as a Buffer.
function keccak256Bytes(input) {
  const msg = bytesOf(input);
  const blocks = Math.floor(msg.length / RATE) + 1;
  const padded = new Uint8Array(blocks * RATE);
  padded.set(msg);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      const o = b * RATE + i * 8;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[o + k]);
      A[i] ^= lane;
    }
    permute(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

// The digest as 0x-prefixed lowercase hex.
function keccak256(input) {
  return `0x${keccak256Bytes(input).toString('hex')}`;
}

// The digest of hex-encoded bytes ("0x…").
function keccak256Hex(hex) {
  const h = String(hex || '').replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new TypeError('Not hex bytes');
  return keccak256(Buffer.from(h, 'hex'));
}

// A function's 4-byte selector from its canonical signature text.
const selector = (signature) => keccak256(signature).slice(0, 10);
// An event's topic 0 from its canonical signature text.
const topic = (signature) => keccak256(signature);
// keccak256(text) − 1, as a 32-byte slot (the ERC-1967 rule).
function slotMinusOne(text) {
  const v = BigInt(keccak256(text)) - 1n;
  return `0x${v.toString(16).padStart(64, '0')}`;
}

// A CREATE2 address: keccak256(0xff ‖ deployer ‖ salt ‖ init_code_hash)[12:].
function create2Address(deployer, salt, initCodeHash) {
  const strip = (h, n, what) => {
    const s = String(h || '').replace(/^0x/i, '').toLowerCase();
    if (s.length !== n || /[^0-9a-f]/.test(s)) throw new TypeError(`${what} is not ${n / 2} bytes of hex`);
    return s;
  };
  const buf = Buffer.from(`ff${strip(deployer, 40, 'The deployer')}${strip(salt, 64, 'The salt')}${strip(initCodeHash, 64, 'The init code hash')}`, 'hex');
  return `0x${keccak256Bytes(buf).subarray(12).toString('hex')}`;
}

module.exports = { keccak256, keccak256Bytes, keccak256Hex, selector, topic, slotMinusOne, create2Address };
