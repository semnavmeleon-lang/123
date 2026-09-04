// PDF Standard Security Handler (RC4, /V 2 /R 3) — MD5 + RC4 + key derivation per ISO 32000-1 7.6.
const RC4Crypto = (function () {
  const MD5_K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  function rotl32(x, c) {
    return (x << c) | (x >>> (32 - c));
  }

  function md5(bytes) {
    const bitLen = bytes.length * 8;
    const paddedLen = (((bytes.length + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(paddedLen);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
    dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    for (let chunk = 0; chunk < paddedLen; chunk += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(chunk + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl32(F, MD5_S[i])) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, a0 >>> 0, true);
    odv.setUint32(4, b0 >>> 0, true);
    odv.setUint32(8, c0 >>> 0, true);
    odv.setUint32(12, d0 >>> 0, true);
    return out;
  }

  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xff;
      const tmp = S[i];
      S[i] = S[j];
      S[j] = tmp;
    }
    const out = new Uint8Array(data.length);
    let i = 0;
    j = 0;
    for (let n = 0; n < data.length; n++) {
      i = (i + 1) & 0xff;
      j = (j + S[i]) & 0xff;
      const tmp = S[i];
      S[i] = S[j];
      S[j] = tmp;
      out[n] = data[n] ^ S[(S[i] + S[j]) & 0xff];
    }
    return out;
  }

  const PADDING = new Uint8Array([
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
    0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
    0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
    0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
  ]);

  function concatBytes(arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrays) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }

  function padPassword(passwordBytes) {
    if (passwordBytes.length >= 32) return passwordBytes.slice(0, 32);
    return concatBytes([passwordBytes, PADDING.slice(0, 32 - passwordBytes.length)]);
  }

  function passwordToBytes(str) {
    return new TextEncoder().encode(str || "");
  }

  function permissionsToP({ print = true, copy = true, modify = false } = {}) {
    let base = 0xfffff0c0 | 0; // bits 1,2 = 0; bits 7,8 = 1; all others default-allow(1)
    // clear all optional bits first, then set the ones we grant
    base &= ~(4 | 2048 | 16 | 512 | 8 | 32 | 256 | 1024);
    if (print) base |= 4 | 2048;
    if (copy) base |= 16 | 512;
    if (modify) base |= 8 | 32 | 256 | 1024;
    return base | 0;
  }

  function int32ToBytesLE(n) {
    const b = new Uint8Array(4);
    b[0] = n & 0xff;
    b[1] = (n >> 8) & 0xff;
    b[2] = (n >> 16) & 0xff;
    b[3] = (n >> 24) & 0xff;
    return b;
  }

  function computeEncryptionKey({ paddedUserPassword, O, pBytes, idBytes, keyLengthBytes, revision }) {
    let hash = md5(concatBytes([paddedUserPassword, O, pBytes, idBytes]));
    if (revision >= 3) {
      for (let i = 0; i < 50; i++) hash = md5(hash.slice(0, keyLengthBytes));
    }
    return hash.slice(0, keyLengthBytes);
  }

  function computeOwnerEntry({ paddedOwnerPassword, paddedUserPassword, keyLengthBytes, revision }) {
    let hash = md5(paddedOwnerPassword);
    if (revision >= 3) {
      for (let i = 0; i < 50; i++) hash = md5(hash);
    }
    const rc4Key = hash.slice(0, keyLengthBytes);
    let encrypted = rc4(rc4Key, paddedUserPassword);
    if (revision >= 3) {
      for (let i = 1; i <= 19; i++) {
        const roundKey = rc4Key.map((b) => b ^ i);
        encrypted = rc4(roundKey, encrypted);
      }
    }
    return encrypted;
  }

  function computeUserEntry({ encryptionKey, idBytes, revision }) {
    if (revision === 2) {
      return rc4(encryptionKey, PADDING);
    }
    let hash = md5(concatBytes([PADDING, idBytes]));
    let encrypted = rc4(encryptionKey, hash);
    for (let i = 1; i <= 19; i++) {
      const roundKey = encryptionKey.map((b) => b ^ i);
      encrypted = rc4(roundKey, encrypted);
    }
    const result = new Uint8Array(32);
    result.set(encrypted, 0);
    return result;
  }

  function computeObjectKey(fileKey, objNum, genNum) {
    const extra = new Uint8Array([
      objNum & 0xff,
      (objNum >> 8) & 0xff,
      (objNum >> 16) & 0xff,
      genNum & 0xff,
      (genNum >> 8) & 0xff,
    ]);
    const hash = md5(concatBytes([fileKey, extra]));
    const n = Math.min(fileKey.length + 5, 16);
    return hash.slice(0, n);
  }

  return {
    md5,
    rc4,
    PADDING,
    concatBytes,
    padPassword,
    passwordToBytes,
    permissionsToP,
    int32ToBytesLE,
    computeEncryptionKey,
    computeOwnerEntry,
    computeUserEntry,
    computeObjectKey,
  };
})();
