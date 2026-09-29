/**
 * intake.ts: the HTTP boundary.
 *
 *   GitHub webhook -> verify signature -> NormalizedEvent -> route to ONE session
 *
 * Runs as its own long-lived process. It deliberately knows nothing about MCP:
 * it speaks HTTP and SSE, and each `server.ts` (one per claude session) is a
 * subscriber. That split exists because the MCP server's lifetime is owned by
 * claude (it is claude's stdio subprocess and dies with the session), while the
 * intake must outlive any single session to accept a webhook at all.
 *
 * TWO LISTENERS, on purpose:
 *
 *   public   PUBLIC_PORT (8787)   POST /webhook/github, GET /healthz
 *            This is the only thing Tailscale Funnel / smee / cloudflared may
 *            point at. Every request must carry a valid X-Hub-Signature-256.
 *   control  CONTROL_PORT (8788), loopback only
 *            SSE to sessions, subscriptions, replies, local ingest, state.
 *
 * A funnel forwards from localhost, so "only accept loopback" cannot protect a
 * single port once it is funneled. Were the control routes on the public port,
 * anyone on the internet could post replies with our GitHub token.
 *
 * Egress lives here (`POST /reply`): this process is the only thing holding a
 * GitHub token.
 */
import type { NormalizedEvent, Reply } from "./types.ts";
import { normalizeGitHub } from "./normalize.ts";
import { verifyGitHubSignature } from "./signature.ts";
import { Router, canonicalKey } from "./router.ts";

/** Every reply carries this marker, added here rather than trusted to the
 *  model, and every ingress drops anything carrying it. It is the loop guard
 *  that still works when the agent posts as the same human who reviews. */
const AGENT_MARKER = process.env.AGENT_REPLY_MARKER ?? "<!-- agent-reply -->";
export function isSelfAuthored(body: string | undefined): boolean {
  return typeof body === "string" && body.includes(AGENT_MARKER);
}

const PUBLIC_HOST = process.env.PUBLIC_HOST ?? process.env.HOST ?? "127.0.0.1";
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? process.env.PORT ?? 8787);
/** Keep this loopback. The only reason to change it is a container, where
 *  compose's published-port bind does the constraining. */
const CONTROL_HOST = process.env.CONTROL_HOST ?? "127.0.0.1";
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8788);

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
/** Reject deliveries whose event happened longer ago than this. Set 0 to turn
 *  it off, e.g. to test with GitHub's "Redeliver" button on an old event. */
const MAX_EVENT_AGE_S = Number(process.env.MAX_EVENT_AGE_SECONDS ?? 3600);

/** Where a reply goes when it is not published to GitHub. */
const REPLY_DIR = process.env.REPLY_DIR ?? "./.out/replies";
const GH_TOKEN = process.env.GH_TOKEN ?? "";
const GH_API = process.env.GH_API ?? "https://api.github.com";
/** Set to "1" to actually publish replies to GitHub. Off by default so a test
 *  run never writes comments onto a real PR by accident. */
const PUBLISH = process.env.PUBLISH_REPLIES === "1";

if (!WEBHOOK_SECRET) {
  // No unsigned mode. An intake that accepts unsigned events is an open door
  // into a session that can run tools, the moment it is funneled.
  console.error("GITHUB_WEBHOOK_SECRET is not set. Refusing to start: every webhook must be signed.");
  process.exit(2);
}

function log(msg: string) {
  console.log(`[intake ${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// self identity
// ---------------------------------------------------------------------------

/**
 * The login replies are posted as. Events by it are ours and are dropped.
 *
 * Only a dedicated identity can be filtered by login: when the token belongs to
 * the same human who reviews (the single-operator demo), filtering their login
 * would drop every real review comment too. So a personal (User) token is not
 * filtered by login and the loop guard falls back to the reply marker. Use a
 * machine user or GitHub App token, or set BOT_LOGIN, to get both.
 */
let SELF_LOGIN = (process.env.BOT_LOGIN ?? "").toLowerCase();

async function resolveSelf() {
  if (SELF_LOGIN || !GH_TOKEN || !PUBLISH) return;
  try {
    const res = await fetch(`${GH_API}/user`, { headers: ghHeaders() });
    if (!res.ok) return log(`self: GET /user returned ${res.status}; relying on the reply marker`);
    const u: any = await res.json();
    if (u?.type === "Bot" || String(u?.login ?? "").endsWith("[bot]")) {
      SELF_LOGIN = String(u.login).toLowerCase();
      log(`self: replies post as ${u.login}; its events will be dropped`);
    } else {
      log(
        `self: token belongs to user ${u?.login}, the same identity a human reviews as. ` +
          `Not filtering by login (it would drop real comments); relying on the reply marker. ` +
          `Set BOT_LOGIN or use a machine-user/App token to filter by identity too.`,
      );
    }
  } catch (e: any) {
    log(`self: could not resolve (${e?.message ?? e}); relying on the reply marker`);
  }
}

function isSelf(ev: NormalizedEvent): boolean {
  return isSelfAuthored(ev.body) || (!!SELF_LOGIN && ev.actor.id.toLowerCase() === SELF_LOGIN);
}

// ---------------------------------------------------------------------------
// state: routing + per-session replay ring
// ---------------------------------------------------------------------------

const router = new Router(Number(process.env.SESSION_GRACE_MS ?? 60_000));

let seq = 0;
/** Replay ring, so a session whose MCP server reconnects catches up on what it
 *  owned while it was away. */
const ring: { ev: NormalizedEvent; owner: string }[] = [];
const RING_MAX = 500;

type Sub = { session: string; write: (chunk: string) => void };
const streams = new Map<number, Sub>();
let streamId = 0;

const replies: Reply[] = [];
const counters = { accepted: 0, duplicate: 0, unsubscribed: 0, self: 0, stale: 0, unsigned: 0 };

function frame(ev: NormalizedEvent) {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function deliver(ev: NormalizedEvent, owner: string) {
  ring.push({ ev, owner });
  if (ring.length > RING_MAX) ring.shift();
  let n = 0;
  for (const [id, s] of streams) {
    if (s.session !== owner) continue;
    try {
      s.write(frame(ev));
      n++;
    } catch {
      streams.delete(id);
    }
  }
  log(
    `event seq=${ev.seq} kind=${ev.kind} ${ev.correlation_key} actor=${ev.actor.id}` +
      `${ev.actor.is_bot ? " (bot)" : ""} -> session ${owner.slice(0, 8)}` +
      (n ? "" : " (not connected; queued for replay)"),
  );
}

type Accepted = { status: "accepted"; event: NormalizedEvent; session: string };
type Refused = { status: "duplicate" | "unsubscribed" | "self-authored" | "stale"; event_id: string };

/** Everything that is not a signature check: both ingress doors end here, so
 *  nothing downstream can tell them apart. */
function accept(ev: NormalizedEvent, deliveryId?: string): Accepted | Refused {
  if (isSelf(ev)) {
    counters.self++;
    log(`skip ${ev.event_id}: authored by this agent (loop guard)`);
    return { status: "self-authored", event_id: ev.event_id };
  }
  if (MAX_EVENT_AGE_S > 0 && ev.occurred_at) {
    const age = (Date.now() - Date.parse(ev.occurred_at)) / 1000;
    if (age > MAX_EVENT_AGE_S) {
      counters.stale++;
      log(`skip ${ev.event_id}: stale (${Math.round(age)}s old > ${MAX_EVENT_AGE_S}s)`);
      return { status: "stale", event_id: ev.event_id };
    }
  }
  const r = router.route(ev, deliveryId);
  if ("drop" in r) {
    counters[r.drop]++;
    log(`skip ${ev.event_id}: ${r.drop === "duplicate" ? "duplicate delivery" : `no session subscribed to ${ev.correlation_key}`}`);
    return { status: r.drop, event_id: ev.event_id };
  }
  counters.accepted++;
  ev.seq = ++seq;
  deliver(ev, r.owner);
  return { status: "accepted", event: ev, session: r.owner };
}

// ---------------------------------------------------------------------------
// egress
// ---------------------------------------------------------------------------

function ghHeaders() {
  return {
    authorization: `Bearer ${GH_TOKEN}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  };
}

async function ghPost(path: string, body: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${GH_API}${path}`, {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify({ body }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
    return { ok: true, detail: JSON.parse(text).html_url ?? path };
  } catch (e: any) {
    return { ok: false, detail: `fetch failed: ${e?.message ?? e}` };
  }
}

/** Inline review comments get a threaded reply next to the code; everything
 *  else a PR conversation comment. The key comes from the ORIGINATING EVENT,
 *  never from the model, so a reply cannot land on the wrong PR. */
async function postToGitHub(ev: NormalizedEvent, body: string) {
  const m = /^(.+?)\/(.+?)#(\d+)$/.exec(ev.correlation_key)!;
  const [, owner, repo, num] = m;
  if (ev.kind === "review_comment" && ev.comment_id) {
    const out = await ghPost(`/repos/${owner}/${repo}/pulls/${num}/comments/${ev.comment_id}/replies`, body);
    if (out.ok) return out;
    log(`reply: thread reply failed (${out.detail}); falling back to a PR comment`);
  }
  return ghPost(`/repos/${owner}/${repo}/issues/${num}/comments`, body);
}

function replyBody(ev: NormalizedEvent, text: string): string {
  const cite = ev.permalink ? `> Re: [@${ev.actor.id}'s comment](${ev.permalink})\n\n` : "";
  return `${AGENT_MARKER}\n${cite}${text.replaceAll(AGENT_MARKER, "").trim()}`;
}

async function handleReply(req: any): Promise<Response> {
  const session = String(req?.session ?? "");
  const key = String(req?.correlation_key ?? "");
  const inReplyTo = String(req?.in_reply_to ?? "");
  const text = String(req?.body ?? "");
  if (!session || !key || !inReplyTo || !text.trim())
    return Response.json(
      { error: "session, correlation_key, in_reply_to and body are all required" },
      { status: 400 },
    );

  const check = router.checkReply(session, key, inReplyTo);
  if (!check.ok) {
    log(`reply refused for ${key} (${inReplyTo}): ${check.reason}`);
    return Response.json({ status: "refused", reason: check.reason }, { status: check.status });
  }
  // Claim before the network call, so a concurrent second reply is refused
  // rather than racing the first one onto GitHub.
  router.markReplied(inReplyTo);

  const ev = check.event;
  const rec: Reply = {
    correlation_key: ev.correlation_key,
    body: replyBody(ev, text),
    in_reply_to: inReplyTo,
    session,
    posted_at: new Date().toISOString(),
    delivery: "file",
  };
  if (PUBLISH && GH_TOKEN) {
    const out = await postToGitHub(ev, rec.body);
    rec.delivery = out.ok ? "github" : "file";
    rec.detail = out.detail;
    if (!out.ok) log(`reply: GitHub publish failed, kept on disk only: ${out.detail}`);
  } else {
    rec.detail = PUBLISH ? "no GH_TOKEN" : "PUBLISH_REPLIES!=1";
  }

  // Always land it on disk: the audit trail, and the artifact tests read when
  // nothing is published.
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(REPLY_DIR, { recursive: true });
    const safe = rec.correlation_key.replace(/[^A-Za-z0-9._#-]/g, "_");
    await writeFile(`${REPLY_DIR}/${Date.now()}-${safe}.json`, JSON.stringify(rec, null, 2));
  } catch (e: any) {
    log(`reply: could not write to ${REPLY_DIR}: ${e?.message ?? e}`);
  }

  replies.push(rec);
  log(`reply for ${rec.correlation_key} (${inReplyTo}) delivery=${rec.delivery} (${rec.detail})`);
  return Response.json({ status: "ok", reply: rec });
}

// ---------------------------------------------------------------------------
// public listener: webhook ingress only
// ---------------------------------------------------------------------------

const publicServer = Bun.serve({
  hostname: PUBLIC_HOST,
  port: PUBLIC_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });

    if (url.pathname !== "/webhook/github") return new Response("not found", { status: 404 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Verify against the raw bytes, before parsing anything.
    const raw = new Uint8Array(await req.arrayBuffer());
    if (!verifyGitHubSignature(WEBHOOK_SECRET, raw, req.headers.get("x-hub-signature-256"))) {
      counters.unsigned++;
      log(`401: missing or bad X-Hub-Signature-256 (delivery ${req.headers.get("x-github-delivery") ?? "?"})`);
      return Response.json({ error: "bad signature" }, { status: 401 });
    }

    const eventName = req.headers.get("x-github-event") ?? "";
    if (eventName === "ping") return Response.json({ status: "pong" });

    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return Response.json({ error: "body is not JSON" }, { status: 400 });
    }
    const norm = normalizeGitHub(eventName, payload);
    if ("skip" in norm) {
      log(`skip: ${norm.skip}`);
      return Response.json({ status: "skipped", reason: norm.skip }, { status: 202 });
    }
    const out = accept(norm, req.headers.get("x-github-delivery") ?? undefined);
    // Only a stale delivery is an error from GitHub's point of view; the rest
    // are the intake working as designed, and a 2xx stops GitHub retrying.
    const status = out.status === "stale" ? 422 : out.status === "accepted" ? 200 : 202;
    return Response.json(out, { status });
  },
});

// ---------------------------------------------------------------------------
// control listener: loopback only
// ---------------------------------------------------------------------------

const controlServer = Bun.serve({
  hostname: CONTROL_HOST,
  port: CONTROL_PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz")
      return Response.json({ ok: true, seq, streams: streams.size, self_login: SELF_LOGIN || null });

    if (url.pathname === "/state")
      return Response.json({ seq, counters, streams: streams.size, ...router.stats(), replies });

    // --- subscriptions -------------------------------------------------------
    if (url.pathname === "/subscriptions") {
      if (req.method === "GET") {
        const session = url.searchParams.get("session") ?? "";
        return Response.json({ session, subscriptions: router.subscriptions(session) });
      }
      if (req.method === "POST") {
        const b: any = await req.json().catch(() => ({}));
        const session = String(b?.session ?? "");
        if (!session) return Response.json({ error: "session is required" }, { status: 400 });
        const fn = b?.action === "unsubscribe" ? router.unsubscribe : router.subscribe;
        const k = fn.call(router, session, String(b?.key ?? ""));
        if (!k) return Response.json({ error: `not an owner/repo#N key: ${b?.key}` }, { status: 400 });
        log(`session ${session.slice(0, 8)} ${b?.action === "unsubscribe" ? "unsubscribed from" : "subscribed to"} ${k}`);
        return Response.json({ session, subscriptions: router.subscriptions(session) });
      }
    }

    // --- neutral ingress ----------------------------------------------------
    // An already-normalized envelope, so a local producer does not have to
    // pretend to be GitHub. Loopback only, so unsigned is acceptable here.
    if (url.pathname === "/ingest" && req.method === "POST") {
      const env: any = await req.json().catch(() => null);
      for (const k of ["event_id", "correlation_key", "kind", "body"]) {
        if (typeof env?.[k] !== "string" || !env[k])
          return Response.json({ error: `envelope is missing a string '${k}'` }, { status: 400 });
      }
      if (!canonicalKey(env.correlation_key))
        return Response.json({ error: `not an owner/repo#N key: ${env.correlation_key}` }, { status: 400 });
      env.actor ??= { id: "local", is_bot: false };
      env.received_at ??= new Date().toISOString();
      env.permalink ??= "";
      return Response.json(accept(env as NormalizedEvent));
    }

    // --- egress ---------------------------------------------------------------
    if (url.pathname === "/reply" && req.method === "POST") {
      const b = await req.json().catch(() => null);
      if (!b) return Response.json({ error: "body is not JSON" }, { status: 400 });
      return handleReply(b);
    }

    // --- per-session SSE --------------------------------------------------------
    if (url.pathname === "/events") {
      const session = url.searchParams.get("session") ?? "";
      if (!session) return Response.json({ error: "session is required" }, { status: 400 });
      const since = Number(url.searchParams.get("since") ?? "0");
      const id = ++streamId;
      let iv: ReturnType<typeof setInterval>;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const write = (chunk: string) => controller.enqueue(enc.encode(chunk));
          write(`: connected session=${session} since=${since}\n\n`);
          router.connect(session);
          // Replay what this session owns and has not seen, then go live.
          for (const r of ring) if (r.owner === session && (r.ev.seq ?? 0) > since) write(frame(r.ev));
          streams.set(id, { session, write });
          log(`session ${session.slice(0, 8)} connected (since=${since}); ${streams.size} stream(s)`);
          // Keep-alive: proxies and idle timeouts kill silent streams.
          iv = setInterval(() => {
            try {
              write(`: ping\n\n`);
            } catch {
              clearInterval(iv);
              streams.delete(id);
            }
          }, 15000);
        },
        cancel() {
          clearInterval(iv);
          streams.delete(id);
          if (![...streams.values()].some((s) => s.session === session)) router.disconnect(session);
          log(`session ${session.slice(0, 8)} disconnected; ${streams.size} stream(s) left`);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

await resolveSelf();
log(
  `public  ${publicServer.hostname}:${publicServer.port}  (POST /webhook/github, signed only)\n` +
    `        control ${controlServer.hostname}:${controlServer.port} (sessions, replies; never expose)\n` +
    `        publish_replies=${PUBLISH} max_event_age=${MAX_EVENT_AGE_S}s`,
);
