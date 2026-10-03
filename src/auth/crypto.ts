export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export async function hashToken(value: string): Promise<string> {
  return Array.from(await digest(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await digest(verifier));
}

export function isToken(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
}
