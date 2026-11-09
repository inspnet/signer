import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-tenant-"));
process.env.DATABASE_PATH = path.join(tmp, "tenant.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { config } = await import("../src/config.js");
const { mailTenant, lookupTenantId, resolveEntraTenant, saveMailTenant } = await import("../src/smtp/tenant.js");
const { fromOwnTenant } = await import("../src/smtp/accept.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

const BELZBERG = "044e81ba-a7f3-4100-a7c1-d689e787b7e6";

/** Stands in for login.microsoftonline.com's OpenID metadata. */
const asked: string[] = [];
const microsoft = (async (input: string | URL) => {
  const url = String(input);
  asked.push(url);
  if (/\/(belzbergco\.com|belzbergco\.onmicrosoft\.com)\/v2\.0\/\.well-known\/openid-configuration$/.test(url)) {
    return new Response(JSON.stringify({ issuer: `https://login.microsoftonline.com/${BELZBERG}/v2.0` }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: "invalid_tenant" }), { status: 400 });
}) as typeof fetch;

const reply = Buffer.from(
  [
    `X-MS-Exchange-CrossTenant-Id: ${BELZBERG}`,
    "X-MS-Exchange-CrossTenant-AuthAs: Internal",
    "From: Ada <ada@belzbergco.com>",
    "Subject: Automatic reply",
    "",
    "Away."
  ].join("\r\n")
);

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

afterAll(async () => {
  await app.close();
  db.closeDb();
});

beforeEach(() => {
  asked.length = 0;
  db.setSetting("mail_tenant_id", "");
  db.setSetting("mail_tenant_lookup", "null");
  config.entra.tenantId = "";
});

describe("the tenant ID behind your automatic mail", () => {
  it("uses ENTRA_TENANT_ID when it is the ID", () => {
    config.entra.tenantId = BELZBERG.toUpperCase();
    expect(mailTenant()).toMatchObject({ id: BELZBERG, source: "entra" });
    expect(fromOwnTenant(reply, "")).toBe(true);
  });

  it("looks it up once when ENTRA_TENANT_ID is a domain, and keeps it", async () => {
    config.entra.tenantId = "belzbergco.onmicrosoft.com";
    expect(fromOwnTenant(reply, "")).toBe(false);
    await resolveEntraTenant(microsoft);
    expect(mailTenant()).toMatchObject({ id: BELZBERG, source: "lookup" });
    expect(fromOwnTenant(reply, "")).toBe(true);
    await resolveEntraTenant(microsoft);
    expect(asked).toHaveLength(1);
    // A different ENTRA_TENANT_ID does not reuse it.
    config.entra.tenantId = "contoso.onmicrosoft.com";
    expect(mailTenant().source).toBe("none");
  });

  it("can be set in the portal, by ID or by a domain, ahead of ENTRA_TENANT_ID, and cleared", async () => {
    config.entra.tenantId = "9b5650ea-7824-4093-8abe-d0ddbec2a6da";
    expect(await saveMailTenant("belzbergco.com", microsoft)).toMatchObject({ id: BELZBERG, source: "settings" });
    expect(fromOwnTenant(reply, "")).toBe(true);
    expect(await saveMailTenant(` ${BELZBERG.toUpperCase()} `, microsoft)).toMatchObject({ id: BELZBERG, source: "settings" });
    expect(await saveMailTenant("", microsoft)).toMatchObject({ source: "entra" });
    expect(fromOwnTenant(reply, "")).toBe(false);
  });

  it("says why a value cannot be used", async () => {
    await expect(lookupTenantId("not a domain", microsoft)).rejects.toThrow(/tenant ID, or one of the tenant's domains/);
    await expect(lookupTenantId("example.org", microsoft)).rejects.toThrow(/does not know example\.org/);
    expect(asked.every((u) => u.startsWith("https://login.microsoftonline.com/"))).toBe(true);
  });

  it("is shown and saved under Settings → Domains", async () => {
    vi.stubGlobal("fetch", microsoft);
    try {
      const saved = await app.inject({ method: "PUT", url: "/api/tenant", payload: { value: "belzbergco.com" }, headers: { cookie: cookieHeader } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ id: BELZBERG, source: "settings" });
      const domains = await app.inject({ method: "GET", url: "/api/domains", headers: { cookie: cookieHeader } });
      expect(domains.json().tenant).toMatchObject({ id: BELZBERG, source: "settings" });
      const bad = await app.inject({ method: "PUT", url: "/api/tenant", payload: { value: "example.org" }, headers: { cookie: cookieHeader } });
      expect(bad.statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/tenant", payload: { value: BELZBERG } })).statusCode).toBe(401);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
