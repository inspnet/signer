import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-disclaimers-"));
process.env.DATABASE_PATH = path.join(tmp, "disclaimers.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { testSignature } = await import("../src/mail/process.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

let app: FastifyInstance;
let cookieHeader = "";

beforeAll(async () => {
  db.initDb();
  db.addDomain("belzbergco.example", "it-admin@inspired.co");
  // Start from no disclaimers, so only the ones below can apply.
  for (const d of db.listDisclaimers()) db.deleteDisclaimer(d.id);

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
  db.closeDb();
});

const rules = (senders: object, recipients: object) => ({
  senders,
  senderExceptions: {},
  recipients,
  dateTime: null,
  advanced: { bodySearch: "anywhere" as const, ifNotApplied: "continue" as const }
});

const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { cookie: cookieHeader } });
const names = (from: string, to: string) => testSignature({ from, to }).disclaimers.map((d) => d.name);

describe("disclaimers by domain", () => {
  it("saves a disclaimer's rules through the API", async () => {
    const inspired = await post("/api/disclaimers", {
      name: "Inspired Ltd notice",
      html: "<p>Inspired Ltd, registered in England.</p>",
      enabled: true,
      rules: rules({ domains: ["inspired.co"] }, { any: true })
    });
    expect(inspired.statusCode).toBe(200);
    expect(inspired.json().rules.senders).toEqual({ domains: ["inspired.co"] });

    const belzberg = await post("/api/disclaimers", {
      name: "Belzberg confidentiality",
      html: "<p>Belzberg & Co. Confidential.</p>",
      enabled: true,
      rules: rules({ domains: ["belzbergco.example"] }, { external: true })
    });
    expect(belzberg.statusCode).toBe(200);
  });

  it("adds each domain's own disclaimer, and only that one", () => {
    expect(names("scott@inspired.co", "ada@contoso.example")).toEqual(["Inspired Ltd notice"]);
    expect(names("sam@belzbergco.example", "ada@contoso.example")).toEqual(["Belzberg confidentiality"]);
  });

  it("applies the other rules too: the Belzberg notice is for external recipients only", () => {
    expect(names("sam@belzbergco.example", "colleague@belzbergco.example")).toEqual([]);
    expect(names("sam@belzbergco.example", "scott@inspired.co")).toEqual([]);
  });

  it("keeps rules when an edit sends them back unchanged", async () => {
    const existing = db.listDisclaimers().find((d) => d.name === "Belzberg confidentiality")!;
    const res = await post("/api/disclaimers", { ...existing, name: "Belzberg & Co. confidentiality", enabled: true });
    expect(res.json().rules.recipients).toEqual({ external: true });
    expect(names("sam@belzbergco.example", "ada@contoso.example")).toEqual(["Belzberg & Co. confidentiality"]);
  });
});

describe("between the signature and the disclaimer", () => {
  it("always leaves a line break", () => {
    const html = testSignature({ from: "scott@inspired.co", to: "ada@contoso.example" }).htmlPreview;
    expect(html).toContain("<br><p>Inspired Ltd, registered in England.</p>");
  });
});

describe("GET /api/domains/names", () => {
  it("lists the organisation's domains, primary first, for the rule editors", async () => {
    const res = await app.inject({ method: "GET", url: "/api/domains/names", headers: { cookie: cookieHeader } });
    expect(res.json()).toEqual(["inspired.co", "belzbergco.example"]);
  });

  it("requires sign-in", async () => {
    expect((await app.inject({ method: "GET", url: "/api/domains/names" })).statusCode).toBe(401);
  });
});