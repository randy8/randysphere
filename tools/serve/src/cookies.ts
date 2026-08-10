const SESSION_COOKIE = 'private_session';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name === SESSION_COOKIE) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/**
 * `Secure` is unconditional, not toggled by an env var or a "trust this
 * header" guess — the private area is only ever meant to be reached over
 * HTTPS (e.g. `tailscale serve https`), and a cookie that would also ride
 * along over plain HTTP is exactly the mistake to not leave a knob for.
 */
export function setSessionCookie(token: string): string {
  return `private_session=${encodeURIComponent(token)}; Path=/private; Max-Age=${String(MAX_AGE_SECONDS)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `private_session=; Path=/private; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
