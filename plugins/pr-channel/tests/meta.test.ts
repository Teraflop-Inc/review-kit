/**
 * The hyphen-in-meta trap.
 *
 * This is a regression test for a failure with no error message: claude drops a
 * meta key that is not [A-Za-z0-9_]+ silently, so the attribute is just absent
 * from the <channel> tag. The only defence is to never emit such a key, so the
 * rule is pinned here.
 *
 *   bun test tests/
 */
import { expect, test } from "bun:test";
import { sanitizeMetaVerbose, META_KEY_RE } from "../server/meta.ts";

test("hyphenated keys are dropped and reported", () => {
  const { meta, dropped } = sanitizeMetaVerbose({
    "pr-number": 7,
    pr_number: 7,
  });
  // The whole point: `pr-number` cannot survive, and we must KNOW it was lost.
  expect(dropped).toEqual(["pr-number"]);
  expect(meta).toEqual({ pr_number: "7" });
});

test("the meta keys the server actually emits are all legal", () => {
  // If someone renames one of these to kebab-case, this fails here rather than
  // silently vanishing from the model's view of the event.
  for (const k of [
    "event_id",
    "correlation_key",
    "kind",
    "actor",
    "actor_is_bot",
    "permalink",
  ]) {
    expect(META_KEY_RE.test(k)).toBe(true);
  }
});

test("other illegal key shapes are also rejected", () => {
  const { dropped } = sanitizeMetaVerbose({
    "with space": 1,
    "with.dot": 1,
    "with:colon": 1,
    "": 1,
    ok_1: 1,
  });
  expect(dropped.sort()).toEqual(["", "with space", "with.dot", "with:colon"]);
});

test("values are stringified, since attributes are text", () => {
  const { meta } = sanitizeMetaVerbose({ actor_is_bot: false, n: 0 });
  expect(meta).toEqual({ actor_is_bot: "false", n: "0" });
});
