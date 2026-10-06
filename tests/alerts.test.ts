import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-alerts-"));
process.env.DATABASE_PATH = path.join(tmp, "alerts.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.PUBLIC_URL = "https://signer.inspired.co";
process.env.SMTP_HOSTNAME = "signer.inspired.co";

const db = await import("../src/db/index.js");
const alerts = await import("../src/alerts/index.js");
const { sameFailure } = await import("../src/smtp/explain.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

type Sent = { url: string; auth: string; form: URLSearchParams };
let sent: Sent[] = [];
let mailgunStatus = 200;

/** Stands in for api.mailgun.net. */
function stubMailgun() {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization") ?? "",
      form: new URLSearchParams(String(init?.body))
    });
    return mailgunStatus === 200
      ? new Response(JSON.stringify({ id: "<20261006.1@mg.inspired.co>", message: "Queued. Thank you." }), { status: 200 })
      : new Response("Forbidden", { status: mailgunStatus });
  });
}

let app: FastifyInstance;
let cookieHeader = "";

beforeAll(async () => {
  db.initDb();
  app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);
  registerAuthRoutes(app);
  registerApi(app);
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/auth/dev-login" });
  cookieHeader = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
});

beforeEach(() => {
  sent = [];
  mailgunStatus = 200;
  stubMailgun();
  alerts.resetAlertState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  db.closeDb();
});

const call = (method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie: cookieHeader } });

const configure = (over: Partial<Parameters<typeof alerts.saveAlertSettings>[0]> = {}) =>
  alerts.saveAlertSettings({
    enabled: true,
    domain: "mg.inspired.co",
    region: "us",
    apiKey: "key-123",
    from: "",
    recipients: ["it-admin@inspired.co", "ops@inspired.co"],
    intervalMinutes: 15,
    ...over
  });

describe("Settings → Alerts API", () => {
  it("never sends the API key back, and keeps it when the field is left empty", async () => {
    const saved = await call("PUT", "/api/alerts", {
      enabled: true,
      domain: "MG.Inspired.co",
      region: "eu",
      apiKey: "key-secret",
      recipients: "it-admin@inspired.co, ops@inspired.co"
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body).toMatchObject({ enabled: true, domain: "mg.inspired.co", region: "eu", apiKeySet: true, recipients: ["it-admin@inspired.co", "ops@inspired.co"] });
    expect(JSON.stringify(body)).not.toContain("key-secret");

    expect((await call("PUT", "/api/alerts", { intervalMinutes: 30, apiKey: "" })).statusCode).toBe(200);
    expect(alerts.alertSettings()).toMatchObject({ apiKey: "key-secret", intervalMinutes: 30 });
  });

  it("refuses incomplete or invalid settings", async () => {
    expect((await call("PUT", "/api/alerts", { recipients: "not-an-address" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/alerts", { domain: "not a domain" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/alerts", { intervalMinutes: 1 })).statusCode).toBe(400);
    configure({ apiKey: "", enabled: false });
    expect((await call("PUT", "/api/alerts", { enabled: true })).json().error).toMatch(/need a Mailgun domain, an API key/);
  });

  it("sends a test through Mailgun's HTTP API, in the chosen region", async () => {
    configure({ region: "eu", enabled: false });
    const res = await call("POST", "/api/alerts/test");
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.eu.mailgun.net/v3/mg.inspired.co/messages");
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from("api:key-123").toString("base64")}`);
    expect(sent[0]!.form.getAll("to")).toEqual(["it-admin@inspired.co", "ops@inspired.co"]);
    expect(sent[0]!.form.get("from")).toBe("Signer alerts <signer@mg.inspired.co>");
    expect(sent[0]!.form.get("subject")).toBe("Signer test alert (signer.inspired.co)");
    expect(alerts.lastAlert()).toMatchObject({ ok: true, kind: "test" });
  });

  it("explains a refused key", async () => {
    configure();
    mailgunStatus = 401;
    const res = await call("POST", "/api/alerts/test");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Mailgun answered 401.*Check the API key/);
    expect(alerts.lastAlert()).toMatchObject({ ok: false, kind: "test" });
  });

  it("is for admins only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/alerts" })).statusCode).toBe(401);
  });
});

describe("the same relay refusal", () => {
  it("is one failure when only the request id and timestamp differ", () => {
    const a =
      "550 5.7.1 Service unavailable, Client host [2600:3c04::1] blocked using Spamhaus. [HOST 2026-10-06T04:38:21.563Z 08DF22EBF2CE750]";
    const b =
      "550 5.7.1 Service unavailable, Client host [2600:3c04::1] blocked using Spamhaus. [HOST 2026-10-06T04:38:22.100Z 08DF22FF746BD5DE]";
    expect(sameFailure(new Error(a), new Error(b))).toBe(true);
    expect(sameFailure(new Error(a), new Error("connect ECONNREFUSED 127.0.0.1:25"))).toBe(false);
  });
});

describe("alerting when mail is not sending", () => {
  const relayDown =
    "Signed, but handing it back failed: inspired-co.mail.protection.outlook.com:25 (the domain's MX): 550 5.7.1 Service unavailable, Client host [2600:3c04::1] blocked using Spamhaus. [YT1PEPF000001EBB 2026-10-06T04:38:21.563Z 08DF22EBF2CE750] — Microsoft 365 is refusing this server's IP address as a sender.";

  it("stays quiet until messages have failed to send for the whole interval, and counts one refusal once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure();

    alerts.noteMailOutcome("deferred", relayDown, "scott@inspired.co");
    alerts.noteMailOutcome(
      "deferred",
      relayDown.replace("08DF22EBF2CE750", "08DF22FF746BD5DE").replace("04:38:21.563Z", "04:38:22.100Z"),
      "ada@inspired.co"
    );
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.form.get("subject")).toBe("Signer: mail has not been sending for 15 minutes on signer.inspired.co");
    const text = sent[0]!.form.get("text")!;
    expect(text).toContain("2× Deferred (from inspired.co): Signed, but handing it back failed");
    expect(text.match(/Deferred \(from/g)).toHaveLength(1);
    expect(text).toContain("Test the return path: https://signer.inspired.co/settings#return-path");
    expect(text).not.toContain("scott@inspired.co");
  });

  it("sends one alert for an outage, then one recovery when a message is delivered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure();
    alerts.noteMailOutcome("deferred", "Connection timeout", "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    alerts.noteMailOutcome("deferred", "Connection timeout", "ada@inspired.co");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sent).toHaveLength(1);

    alerts.noteMailOutcome("signed", "", "scott@inspired.co");
    alerts.noteMailOutcome("signed", "", "ada@inspired.co");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.form.get("subject"))).toEqual([
      "Signer: mail has not been sending for 15 minutes on signer.inspired.co",
      "Signer: mail is flowing again on signer.inspired.co"
    ]);
  });

  it("does not alert when a message is delivered before the interval ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure();
    alerts.noteMailOutcome("deferred", "Connection timeout", "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    alerts.noteMailOutcome("passed-through", "No matching signature", "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toHaveLength(0);
  });

  it("stays quiet when alerts are off, and for healthy mail", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure({ enabled: false });
    alerts.noteMailOutcome("deferred", "Connection timeout", "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    configure();
    alerts.noteMailOutcome("signed", "", "scott@inspired.co");
    alerts.noteMailOutcome("passed-through", "No matching signature", "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sent).toHaveLength(0);
  });
});

describe("alerting when Signer refuses a message", () => {
  const dmarcFail = "DMARC did not pass for inspired.co (spf=fail, dkim=none)";

  it("alerts about a minute after the first refusal, gathering the others in that minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure();
    alerts.noteMailOutcome("rejected", dmarcFail, "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(30_000);
    alerts.noteMailOutcome("rejected", dmarcFail, "ada@inspired.co");
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.form.get("subject")).toBe("Signer: refused 2 messages on signer.inspired.co");
    const text = sent[0]!.form.get("text")!;
    expect(text).toContain("2× (from inspired.co): DMARC did not pass for inspired.co");
    expect(text).toContain("bounce");
    expect(text).not.toContain("scott@inspired.co");
    expect(alerts.lastAlert()).toMatchObject({ ok: true, kind: "refusal" });
  });

  it("sends at most one refusal alert per interval, and does not start the outage alert", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure();
    alerts.noteMailOutcome("rejected", dmarcFail, "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);

    alerts.noteMailOutcome("rejected", dmarcFail, "ada@inspired.co");
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.form.get("subject")).toBe("Signer: refused 1 message on signer.inspired.co");

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(2);
  });

  it("stays quiet when alerts are off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure({ enabled: false });
    alerts.noteMailOutcome("rejected", dmarcFail, "scott@inspired.co");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent).toHaveLength(0);
  });
});
