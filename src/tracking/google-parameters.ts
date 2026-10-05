function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function exactUtf16Bytes(value: string) {
  const bytes = new Uint8Array(1 + value.length * 2);
  bytes[0] = 0xff;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[1 + index * 2] = code >> 8;
    bytes[2 + index * 2] = code & 0xff;
  }
  return bytes;
}

export async function googleCustomParameterName(key: string) {
  if (/^[A-Za-z0-9_]{1,33}$/.test(key)) return `ages_c_${key}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    hasUnpairedSurrogate(key)
      ? exactUtf16Bytes(key)
      : new TextEncoder().encode(key),
  );
  return `ages_h_${toHex(new Uint8Array(digest)).slice(0, 32)}`;
}
