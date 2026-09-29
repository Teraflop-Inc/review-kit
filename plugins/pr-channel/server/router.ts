/**
 * router.ts: who gets an event, and who may answer it. Pure state, no I/O, so
 * the rules below are unit-tested rather than discovered on stage.
 *
 * The 9/23 demo broadcast every event to every connected session. Two shells
 * were open, both heard the comment, and both replied. The rules here:
 *
 *   1. A session only hears PRs it subscribed to (`owner/repo#N`). Everything
 *      else is dropped at the intake and never reaches a session.
 *   2. Among the sessions subscribed to a PR, exactly ONE owns each event: the
 *      longest-standing subscriber that is still connected. If it goes away,
 *      the next one takes over. Other subscribers are standbys, not listeners.
 *   3. An event is accepted once, keyed on the system-of-record object id
 *      (stable across GitHub retries) and on the delivery id.
 *   4. An event can be replied to once, and only by the session that owns it.
 *
 * Rule 4 is the backstop for rule 2: even if two sessions somehow both saw an
 * event, the second post_reply is refused before it reaches GitHub.
 */
import type { NormalizedEvent } from "./types.ts";

/** `owner/repo#N`, case-insensitively, since GitHub's own casing is canonical
 *  but a human typing a subscription is not. Returns null if it is not a key. */
export function canonicalKey(key: string): string | null {
  const m = /^\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\s*$/.exec(key ?? "");
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null;
}

type Session = {
  id: string;
  connected: boolean;
  /** When the session last disconnected; it keeps its subscriptions for a
   *  grace period so an MCP-server restart does not reshuffle ownership. */
  disconnectedAt?: number;
};

export type RouteResult =
  | { owner: string }
  | { drop: "unsubscribed" | "duplicate" };

export type ReplyCheck =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; status: number; reason: string };

export class Router {
  private sessions = new Map<string, Session>();
  /** canonical key -> session ids, in subscription order (oldest first). */
  private subs = new Map<string, string[]>();
  private seen = new BoundedSet(5000);
  /** event_id -> the event and the session it was routed to. */
  private owned = new Map<string, { event: NormalizedEvent; owner: string }>();
  private ownedOrder: string[] = [];
  private replied = new BoundedSet(5000);

  constructor(
    private readonly graceMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  // --- sessions -------------------------------------------------------------

  connect(id: string) {
    const s = this.sessions.get(id);
    if (s) {
      s.connected = true;
      s.disconnectedAt = undefined;
    } else this.sessions.set(id, { id, connected: true });
  }

  disconnect(id: string) {
    const s = this.sessions.get(id);
    if (s) {
      s.connected = false;
      s.disconnectedAt = this.now();
    }
  }

  /** Forget sessions that have been gone longer than the grace period. */
  sweep() {
    const cutoff = this.now() - this.graceMs;
    for (const s of this.sessions.values()) {
      if (!s.connected && (s.disconnectedAt ?? 0) < cutoff) {
        this.sessions.delete(s.id);
        for (const [k, ids] of this.subs) {
          const left = ids.filter((x) => x !== s.id);
          if (left.length) this.subs.set(k, left);
          else this.subs.delete(k);
        }
      }
    }
  }

  // --- subscriptions --------------------------------------------------------

  subscribe(session: string, key: string): string | null {
    const k = canonicalKey(key);
    if (!k) return null;
    // A session may subscribe before its stream connects (server.ts re-asserts
    // subscriptions first on every reconnect). Start its grace period now, or
    // sweep() would treat it as long gone and drop it immediately.
    if (!this.sessions.has(session))
      this.sessions.set(session, { id: session, connected: false, disconnectedAt: this.now() });
    const ids = this.subs.get(k) ?? [];
    if (!ids.includes(session)) ids.push(session);
    this.subs.set(k, ids);
    return k;
  }

  unsubscribe(session: string, key: string): string | null {
    const k = canonicalKey(key);
    if (!k) return null;
    const left = (this.subs.get(k) ?? []).filter((x) => x !== session);
    if (left.length) this.subs.set(k, left);
    else this.subs.delete(k);
    return k;
  }

  subscriptions(session: string): { key: string; role: "owner" | "standby" }[] {
    const out: { key: string; role: "owner" | "standby" }[] = [];
    for (const [k, ids] of this.subs) {
      if (ids.includes(session)) out.push({ key: k, role: this.ownerOf(k) === session ? "owner" : "standby" });
    }
    return out;
  }

  /** Oldest connected subscriber; failing that, oldest still inside its grace
   *  period (it will get the event on replay when it reconnects). */
  ownerOf(key: string): string | null {
    this.sweep();
    const ids = this.subs.get(canonicalKey(key) ?? "") ?? [];
    return (
      ids.find((id) => this.sessions.get(id)?.connected) ??
      ids.find((id) => this.sessions.has(id)) ??
      null
    );
  }

  // --- events ---------------------------------------------------------------

  /** Decide an incoming event's fate. Mutates dedupe state only when accepted,
   *  so an event for an unsubscribed PR can still be delivered if someone
   *  subscribes and GitHub redelivers it. */
  route(ev: NormalizedEvent, deliveryId?: string): RouteResult {
    if (this.seen.has(ev.event_id)) return { drop: "duplicate" };
    if (deliveryId && this.seen.has(`delivery:${deliveryId}`)) return { drop: "duplicate" };
    const owner = this.ownerOf(ev.correlation_key);
    if (!owner) return { drop: "unsubscribed" };
    this.seen.add(ev.event_id);
    if (deliveryId) this.seen.add(`delivery:${deliveryId}`);
    this.owned.set(ev.event_id, { event: ev, owner });
    this.ownedOrder.push(ev.event_id);
    if (this.ownedOrder.length > 5000) this.owned.delete(this.ownedOrder.shift()!);
    return { owner };
  }

  ownerOfEvent(eventId: string): string | null {
    return this.owned.get(eventId)?.owner ?? null;
  }

  // --- replies --------------------------------------------------------------

  /** May `session` answer `inReplyTo` on `key`? Does not consume the claim;
   *  call `markReplied` once the reply is actually published. */
  checkReply(session: string, key: string, inReplyTo: string): ReplyCheck {
    const rec = this.owned.get(inReplyTo);
    if (!rec) return { ok: false, status: 404, reason: `unknown event ${inReplyTo}` };
    if (canonicalKey(key) !== canonicalKey(rec.event.correlation_key))
      return {
        ok: false,
        status: 409,
        reason: `event ${inReplyTo} belongs to ${rec.event.correlation_key}, not ${key}`,
      };
    if (rec.owner !== session)
      return { ok: false, status: 409, reason: `event ${inReplyTo} is owned by another session` };
    if (this.replied.has(inReplyTo))
      return { ok: false, status: 409, reason: `event ${inReplyTo} already has a reply` };
    return { ok: true, event: rec.event };
  }

  markReplied(inReplyTo: string) {
    this.replied.add(inReplyTo);
  }

  stats() {
    return {
      sessions: [...this.sessions.values()].map((s) => ({ id: s.id, connected: s.connected })),
      subscriptions: Object.fromEntries(this.subs),
    };
  }
}

class BoundedSet {
  private set = new Set<string>();
  private order: string[] = [];
  constructor(private readonly max: number) {}
  has(k: string) {
    return this.set.has(k);
  }
  add(k: string) {
    if (this.set.has(k)) return;
    this.set.add(k);
    this.order.push(k);
    if (this.order.length > this.max) this.set.delete(this.order.shift()!);
  }
}
