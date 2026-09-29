/**
 * End to end, minus claude: the real intake, two real `server.ts` MCP servers
 * (two "sessions", i.e. the two shells from 9/23) spoken to over stdio, and
 * webhooks sent by scripts/post-comment.sh exactly as GitHub would sign them.
 *
 * What it cannot prove is that claude renders the notification; that is still
 * tests/run-acceptance.sh, which reads the session transcript. What it does
 * prove is everything this ticket changed:
 *
 *   unsigned / badly signed      -> 401, reaches no session
 *   unsubscribed PR              -> reaches no session
 *   subscribed PR, two sessions  -> exactly one session hears it
 *   redelivery, self-authored, stale -> dropped
 *   post_reply                   -> owner only, once, cites the permalink
 *   owner goes away              -> the standby takes over
 *
 *   tests/run-e2e.sh          (preferred: hard wall-clock limit, see there)
 *   bun test tests/e2e.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SECRET = "e2e-secret";
const PUB = 18000 + Math.floor(Math.random() * 1000);
const CTL = PUB + 1000;
const REPO = "aowen14/dev-agent-workshop-starter";
const KEY = `${REPO}#1`;
const REPLY_DIR = mkdtempSync(join(tmpdir(), "prc-replies-"));

let intake: ReturnType<typeof Bun.spawn>;
/** Every child we start, so a failing run still tears everything down instead
 *  of leaving bun waiting on a live process. */
const children: { kill(): void }[] = [];

// --- a minimal MCP client over stdio -----------------------------------------

class Session {
  proc: ReturnType<typeof Bun.spawn>;
  notes: any[] = [];
  private pending = new Map<number, (m: any) => void>();
  private nextId = 1;

  constructor(public name: string) {
    this.proc = Bun.spawn(["bun", "run", join(ROOT, "server/server.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...process.env,
        INTAKE_URL: `http://127.0.0.1:${CTL}`,
        CHANNEL_INIT_GRACE_MS: "50",
      },
    });
    children.push(this);
    this.pump();
  }

  private async pump() {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line); // a stray non-JSON byte on stdout fails the test, as it should
        if (msg.method === "notifications/claude/channel") this.notes.push(msg.params);
        else if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      }
    }
  }

  private send(msg: unknown) {
    const sink = this.proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify(msg) + "\n");
    sink.flush();
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: no reply to ${method}`)), 4000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async init() {
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "e2e" } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r.result;
  }

  async tool(name: string, args: unknown = {}) {
    const r = await this.request("tools/call", { name, arguments: args });
    return { text: r.result.content[0].text as string, isError: !!r.result.isError };
  }

  kill() {
    this.proc.kill();
  }
}

// --- helpers ------------------------------------------------------------------

async function post(args: string[]): Promise<number> {
  const p = Bun.spawn(["bash", join(ROOT, "scripts/post-comment.sh"), "--repo", REPO, ...args], {
    env: { ...process.env, INTAKE: `http://127.0.0.1:${PUB}`, GITHUB_WEBHOOK_SECRET: SECRET },
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  const m = /"status":"([a-z-]+)"|"error":"([^"]+)"/.exec(err);
  (post as any).last = m?.[1] ?? m?.[2] ?? err;
  return p.exited;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(25);
  }
}

async function state() {
  return (await fetch(`http://127.0.0.1:${CTL}/state`)).json() as Promise<any>;
}

// --- lifecycle --------------------------------------------------------------------

let A: Session;
let B: Session;

beforeAll(async () => {
  intake = Bun.spawn(["bun", "run", join(ROOT, "server/intake.ts")], {
    env: {
      ...process.env,
      GITHUB_WEBHOOK_SECRET: SECRET,
      PUBLIC_PORT: String(PUB),
      CONTROL_PORT: String(CTL),
      PUBLISH_REPLIES: "0",
      REPLY_DIR,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  children.push(intake);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${CTL}/healthz`)).ok) break;
    } catch {}
    await sleep(50);
  }
  A = new Session("A");
  await A.init();
  await sleep(200); // A subscribes first, so A is the owner
  B = new Session("B");
  await B.init();
});

afterAll(() => {
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
});

// --- the tests ----------------------------------------------------------------------

test("the server announces the name it is registered under, and the channel capability", async () => {
  const s = new Session("probe");
  const r = await s.init();
  s.kill();
  expect(r.serverInfo.name).toBe("pr-channel");
  expect(r.capabilities.experimental["claude/channel"]).toEqual({});
});

test("the intake refuses to start without a webhook secret", async () => {
  const p = Bun.spawn(["bun", "run", join(ROOT, "server/intake.ts")], {
    env: { ...process.env, GITHUB_WEBHOOK_SECRET: "", PUBLIC_PORT: "0", CONTROL_PORT: "0" },
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await p.exited).toBe(2);
});

test("control routes are not served on the public port", async () => {
  for (const path of ["/events?session=x", "/reply", "/subscriptions", "/state", "/ingest"]) {
    expect((await fetch(`http://127.0.0.1:${PUB}${path}`)).status).toBe(404);
  }
});

test("both sessions subscribe; the first is owner, the second standby", async () => {
  expect((await A.tool("subscribe", { pr: KEY })).text).toContain("(owner)");
  expect((await B.tool("subscribe", { pr: KEY })).text).toContain("(standby)");
  expect((await A.tool("subscribe", { pr: "not-a-key" })).isError).toBe(true);
  // Give both SSE streams time to be connected.
  await sleep(300);
});

test("unsigned and badly signed webhooks get 401 and reach no session", async () => {
  expect(await post(["--pr", "1", "--kind", "issue_comment", "--body", "unsigned", "--no-sign", "--expect", "401"])).toBe(0);
  expect(await post(["--pr", "1", "--kind", "issue_comment", "--body", "forged", "--bad-sig", "--expect", "401"])).toBe(0);
  await sleep(300);
  expect(A.notes.length + B.notes.length).toBe(0);
  expect((await state()).counters.unsigned).toBe(2);
});

test("a comment on a PR nobody subscribed to reaches no session", async () => {
  expect(await post(["--pr", "2", "--kind", "issue_comment", "--body", "other pr", "--expect", "202"])).toBe(0);
  await sleep(300);
  expect(A.notes.length + B.notes.length).toBe(0);
});

test("a signed comment on the subscribed PR reaches exactly one session, fast", async () => {
  const t0 = Date.now();
  expect(await post(["--pr", "1", "--kind", "issue_comment", "--body", "thgis all needs to be changed", "--expect", "200"])).toBe(0);
  await waitFor(() => A.notes.length === 1);
  const latency = Date.now() - t0;
  await sleep(300);
  expect(B.notes.length).toBe(0);
  expect(latency).toBeLessThan(15_000);

  const meta = A.notes[0].meta;
  for (const k of ["event_id", "correlation_key", "kind", "actor", "actor_is_bot", "permalink"]) {
    expect(meta).toHaveProperty(k);
  }
  expect(meta.correlation_key).toBe(KEY);
  expect(A.notes[0].content).toContain("thgis all needs to be changed");
});

test("redelivery of the same comment is dropped", async () => {
  expect(await post(["--pr", "1", "--kind", "issue_comment", "--body", "thgis all needs to be changed"])).toBe(0);
  expect((post as any).last).toBe("duplicate");
  await sleep(300);
  expect(A.notes.length).toBe(1);
});

test("the agent's own reply coming back as a webhook is dropped", async () => {
  expect(await post(["--pr", "1", "--kind", "issue_comment", "--body", "<!-- agent-reply -->\nsure, which part?"])).toBe(0);
  expect((post as any).last).toBe("self-authored");
});

test("a stale delivery is rejected", async () => {
  expect(await post(["--pr", "1", "--kind", "issue_comment", "--body", "old news", "--age", "7200", "--expect", "422"])).toBe(0);
});

test("post_reply: owner only, once, on the event's PR, citing the permalink", async () => {
  const ev = A.notes[0].meta;
  const fromStandby = await B.tool("post_reply", { correlation_key: KEY, in_reply_to: ev.event_id, body: "me too" });
  expect(fromStandby.isError).toBe(true);
  expect(fromStandby.text).toContain("owned by another session");

  const wrongPr = await A.tool("post_reply", { correlation_key: `${REPO}#2`, in_reply_to: ev.event_id, body: "x" });
  expect(wrongPr.isError).toBe(true);

  const ok = await A.tool("post_reply", {
    correlation_key: KEY,
    in_reply_to: ev.event_id,
    body: "Which part? Point me at a file or line and I'll look.",
  });
  expect(ok.isError).toBe(false);

  const again = await A.tool("post_reply", { correlation_key: KEY, in_reply_to: ev.event_id, body: "dup" });
  expect(again.isError).toBe(true);
  expect(again.text).toContain("already has a reply");

  const files = readdirSync(REPLY_DIR);
  expect(files.length).toBe(1);
  const rec = JSON.parse(readFileSync(join(REPLY_DIR, files[0]), "utf8"));
  expect(rec.correlation_key).toBe(KEY);
  expect(rec.body.startsWith("<!-- agent-reply -->")).toBe(true);
  expect(rec.body).toContain(ev.permalink);
});

test("review summaries and inline comments are delivered too", async () => {
  expect(await post(["--pr", "1", "--kind", "review", "--body", "needs tests", "--expect", "200"])).toBe(0);
  expect(await post(["--pr", "1", "--kind", "review_comment", "--body", "off by one here", "--expect", "200"])).toBe(0);
  await waitFor(() => A.notes.length === 3);
  expect(A.notes.map((n) => n.meta.kind).slice(1)).toEqual(["review", "review_comment"]);
  expect(B.notes.length).toBe(0);
});

test("when the owner's session ends, the standby takes over", async () => {
  A.kill();
  await sleep(500);
  expect((await B.tool("list_subscriptions")).text).toContain("(owner)");
  expect(await post(["--pr", "1", "--kind", "issue_comment", "--body", "anyone there?", "--expect", "200"])).toBe(0);
  await waitFor(() => B.notes.length === 1);
});
