function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function googleCustomParameterName(key: string) {
  if (/^[A-Za-z0-9_]{1,33}$/.test(key)) return `ages_c_${key}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return `ages_h_${toHex(new Uint8Array(digest)).slice(0, 32)}`;
}
