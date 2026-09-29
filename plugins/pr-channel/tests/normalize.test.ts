/**
 * Boundary normalization: GitHub payload -> NormalizedEvent.
 *
 *   bun test tests/
 */
import { expect, test } from "bun:test";
import { normalizeGitHub } from "../server/normalize.ts";

const repository = { full_name: "Teraflop-Inc/claude-github-channel" };

function reviewComment(over: any = {}) {
  return {
    action: "created",
    comment: {
      id: 12345,
      body: "the retry loop needs a backoff",
      user: { login: "aowen14", type: "User" },
      html_url: "https://github.com/x/y/pull/1#discussion_r12345",
      ...over.comment,
    },
    pull_request: { number: 1 },
    repository,
    ...over,
  };
}

test("review comment normalizes to the documented shape", () => {
  const ev = normalizeGitHub("pull_request_review_comment", reviewComment()) as any;
  expect(ev.kind).toBe("review_comment");
  expect(ev.correlation_key).toBe("Teraflop-Inc/claude-github-channel#1");
  expect(ev.event_id).toBe(
    "Teraflop-Inc/claude-github-channel:review_comment:12345",
  );
  expect(ev.actor).toEqual({ id: "aowen14", is_bot: false });
  expect(ev.body).toBe("the retry loop needs a backoff");
});

test("event_id is stable across redelivery", () => {
  // Delivery is at-least-once: the same logical comment arriving twice (with a
  // different X-GitHub-Delivery, which we deliberately ignore) must produce the
  // same event_id, or dedupe cannot work.
  const a = normalizeGitHub("pull_request_review_comment", reviewComment()) as any;
  const b = normalizeGitHub("pull_request_review_comment", reviewComment()) as any;
  expect(a.event_id).toBe(b.event_id);
});

test("distinct comments produce distinct event_ids", () => {
  const a = normalizeGitHub("pull_request_review_comment", reviewComment()) as any;
  const b = normalizeGitHub(
    "pull_request_review_comment",
    reviewComment({ comment: { id: 999, body: "other" } }),
  ) as any;
  expect(a.event_id).not.toBe(b.event_id);
});

test("bots are flagged, by type and by login suffix", () => {
  const byType = normalizeGitHub(
    "pull_request_review_comment",
    reviewComment({ comment: { user: { login: "ci", type: "Bot" } } }),
  ) as any;
  expect(byType.actor.is_bot).toBe(true);

  const bySuffix = normalizeGitHub(
    "pull_request_review_comment",
    reviewComment({ comment: { user: { login: "dependabot[bot]", type: "User" } } }),
  ) as any;
  expect(bySuffix.actor.is_bot).toBe(true);
});

test("PR conversation comments carry the PR number", () => {
  const ev = normalizeGitHub("issue_comment", {
    action: "created",
    comment: { id: 77, body: "ping", user: { login: "a", type: "User" }, created_at: "2026-09-28T00:00:00Z" },
    issue: { number: 42, pull_request: { url: "https://api.github.com/x" } },
    repository,
  }) as any;
  expect(ev.kind).toBe("issue_comment");
  expect(ev.correlation_key).toBe("Teraflop-Inc/claude-github-channel#42");
  expect(ev.occurred_at).toBe("2026-09-28T00:00:00Z");
  expect(ev.comment_id).toBe(77);
});

test("comments on plain issues (not PRs) are skipped", () => {
  const out = normalizeGitHub("issue_comment", {
    action: "created",
    comment: { id: 78, body: "ping", user: { login: "a", type: "User" } },
    issue: { number: 43 },
    repository,
  });
  expect(out).toHaveProperty("skip");
});

test("a submitted review with a summary becomes a review event", () => {
  const review = (body: string | null, action = "submitted") => ({
    action,
    review: {
      id: 900,
      body,
      state: "changes_requested",
      html_url: "https://github.com/x/y/pull/1#pullrequestreview-900",
      user: { login: "rev", type: "User" },
      submitted_at: "2026-09-28T00:00:00Z",
    },
    pull_request: { number: 1 },
    repository,
  });
  const ev = normalizeGitHub("pull_request_review", review("please add tests")) as any;
  expect(ev.kind).toBe("review");
  expect(ev.event_id).toBe("Teraflop-Inc/claude-github-channel:review:900");
  expect(ev.permalink).toContain("pullrequestreview-900");
  // An approve with no summary has nothing to say; its inline comments arrive
  // as their own pull_request_review_comment events.
  expect(normalizeGitHub("pull_request_review", review(null))).toHaveProperty("skip");
  expect(normalizeGitHub("pull_request_review", review("x", "dismissed"))).toHaveProperty("skip");
});

test("a failed check becomes check_failed; a successful one is skipped", () => {
  const base = (conclusion: string) => ({
    action: "completed",
    check_run: {
      id: 5,
      name: "unit-tests",
      conclusion,
      pull_requests: [{ number: 3 }],
      output: { summary: "3 assertions failed" },
    },
    repository,
    sender: { login: "github-actions[bot]", type: "Bot" },
  });

  const failed = normalizeGitHub("check_run", base("failure")) as any;
  expect(failed.kind).toBe("check_failed");
  expect(failed.body).toContain("unit-tests");
  expect(failed.body).toContain("3 assertions failed");

  // Green checks must not wake the model up.
  expect(normalizeGitHub("check_run", base("success"))).toHaveProperty("skip");
});

test("non-created actions and unknown events are skipped, not crashed on", () => {
  expect(
    normalizeGitHub("pull_request_review_comment", reviewComment({ action: "edited" })),
  ).toHaveProperty("skip");
  expect(normalizeGitHub("push", { repository })).toHaveProperty("skip");
  expect(normalizeGitHub("pull_request_review_comment", {})).toHaveProperty("skip");
});
