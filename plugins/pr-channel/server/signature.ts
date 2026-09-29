/**
 * signature.ts: GitHub webhook authentication, isolated so it can be tested.
 *
 * GitHub signs the RAW request body with HMAC-SHA256 under the webhook secret
 * and sends `X-Hub-Signature-256: sha256=<hex>`. Verify against the bytes as
 * received: parsing and re-serializing the JSON first changes whitespace and
 * escaping, and a correct signature then fails for no visible reason.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function signGitHub(secret: string, rawBody: string | Uint8Array): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyGitHubSignature(
  secret: string,
  rawBody: string | Uint8Array,
  header: string | null | undefined,
): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const want = Buffer.from(signGitHub(secret, rawBody));
  const got = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch; a mismatch is simply "no".
  return want.length === got.length && timingSafeEqual(want, got);
}
