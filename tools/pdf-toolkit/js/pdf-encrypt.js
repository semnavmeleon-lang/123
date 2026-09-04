// pdf-lib has no encryption support, so this walks its low-level PDFContext,
// RC4-encrypts every string/stream on each pre-existing indirect object, then
// adds a fresh /Encrypt dict + /ID before the caller calls
// `pdfDoc.save({ useObjectStreams: false })` — object streams must stay off so
// every object keeps its own number for the per-object key (Algorithm 3.1).
function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function encryptValueRecursive(value, objKey, visited) {
  const { PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFRef } = PDFLib;

  if (value instanceof PDFRef) return; // separate indirect object, handled on its own

  if (value instanceof PDFRawStream) {
    encryptValueRecursive(value.dict, objKey, visited);
    value.contents = RC4Crypto.rc4(objKey, value.contents);
    return;
  }

  if (value instanceof PDFDict) {
    if (visited.has(value)) return;
    visited.add(value);
    for (const [key, v] of value.entries()) {
      if (v instanceof PDFString || v instanceof PDFHexString) {
        const encrypted = RC4Crypto.rc4(objKey, v.asBytes());
        value.set(key, PDFHexString.of(bytesToHex(encrypted)));
      } else if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFRawStream) {
        encryptValueRecursive(v, objKey, visited);
      }
    }
    return;
  }

  if (value instanceof PDFArray) {
    if (visited.has(value)) return;
    visited.add(value);
    for (let i = 0; i < value.size(); i++) {
      const v = value.get(i);
      if (v instanceof PDFString || v instanceof PDFHexString) {
        const encrypted = RC4Crypto.rc4(objKey, v.asBytes());
        value.set(i, PDFHexString.of(bytesToHex(encrypted)));
      } else if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFRawStream) {
        encryptValueRecursive(v, objKey, visited);
      }
    }
    return;
  }
}

function getOrCreateFileId(context) {
  const { PDFArray, PDFHexString } = PDFLib;
  const existing = context.trailerInfo.ID;
  if (existing instanceof PDFArray && existing.size() > 0) {
    const first = existing.get(0);
    if (first instanceof PDFHexString || first instanceof PDFLib.PDFString) {
      return first.asBytes();
    }
  }
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const hex = bytesToHex(randomBytes);
  const idArray = PDFArray.withContext(context);
  idArray.push(PDFHexString.of(hex));
  idArray.push(PDFHexString.of(hex));
  context.trailerInfo.ID = idArray;
  return randomBytes;
}

function encryptPdfDocument(pdfDoc, opts) {
  const context = pdfDoc.context;
  const { PDFName } = PDFLib;
  const keyLengthBytes = 16; // 128-bit
  const revision = 3;

  const idBytes = getOrCreateFileId(context);
  const pValue = RC4Crypto.permissionsToP(opts.permissions || {});
  const pBytes = RC4Crypto.int32ToBytesLE(pValue);

  const paddedUser = RC4Crypto.padPassword(RC4Crypto.passwordToBytes(opts.userPassword || ""));
  const ownerSource = opts.ownerPassword && opts.ownerPassword.length > 0 ? opts.ownerPassword : opts.userPassword || "";
  const paddedOwner = RC4Crypto.padPassword(RC4Crypto.passwordToBytes(ownerSource));

  const O = RC4Crypto.computeOwnerEntry({
    paddedOwnerPassword: paddedOwner,
    paddedUserPassword: paddedUser,
    keyLengthBytes,
    revision,
  });
  const fileKey = RC4Crypto.computeEncryptionKey({
    paddedUserPassword: paddedUser,
    O,
    pBytes,
    idBytes,
    keyLengthBytes,
    revision,
  });
  const U = RC4Crypto.computeUserEntry({ encryptionKey: fileKey, idBytes, revision });

  // Encrypt every EXISTING indirect object before the /Encrypt dict exists.
  const indirectObjects = context.enumerateIndirectObjects();
  for (const [ref, obj] of indirectObjects) {
    const objKey = RC4Crypto.computeObjectKey(fileKey, ref.objectNumber, ref.generationNumber);
    if (obj instanceof PDFLib.PDFString || obj instanceof PDFLib.PDFHexString) {
      const encrypted = RC4Crypto.rc4(objKey, obj.asBytes());
      context.assign(ref, PDFLib.PDFHexString.of(bytesToHex(encrypted)));
    } else {
      encryptValueRecursive(obj, objKey, new Set());
    }
  }

  const encryptDict = context.obj({
    Filter: PDFName.of("Standard"),
    V: 2,
    R: revision,
    O: PDFLib.PDFHexString.of(bytesToHex(O)),
    U: PDFLib.PDFHexString.of(bytesToHex(U)),
    P: pValue,
    Length: keyLengthBytes * 8,
  });
  const encryptRef = context.register(encryptDict);
  context.trailerInfo.Encrypt = encryptRef;
}
