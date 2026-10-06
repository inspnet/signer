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

describe("alerting on deferred and unsigned mail", () => {
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("alerts on the first problem straight away, then batches until the interval passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure();
    const relayDown =
      "Signed, but handing it back failed: inspired-co.mail.protection.outlook.com:25 (the domain's MX): Connection timeout — Could not reach it.";

    alerts.noteMailOutcome("deferred", relayDown, "scott@inspired.co");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.form.get("subject")).toBe("Signer: 1 message with problems (1 deferred) on signer.inspired.co");
    const first = sent[0]!.form.get("text")!;
    expect(first).toContain("1× Deferred (from inspired.co): Signed, but handing it back failed");
    expect(first).toContain("Test the return path: https://signer.inspired.co/settings#return-path");

    alerts.noteMailOutcome("deferred", relayDown, "ada@inspired.co");
    alerts.noteMailOutcome("error", "Signing failed: 550 5.1.1 <bob@contoso.example>: Recipient rejected. Delivered without a signature.", "sam@belzbergco.example");
    alerts.noteMailOutcome("signed", "", "scott@inspired.co"); // problems still waiting: no recovery yet
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.form.get("subject")).toBe("Signer: 2 messages with problems (1 deferred, 1 unsigned) on signer.inspired.co");
    const second = sent[1]!.form.get("text")!;
    expect(second).toContain("Unsigned (from belzbergco.example): Signing failed: 550 5.1.1 <[address]>");
    expect(second).not.toContain("bob@contoso.example");
  });

  it("sends one recovery email when mail flows again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure();
    alerts.noteMailOutcome("deferred", "Connection timeout", "scott@inspired.co");
    await settle();
    alerts.noteMailOutcome("signed", "", "scott@inspired.co");
    alerts.noteMailOutcome("signed", "", "ada@inspired.co");
    await settle();
    expect(sent.map((s) => s.form.get("subject"))).toEqual([
      "Signer: 1 message with problems (1 deferred) on signer.inspired.co",
      "Signer: mail is flowing again on signer.inspired.co"
    ]);
  });

  it("stays quiet when alerts are off, and for healthy mail", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configure({ enabled: false });
    alerts.noteMailOutcome("deferred", "Connection timeout", "scott@inspired.co");
    configure();
    alerts.noteMailOutcome("signed", "", "scott@inspired.co");
    alerts.noteMailOutcome("passed-through", "No matching signature", "scott@inspired.co");
    await settle();
    expect(sent).toHaveLength(0);
  });
});
