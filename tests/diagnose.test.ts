import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { SMTPServer } from "smtp-server";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-diagnose-"));
const relayPort = await freePort();
process.env.DATABASE_PATH = path.join(tmp, "diagnose.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.UPSTREAM_HOST = "127.0.0.1";
process.env.UPSTREAM_PORT = String(relayPort);
// The fake relay below uses smtp-server's built-in self-signed certificate.
process.env.UPSTREAM_TLS_REJECT_UNAUTHORIZED = "false";

const db = await import("../src/db/index.js");
const { config } = await import("../src/config.js");
const { diagnoseRelay } = await import("../src/smtp/diagnose.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

/** Stands in for Exchange Online: relays only when the inbound connector matches. */
let connectorMatches = true;
let delivered = 0;
const commands: string[] = [];
let relay: SMTPServer;
let app: FastifyInstance;
let cookieHeader = "";

beforeAll(async () => {
  db.initDb();
  relay = new SMTPServer({
    authOptional: true,
    onMailFrom(address, _session, callback) {
      commands.push(`MAIL ${address.address}`);
      callback();
    },
    onRcptTo(address, _session, callback) {
      commands.push(`RCPT ${address.address}`);
      if (!connectorMatches && !address.address.endsWith("@inspired.co")) {
        return callback(
          Object.assign(new Error("5.7.64 TenantAttribution; Relay Access Denied [SN1PEPF000252A1.namprd05.prod.outlook.com]"), {
            responseCode: 550
          })
        );
      }
      callback();
    },
    onData(stream, _session, callback) {
      delivered += 1;
      stream.resume();
      stream.on("end", () => callback());
    }
  });
  await new Promise<void>((resolve) => relay.listen(relayPort, "127.0.0.1", resolve));

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

afterAll(async () => {
  await app.close();
  relay.close();
  db.closeDb();
});

const statuses = (steps: Array<{ step: string; status: string }>) => steps.map((s) => `${s.status} ${s.step}`);

describe("return-path test", () => {
  it("walks the whole conversation, upgrades to TLS, and stops before DATA", async () => {
    connectorMatches = true;
    commands.length = 0;
    const result = await diagnoseRelay({ domain: "inspired.co", internalRecipient: "it-admin@inspired.co" });
    expect(result.ok).toBe(true);
    expect(statuses(result.steps)).toEqual([
      "ok Look up the return host",
      `ok Connect to port ${relayPort}`,
      "ok Greeting",
      "ok EHLO",
      "ok STARTTLS",
      "ok EHLO over TLS",
      "ok MAIL FROM postmaster@inspired.co",
      "ok RCPT TO it-admin@inspired.co (internal)",
      "ok RCPT TO signer-relay-check@example.com (external)"
    ]);
    expect(result.steps[1]!.detail).toMatch(/from 127\.0\.0\.1$/);
    expect(result.steps[4]!.detail).toMatch(/^TLSv1\.[23], certificate/);
    expect(result.target).toMatchObject({ host: "127.0.0.1", port: relayPort, via: "default", tls: "STARTTLS", auth: false });
    expect(commands).toEqual(["MAIL postmaster@inspired.co", "RCPT it-admin@inspired.co", "RCPT signer-relay-check@example.com"]);
    expect(delivered).toBe(0);
  });

  it("pins down 550 5.7.64: delivery inside the organisation works, relaying out does not", async () => {
    connectorMatches = false;
    const result = await diagnoseRelay({ domain: "inspired.co", internalRecipient: "it-admin@inspired.co" });
    expect(result.ok).toBe(false);
    const rcpt = result.steps.filter((s) => s.step.startsWith("RCPT"));
    expect(rcpt.map((s) => s.status)).toEqual(["ok", "fail"]);
    expect(rcpt[1]!.detail).toMatch(/550 5\.7\.64 TenantAttribution/);
    expect(result.hint).toMatch(/"Signer receive" inbound connector exists, is enabled/);
    expect(delivered).toBe(0);
  });

  it("reports a refused connection with what to check", async () => {
    const original = config.upstream.port;
    config.upstream.port = await freePort();
    try {
      const result = await diagnoseRelay({ domain: "inspired.co" });
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({ step: `Connect to port ${config.upstream.port}`, status: "fail" });
      expect(result.hint).toMatch(/refused the connection/);
    } finally {
      config.upstream.port = original;
    }
  });

  it("points at the hosting provider's SMTP block when the server never answers", async () => {
    const silent = net.createServer(() => {
      /* accept, then say nothing, like a filtered port 25 */
    });
    const port = await freePort();
    await new Promise<void>((resolve) => silent.listen(port, "127.0.0.1", resolve));
    const original = config.upstream.port;
    config.upstream.port = port;
    try {
      const result = await diagnoseRelay({ domain: "inspired.co", timeoutMs: 300 });
      expect(result.steps.at(-1)).toMatchObject({ step: "Greeting", status: "fail" });
      expect(result.hint).toMatch(/Linode and most hosts block outbound ports 25, 465 and 587/);
    } finally {
      config.upstream.port = original;
      silent.close();
    }
  });
});

describe("POST /api/diagnostics/relay", () => {
  const post = (payload: object, withCookie = true) =>
    app.inject({ method: "POST", url: "/api/diagnostics/relay", payload, headers: withCookie ? { cookie: cookieHeader } : {} });

  it("tests the primary domain as the admin, with their own mailbox as the internal recipient", async () => {
    connectorMatches = true;
    commands.length = 0;
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, domain: "inspired.co", sender: "it-admin@inspired.co" });
    expect(commands).toEqual(["MAIL it-admin@inspired.co", "RCPT it-admin@inspired.co", "RCPT signer-relay-check@example.com"]);
  });

  it("uses the outside address given", async () => {
    commands.length = 0;
    expect((await post({ externalRecipient: "Someone@Gmail.com" })).statusCode).toBe(200);
    expect(commands.at(-1)).toBe("RCPT someone@gmail.com");
  });

  it("refuses an 'outside' address on one of your own domains, since that proves nothing", async () => {
    const res = await post({ externalRecipient: "bob@inspired.co" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/outside your organisation/);
  });

  it("refuses domains that are not on the list", async () => {
    expect((await post({ domain: "elsewhere.example" })).statusCode).toBe(400);
  });

  it("is for admins only", async () => {
    expect((await post({}, false)).statusCode).toBe(401);
  });
});
