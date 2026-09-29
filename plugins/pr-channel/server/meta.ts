/**
 * meta.ts — the hyphen trap, isolated so it can be tested.
 *
 * `meta` on a channel notification becomes attributes on the `<channel>` tag
 * the model sees. The attribute-key grammar is [A-Za-z0-9_] only, and a key
 * that violates it is dropped SILENTLY — no error, no warning, the attribute
 * simply is not on the tag. `pr-number` looks perfectly correct in the server
 * and is invisible to the model.
 *
 * We cannot make claude warn about it, so we warn on our own stderr and keep a
 * unit test on the rule (tests/meta.test.ts).
 */
export const META_KEY_RE = /^[A-Za-z0-9_]+$/;

export interface SanitizeResult {
  meta: Record<string, string>;
  dropped: string[];
}

export function sanitizeMetaVerbose(meta: Record<string, unknown>): SanitizeResult {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (!META_KEY_RE.test(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = String(v);
  }
  return { meta: out, dropped };
}
