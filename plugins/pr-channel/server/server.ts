/**
 * server.ts — the MCP channel server. Spawned by claude as a stdio subprocess.
 *
 * Two jobs:
 *   ingress  hold this session's PR subscriptions at the intake, read the
 *            events the intake routes to this session over SSE, and emit each
 *            as `notifications/claude/channel`, which claude renders into the
 *            running session as a `<channel source="...">` block.
 *   egress   expose `post_reply` (plus subscribe / unsubscribe /
 *            list_subscriptions), forwarded to the intake, the only process
 *            holding a GitHub token.
 *
 * Each process gets a random session id. The intake routes every event to
 * exactly one subscribed session, so two open shells on the same PR no longer
 * both answer it (the 9/23 double reply).
 *
 * The JSON-RPC is hand-rolled on purpose. The single thing that makes a channel
 * server a channel server is `capabilities.experimental["claude/channel"]` in
 * the initialize result — its mere presence registers the listener. An SDK that
 * normalizes unknown capability keys, or refuses a non-standard notification
 * method, would break this silently, and "silently" is the whole problem with
 * this protocol (see below). 150 lines of explicit framing is the cheaper risk.
 *
 * THERE IS NO DELIVERY ACKNOWLEDGEMENT. If the session did not register the
 * channel — wrong server name passed to --dangerously-load-development-channels,
 * capability absent, consent dialog never accepted — claude drops every event
 * and this process sees no error whatsoever.
 *
 * On the name: claude validates a `server:<name>` channel entry against the MCP
 * servers registered in its user/project/local scopes, NOT against a
 * `--mcp-config` file. Launching with `--mcp-config` makes it print "no MCP
 * server configured with that name" even when the name matches (the 9/23
 * error). Register the server in a scope, or install it as the plugin and use
 * `plugin:pr-channel@review-kit`. Nothing here can detect that. That
 * is why the acceptance test reads the session transcript and not these logs.
 */
import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "./types.ts";
import { sanitizeMetaVerbose } from "./meta.ts";

/** The intake's CONTROL port (loopback), not the public webhook port. */
const INTAKE = process.env.INTAKE_URL ?? "http://127.0.0.1:8788";
/** Must equal the MCP server's registered name. SERVER_NAME is accepted too:
 *  the 9/23 launcher set it while this file only read CHANNEL_SERVER_NAME, so
 *  the server announced itself under a name nothing else used. */
const SERVER_NAME = process.env.CHANNEL_SERVER_NAME ?? process.env.SERVER_NAME ?? "pr-channel";
const SESSION = process.env.PR_CHANNEL_SESSION_ID ?? randomUUID();
/** Subscriptions this session holds. The source of truth is here, not at the
 *  intake, so they are re-sent whenever the intake restarts. Seed with
 *  PR_CHANNEL_SUBSCRIBE="owner/repo#1,owner/repo#2". */
const subscriptions = new Set<string>(
  (process.env.PR_CHANNEL_SUBSCRIBE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

/**
 * Claude owns this process's stderr and does not surface it anywhere you can
 * read during a run, so CHANNEL_LOG_FILE mirrors the log to disk. Without it,
 * debugging a non-delivering channel means debugging a process you cannot see.
 */
const LOG_FILE = process.env.CHANNEL_LOG_FILE ?? "";
let logStream: any = null;
if (LOG_FILE) {
  try {
    const { createWriteStream } = await import("node:fs");
    logStream = createWriteStream(LOG_FILE, { flags: "a" });
  } catch {
    /* logging is best-effort; never take the server down for it */
  }
}

function log(msg: string) {
  const line = `[channel-server ${new Date().toISOString()}] ${msg}\n`;
  // stderr ONLY. A stray byte on stdout corrupts the JSON-RPC stream and the
  // session loses the server with a parse error.
  process.stderr.write(line);
  try {
    logStream?.write(line);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited, per the MCP stdio transport)
// ---------------------------------------------------------------------------

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// meta sanitation — the hyphen trap
// ---------------------------------------------------------------------------

/** See meta.ts. Claude drops a bad key silently, so we say so loudly here. */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, string> {
  const { meta: clean, dropped } = sanitizeMetaVerbose(meta);
  for (const k of dropped) {
    log(
      `WARNING dropping meta key ${JSON.stringify(k)}: keys must match ` +
        `[A-Za-z0-9_]+ (claude would drop it silently — use pr_number, not pr-number)`,
    );
  }
  return clean;
}

// ---------------------------------------------------------------------------
// the channel notification
// ---------------------------------------------------------------------------

function channelText(ev: NormalizedEvent): string {
  const label =
    ev.kind === "check_failed"
      ? "A CI check failed"
      : ev.kind === "review_comment"
        ? "A new inline review comment was posted"
        : ev.kind === "review"
          ? "A review was submitted"
          : "A new comment was posted";
  return [
    `${label} on ${ev.correlation_key} by @${ev.actor.id}.`,
    ev.permalink ? `Link: ${ev.permalink}` : "",
    "",
    ev.body,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function emitChannel(ev: NormalizedEvent) {
  send({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: {
      content: channelText(ev),
      meta: sanitizeMeta({
        // Underscores only. See sanitizeMeta above.
        event_id: ev.event_id,
        correlation_key: ev.correlation_key,
        kind: ev.kind,
        actor: ev.actor.id,
        actor_is_bot: ev.actor.is_bot,
        permalink: ev.permalink,
      }),
    },
  });
  log(`-> notifications/claude/channel seq=${ev.seq} ${ev.event_id}`);
}

const INSTRUCTIONS = `
You are attached to a GitHub pull-request review channel.

You only receive events for PRs this session has subscribed to. Call the
subscribe tool with owner/repo#N for the PR you are working on (list_subscriptions
shows what you hold). If several sessions subscribe to the same PR, each event
goes to exactly one of them; list_subscriptions shows whether you are the owner
or a standby.

Events arrive on their own, without anyone prompting you. Each one appears as a
channel block tagged with source="${SERVER_NAME}", whose attributes include:

  event_id          the id to answer; pass it to post_reply as in_reply_to
  correlation_key   the PR, as owner/repo#number
  kind              review_comment | review | issue_comment | check_failed
  actor             who caused it (actor_is_bot says whether it was a bot)
  permalink         where it lives on GitHub

When an event arrives:
  1. Decide how to respond the way this repository says to: follow its
     CLAUDE.md and REVIEW.md.
  2. Reply by calling post_reply with the event's correlation_key, its event_id
     as in_reply_to, and your answer in body. That is the ONLY way to get a
     message back to the PR; writing it in the chat reaches nobody.
  3. Each event takes exactly one reply. A second post_reply for the same
     event_id is refused.

Be brief and concrete. You are answering a reviewer, not writing a report.
`.trim();

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

const KEY_PROP = {
  type: "string",
  description: "The PR, as owner/repo#number, e.g. aowen14/dev-agent-workshop-starter#1.",
};

const TOOLS = [
  {
    name: "post_reply",
    description:
      "Publish a reply on the PR an event came from, citing the originating comment. " +
      "Use this to answer a review comment; chat output does not reach GitHub. One reply per event.",
    inputSchema: {
      type: "object",
      properties: {
        correlation_key: {
          type: "string",
          description: "The PR to reply on, as owner/repo#number. Copy it from the event.",
        },
        in_reply_to: {
          type: "string",
          description: "The event_id being answered. Copy it from the event.",
        },
        body: { type: "string", description: "Markdown body of the reply." },
      },
      required: ["correlation_key", "in_reply_to", "body"],
    },
  },
  {
    name: "subscribe",
    description: "Start receiving review events for a PR in this session.",
    inputSchema: { type: "object", properties: { pr: KEY_PROP }, required: ["pr"] },
  },
  {
    name: "unsubscribe",
    description: "Stop receiving review events for a PR in this session.",
    inputSchema: { type: "object", properties: { pr: KEY_PROP }, required: ["pr"] },
  },
  {
    name: "list_subscriptions",
    description:
      "List the PRs this session is subscribed to, and whether it owns each one " +
      "(receives its events) or is a standby behind another session.",
    inputSchema: { type: "object", properties: {} },
  },
];

let initialized = false;
/** How long to wait for `notifications/initialized` before emitting anyway. */
const INIT_GRACE_MS = Number(process.env.CHANNEL_INIT_GRACE_MS ?? 3000);
/** Events that arrived before the client said it was ready. */
const pending: NormalizedEvent[] = [];

function flushPending() {
  while (pending.length) emitChannel(pending.shift()!);
}

async function intakePost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${INTAKE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.reason ?? json?.error ?? `intake returned HTTP ${res.status}`);
  return json;
}

function describeSubs(json: any): string {
  const subs: { key: string; role: string }[] = json?.subscriptions ?? [];
  if (!subs.length) return "No subscriptions. Call subscribe with owner/repo#N.";
  return subs.map((s) => `${s.key}  (${s.role})`).join("\n");
}

async function callTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "post_reply": {
      const json = await intakePost("/reply", {
        session: SESSION,
        correlation_key: args?.correlation_key,
        in_reply_to: args?.in_reply_to,
        body: args?.body,
      });
      const r = json?.reply ?? {};
      log(`post_reply -> ${r.correlation_key} delivery=${r.delivery}`);
      return r.delivery === "github"
        ? `Posted: ${r.detail}`
        : `Reply recorded for ${r.correlation_key} but not published (${r.detail}).`;
    }
    case "subscribe":
    case "unsubscribe": {
      const json = await intakePost("/subscriptions", { session: SESSION, action: name, key: args?.pr });
      if (name === "subscribe") subscriptions.add(String(args?.pr));
      else subscriptions.delete(String(args?.pr));
      return describeSubs(json);
    }
    case "list_subscriptions": {
      const res = await fetch(`${INTAKE}/subscriptions?session=${encodeURIComponent(SESSION)}`);
      return describeSubs(await res.json());
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      // Echo the client's protocol version rather than asserting our own: a
      // version mismatch here is another silent-failure path.
      const pv = params?.protocolVersion ?? "2025-06-18";
      log(`initialize from ${params?.clientInfo?.name ?? "?"} protocolVersion=${pv}`);
      reply(id, {
        protocolVersion: pv,
        capabilities: {
          // >>> The line that makes this a channel server. <<<
          experimental: { "claude/channel": {} },
          tools: {},
        },
        serverInfo: { name: SERVER_NAME, version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
      // Do not make delivery depend on `notifications/initialized` arriving.
      // If a client skips it, events would queue forever and the channel would
      // look dead for a reason no log would explain. The handshake is complete
      // from our side once this result is written; give the client a short
      // grace period and then start emitting regardless.
      setTimeout(() => {
        if (!initialized) {
          initialized = true;
          log(`no notifications/initialized after grace period — emitting anyway`);
          flushPending();
        }
      }, INIT_GRACE_MS).unref?.();
      return;
    }
    case "notifications/initialized": {
      initialized = true;
      log(`client initialized; channel listener should now be live`);
      flushPending();
      return;
    }
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      try {
        const text = await callTool(params?.name, params?.arguments);
        reply(id, { content: [{ type: "text", text }] });
      } catch (e: any) {
        reply(id, {
          content: [{ type: "text", text: `${params?.name} failed: ${e?.message ?? e}` }],
          isError: true,
        });
      }
      return;
    }
    case "ping":
      reply(id, {});
      return;
    // Claude probes these; answer politely rather than erroring, so a probe
    // does not show up as a broken server in the UI.
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    default: {
      if (typeof method === "string" && method.startsWith("notifications/")) return;
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------
// stdin pump
// ---------------------------------------------------------------------------

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`dropping unparseable line: ${line.slice(0, 200)}`);
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => {
  log("stdin closed; exiting");
  process.exit(0);
});

// ---------------------------------------------------------------------------
// SSE subscription to intake
// ---------------------------------------------------------------------------

/**
 * Start from the intake's CURRENT head, not from zero.
 *
 * Two reasons. Semantically, a session that just came up should not have the
 * whole backlog of yesterday's review comments shoved into it. Practically, the
 * replay used to fire ~0.4s after the MCP handshake — while the dev-channels
 * consent dialog was still on screen and the TUI had not mounted — and those
 * events were silently dropped. The cursor only moves forward from here, so
 * a mid-session reconnect still replays what the session actually missed.
 */
async function startCursor(): Promise<number> {
  try {
    const res = await fetch(`${INTAKE}/healthz`);
    const j: any = await res.json();
    const head = Number(j?.seq ?? 0);
    log(`starting from intake head seq=${head} (backlog is not replayed)`);
    return head;
  } catch (e: any) {
    log(`could not read intake head (${e?.message ?? e}); starting from 0`);
    return 0;
  }
}

async function subscribe() {
  let cursor = await startCursor();
  let backoff = 500;
  for (;;) {
    try {
      // Re-assert subscriptions on every (re)connect: the intake may have
      // restarted and forgotten them.
      for (const key of subscriptions) {
        await intakePost("/subscriptions", { session: SESSION, action: "subscribe", key }).catch((e) =>
          log(`could not subscribe to ${key}: ${e?.message ?? e}`),
        );
      }
      log(`connecting to ${INTAKE}/events as session ${SESSION} since=${cursor}`);
      const res = await fetch(`${INTAKE}/events?session=${encodeURIComponent(SESSION)}&since=${cursor}`, {
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 500;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let sbuf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sbuf += dec.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = sbuf.indexOf("\n\n")) >= 0) {
          const frame = sbuf.slice(0, sep);
          sbuf = sbuf.slice(sep + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue; // keep-alive comment
          let ev: NormalizedEvent;
          try {
            ev = JSON.parse(data);
          } catch {
            log(`dropping unparseable SSE frame`);
            continue;
          }
          // Bots are NOT dropped here: a review bot's comments are exactly
          // what a PR session wants. Our own replies are dropped at the intake
          // (reply marker + self login), which is where the loop guard belongs.
          cursor = Math.max(cursor, ev.seq ?? 0);
          if (initialized) emitChannel(ev);
          else {
            log(`queueing ${ev.event_id} until client is initialized`);
            pending.push(ev);
          }
        }
      }
      log(`SSE stream ended; reconnecting`);
    } catch (e: any) {
      log(`SSE error (${e?.message ?? e}); retrying in ${backoff}ms`);
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 10000);
  }
}

log(`starting; intake=${INTAKE} name=${SERVER_NAME} session=${SESSION}`);
void subscribe();
