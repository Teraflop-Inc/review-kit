/**
 * normalize.ts — the boundary translation, isolated so it can be tested
 * without starting an HTTP server.
 *
 * GitHub webhook payload -> NormalizedEvent. Everything downstream of this
 * function is written against NormalizedEvent and never learns that GitHub
 * exists; adding Linear or Jira means adding a sibling of this file.
 */
import type { EventKind, NormalizedEvent } from "./types.ts";

export function isBot(user: any): boolean {
  const login = String(user?.login ?? "");
  return user?.type === "Bot" || login.endsWith("[bot]");
}

/**
 * `eventName` is the `X-GitHub-Event` header.
 *
 * `X-GitHub-Delivery` is deliberately NOT used for identity: GitHub issues a
 * fresh delivery id on every retry of the same logical event, so keying on it
 * would defeat deduplication exactly when dedupe matters (at-least-once
 * redelivery). We key on the underlying object id instead, which is stable
 * across retries.
 */
export function normalizeGitHub(
  eventName: string,
  payload: any,
): NormalizedEvent | { skip: string } {
  const repo = payload?.repository?.full_name;
  if (!repo) return { skip: "payload has no repository.full_name" };

  let kind: EventKind;
  let number: number | undefined;
  let body = "";
  let permalink = "";
  let objectId = "";
  let user: any;
  let occurredAt: string | undefined;
  let commentId: number | undefined;

  switch (eventName) {
    case "pull_request_review_comment": {
      if (payload.action !== "created")
        return { skip: `review_comment action=${payload.action}` };
      kind = "review_comment";
      number = payload?.pull_request?.number;
      body = payload?.comment?.body ?? "";
      permalink = payload?.comment?.html_url ?? "";
      objectId = `review_comment:${payload?.comment?.id}`;
      user = payload?.comment?.user;
      occurredAt = payload?.comment?.created_at;
      commentId = payload?.comment?.id;
      break;
    }
    case "pull_request_review": {
      // One per submitted review. Its inline comments arrive separately as
      // pull_request_review_comment, so only the summary body is carried here,
      // and an approve/comment with no summary has nothing to say.
      if (payload.action !== "submitted")
        return { skip: `review action=${payload.action}` };
      body = payload?.review?.body ?? "";
      if (!body.trim()) return { skip: "review has no summary body" };
      kind = "review";
      number = payload?.pull_request?.number;
      permalink = payload?.review?.html_url ?? "";
      objectId = `review:${payload?.review?.id}`;
      user = payload?.review?.user;
      occurredAt = payload?.review?.submitted_at;
      break;
    }
    case "issue_comment": {
      if (payload.action !== "created")
        return { skip: `issue_comment action=${payload.action}` };
      // issue_comment fires for plain issues too; only PR conversations count.
      if (!payload?.issue?.pull_request)
        return { skip: "issue_comment is not on a pull request" };
      kind = "issue_comment";
      number = payload?.issue?.number;
      body = payload?.comment?.body ?? "";
      permalink = payload?.comment?.html_url ?? "";
      objectId = `issue_comment:${payload?.comment?.id}`;
      user = payload?.comment?.user;
      occurredAt = payload?.comment?.created_at;
      commentId = payload?.comment?.id;
      break;
    }
    case "check_run": {
      const concl = payload?.check_run?.conclusion;
      if (payload.action !== "completed" || concl === "success")
        return { skip: `check_run action=${payload.action} conclusion=${concl}` };
      kind = "check_failed";
      // A check_run carries its PRs in an array; the thread is the first one.
      number = payload?.check_run?.pull_requests?.[0]?.number;
      const name = payload?.check_run?.name ?? "check";
      body = `Check \`${name}\` concluded \`${concl}\`.\n${
        payload?.check_run?.output?.summary ?? ""
      }`.trim();
      permalink = payload?.check_run?.html_url ?? "";
      objectId = `check_run:${payload?.check_run?.id}`;
      user = payload?.sender;
      occurredAt = payload?.check_run?.completed_at;
      break;
    }
    default:
      return { skip: `unsupported event ${eventName}` };
  }

  if (typeof number !== "number")
    return { skip: `${eventName} has no PR/issue number` };

  return {
    event_id: `${repo}:${objectId}`,
    correlation_key: `${repo}#${number}`,
    actor: { id: String(user?.login ?? "unknown"), is_bot: isBot(user) },
    kind,
    body,
    permalink,
    received_at: new Date().toISOString(),
    occurred_at: occurredAt,
    comment_id: commentId,
  };
}
