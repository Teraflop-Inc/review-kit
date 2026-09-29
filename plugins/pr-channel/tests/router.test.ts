/**
 * Subscription routing, single-owner delivery, dedupe, one reply per event.
 * These are the rules that stop two open shells double-replying (9/23).
 *
 *   bun test tests/
 */
import { expect, test } from "bun:test";
import { Router, canonicalKey } from "../server/router.ts";
import type { NormalizedEvent } from "../server/types.ts";

const KEY = "aowen14/dev-agent-workshop-starter#1";

function ev(id: string, key = KEY): NormalizedEvent {
  return {
    event_id: id,
    correlation_key: key,
    actor: { id: "aowen14", is_bot: false },
    kind: "issue_comment",
    body: "this all needs to be changed",
    permalink: "https://github.com/x/y/pull/1#issuecomment-1",
    received_at: new Date().toISOString(),
  };
}

test("keys are validated and compared case-insensitively", () => {
  expect(canonicalKey("Aowen14/Dev-Agent-Workshop-Starter#1")).toBe(KEY);
  expect(canonicalKey("aowen14/repo")).toBeNull();
  expect(canonicalKey("not a key")).toBeNull();
});

test("events for PRs nobody subscribed to are dropped", () => {
  const r = new Router();
  r.connect("a");
  r.subscribe("a", "other/repo#9");
  expect(r.route(ev("e1"))).toEqual({ drop: "unsubscribed" });
});

test("two sessions on one PR: exactly one owns each event", () => {
  const r = new Router();
  r.connect("a");
  r.connect("b");
  r.subscribe("a", KEY);
  r.subscribe("b", KEY);
  expect(r.route(ev("e1"))).toEqual({ owner: "a" });
  expect(r.route(ev("e2"))).toEqual({ owner: "a" });
  expect(r.subscriptions("a")).toEqual([{ key: KEY, role: "owner" }]);
  expect(r.subscriptions("b")).toEqual([{ key: KEY, role: "standby" }]);
});

test("ownership fails over when the owner disconnects", () => {
  const r = new Router();
  r.connect("a");
  r.connect("b");
  r.subscribe("a", KEY);
  r.subscribe("b", KEY);
  r.disconnect("a");
  expect(r.route(ev("e1"))).toEqual({ owner: "b" });
  r.connect("a"); // back, and still first in line
  expect(r.route(ev("e2"))).toEqual({ owner: "a" });
});

test("a disconnected session past its grace period loses its subscriptions", () => {
  let now = 0;
  const r = new Router(1000, () => now);
  r.connect("a");
  r.subscribe("a", KEY);
  r.disconnect("a");
  now = 500;
  expect(r.route(ev("e1"))).toEqual({ owner: "a" }); // held for replay
  now = 5000;
  expect(r.route(ev("e2"))).toEqual({ drop: "unsubscribed" });
  expect(r.subscriptions("a")).toEqual([]);
});

test("redelivery is deduped by object id and by delivery id", () => {
  const r = new Router();
  r.connect("a");
  r.subscribe("a", KEY);
  expect(r.route(ev("e1"), "d1")).toEqual({ owner: "a" });
  expect(r.route(ev("e1"), "d2")).toEqual({ drop: "duplicate" }); // GitHub retry
  expect(r.route(ev("e9"), "d1")).toEqual({ drop: "duplicate" }); // same delivery
});

test("an unsubscribed drop is not remembered, so a later subscriber can get a redelivery", () => {
  const r = new Router();
  r.connect("a");
  expect(r.route(ev("e1"))).toEqual({ drop: "unsubscribed" });
  r.subscribe("a", KEY);
  expect(r.route(ev("e1"))).toEqual({ owner: "a" });
});

test("only the owner may reply, only once, and only on the event's own PR", () => {
  const r = new Router();
  r.connect("a");
  r.connect("b");
  r.subscribe("a", KEY);
  r.subscribe("b", KEY);
  r.route(ev("e1"));

  const standby = r.checkReply("b", KEY, "e1");
  expect(standby.ok).toBe(false);

  const wrongPr = r.checkReply("a", "aowen14/dev-agent-workshop-starter#2", "e1");
  expect(wrongPr.ok).toBe(false);

  expect(r.checkReply("a", "nope", "missing").ok).toBe(false);

  const first = r.checkReply("a", KEY.toUpperCase(), "e1");
  expect(first.ok).toBe(true);
  r.markReplied("e1");
  const second = r.checkReply("a", KEY, "e1");
  expect(second).toEqual({ ok: false, status: 409, reason: "event e1 already has a reply" });
});

test("a session that subscribes before its stream connects keeps its subscription", () => {
  let now = 1_000_000;
  const r = new Router(60_000, () => now);
  r.subscribe("a", KEY); // not connected yet
  expect(r.subscriptions("a")).toEqual([{ key: KEY, role: "owner" }]);
  expect(r.route(ev("e1"))).toEqual({ owner: "a" });
  now += 120_000; // never connected within the grace period
  expect(r.route(ev("e2"))).toEqual({ drop: "unsubscribed" });
});
