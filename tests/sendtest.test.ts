import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-sendtest-"));
const sinkPort = await freePort();
process.env.DATABASE_PATH = path.join(tmp, "sendtest.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.UPSTREAM_HOST = "127.0.0.1";
process.env.UPSTREAM_PORT = String(sinkPort);

const db = await import("../src/db/index.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

/** Stands in for Microsoft 365 on the return path. */
const delivered: Array<{ from: string; to: string[]; raw: string }> = [];
let sink: SMTPServer;
let app: FastifyInstance;
let cookieHeader = "";

beforeAll(async () => {
  db.initDb();
  sink = new SMTPServer({
    authOptional: true,
    hideSTARTTLS: true,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(c as Buffer));
      stream.on("end", () => {
        delivered.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString("utf8")
        });
        callback();
      });
    }
  });
  await new Promise<void>((resolve) => sink.listen(sinkPort, "127.0.0.1", resolve));

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
  sink.close();
  db.closeDb();
});

const post = (url: string, payload: object, withCookie = true) =>
  app.inject({ method: "POST", url, payload, headers: withCookie ? { cookie: cookieHeader } : {} });

describe("send test", () => {
  it("emails what the recipient would see, to the person running the test only", async () => {
    const res = await post("/api/tester/send", {
      from: "scott@inspired.co",
      to: "ada@contoso.example",
      subject: "Quarterly update",
      body: "Hello Ada"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sentTo: "it-admin@inspired.co" });

    const mail = delivered.at(-1)!;
    expect(mail.to).toEqual(["it-admin@inspired.co"]);
    expect(mail.from).toBe("scott@inspired.co");
    expect(mail.raw).toMatch(/^Subject: \[Signer test\] Quarterly update/m);
    // Already signed, so the provider's routing rule must not send it back through Signer.
    expect(mail.raw).toMatch(/^X-Signer-MessageProcessed: true/im);
    const parsed = await simpleParser(mail.raw);
    expect(parsed.html).toContain("Signer test: this is the message ada@contoso.example would receive from scott@inspired.co");
    expect(parsed.html).toContain("Marketing Director");
    expect(parsed.text).toContain("Hello Ada");
  });

  it("refuses a From address outside the organisation's domains", async () => {
    const res = await post("/api/tester/send", { from: "someone@elsewhere.example", to: "ada@contoso.example" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses anything that is not an email address", async () => {
    expect((await post("/api/tester/send", { from: "scott@inspired.co", to: "not an address" })).statusCode).toBe(400);
  });

  it("is closed to anonymous callers", async () => {
    expect((await post("/api/tester/send", { from: "scott@inspired.co", to: "a@b.example" }, false)).statusCode).toBe(401);
  });
});

describe("admin directory editing", () => {
  const put = (email: string, payload: object) =>
    app.inject({ method: "PUT", url: `/api/directory/users/${encodeURIComponent(email)}`, payload, headers: { cookie: cookieHeader } });

  it("lets an admin fill in fields the directory does not supply", async () => {
    const res = await put("scott@inspired.co", { pronouns: "he/him", linkedin: "https://linkedin.com/in/scott" });
    expect(res.statusCode).toBe(200);
    const user = db.getUserByEmail("scott@inspired.co")!;
    expect(user.pronouns).toBe("he/him");
    expect(user.linkedin).toBe("https://linkedin.com/in/scott");
  });

  it("refuses fields that come from Entra or Google", async () => {
    const res = await put("scott@inspired.co", { jobTitle: "CEO" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/jobTitle comes from Entra or Google/);
    expect(db.getUserByEmail("scott@inspired.co")!.jobTitle).toBe("Marketing Director");
  });

  it("returns 404 for someone not in the directory cache", async () => {
    expect((await put("nobody@inspired.co", { pronouns: "x" })).statusCode).toBe(404);
  });
});
