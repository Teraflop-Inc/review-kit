/**
 * The normalized event shape.
 *
 * This is the whole point of the intake boundary: everything downstream of
 * `intake.ts` (the MCP server, the notification payload, the model's view of
 * the world) is written against THIS type and never learns that GitHub exists.
 * Swapping in Linear or Jira means writing one new normalizer, not touching
 * the channel plumbing.
 */
export type EventKind = "review_comment" | "review" | "issue_comment" | "check_failed";

export interface Actor {
  /** Login/handle in the system of record. */
  id: string;
  /**
   * Bot-authored events are the classic infinite-loop source: our own reply
   * lands as a new webhook, which we'd push to the model, which replies again.
   * The intake tags it and the MCP server drops it by default.
   */
  is_bot: boolean;
}

export interface NormalizedEvent {
  /**
   * Idempotency key. Delivery is at-least-once and unordered, so this is the
   * only thing standing between a redelivered webhook and a duplicate
   * notification. Derived from the system-of-record object id, NOT from
   * arrival order or a local counter.
   */
  event_id: string;
  /** `owner/repo#number` — the thread this event belongs to. */
  correlation_key: string;
  actor: Actor;
  kind: EventKind;
  body: string;
  permalink: string;
  /** Intake's own receipt time. Ordering hint only — never an identity. */
  received_at: string;
  /** Monotonic intake sequence, used as the SSE cursor. Not an identity. */
  seq?: number;
  /** When the event happened in the system of record (comment created_at,
   *  review submitted_at). Used to reject stale deliveries. */
  occurred_at?: string;
  /** Numeric id of the source comment, so a reply to an inline review comment
   *  can land in its thread. Not an identity; `event_id` is. */
  comment_id?: number;
}

/** A reply the model asked us to publish, via the `post_reply` MCP tool. */
export interface Reply {
  correlation_key: string;
  body: string;
  /** The event this reply answers. Required: it is what makes "exactly one
   *  reply per event" enforceable, and it supplies the permalink to cite. */
  in_reply_to: string;
  /** The session that posted it. */
  session?: string;
  posted_at: string;
  /** How it was delivered: `github` if the API accepted it, else `file`. */
  delivery: "github" | "file";
  detail?: string;
}
