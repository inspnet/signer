import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-domains-"));
process.env.DATABASE_PATH = path.join(tmp, "domains.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { processRawMessage, testSignature } = await import("../src/mail/process.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");
const { emptyUser } = await import("../src/directory/fields.js");

function freshDb(): void {
  db.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  db.initDb();
}

function message(from: string, to: string): Buffer {
  return Buffer.from(
    [`From: ${from}`, `To: ${to}`, "Subject: Hello", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Hello there", ""].join(
      "\r\n"
    )
  );
}

describe("domain names", () => {
  it("normalises case, a leading @ and a trailing dot", () => {
    expect(db.normalizeDomain(" @Contoso.COM. ")).toBe("contoso.com");
    expect(db.normalizeDomain("mail.contoso.co.uk")).toBe("mail.contoso.co.uk");
    expect(db.normalizeDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("rejects things that are not domains", () => {
    for (const bad of ["", "contoso", "contoso.", "-contoso.com", "con toso.com", "http://contoso.com", "a@b.com", "*.contoso.com"]) {
      expect(db.normalizeDomain(bad)).toBeNull();
    }
  });
});

describe("the domain list", () => {
  beforeEach(freshDb);

  it("starts with PRIMARY_DOMAIN as the primary domain", () => {
    const domains = db.listDomains();
    expect(domains[0]).toMatchObject({ name: "inspired.co", primary: true, addedBy: "setup" });
  });

  it("adds, de-duplicates and removes secondary domains", () => {
    db.addDomain("Contoso.com", "admin@inspired.co");
    db.addDomain("contoso.com", "admin@inspired.co");
    expect(db.domainNames().sort()).toEqual(["contoso.com", "inspired.co"]);
    db.removeDomain("contoso.com");
    expect(db.domainNames()).toEqual(["inspired.co"]);
  });

  it("keeps exactly one primary, and will not remove it", () => {
    db.addDomain("contoso.com", "admin@inspired.co");
    expect(() => db.removeDomain("inspired.co")).toThrow(db.DomainError);
    db.setPrimaryDomain("contoso.com");
    const primaries = db.listDomains().filter((d) => d.primary);
    expect(primaries.map((d) => d.name)).toEqual(["contoso.com"]);
    db.removeDomain("inspired.co");
    expect(db.domainNames()).toEqual(["contoso.com"]);
  });

  it("refuses invalid and unknown domains with a readable error", () => {
    expect(() => db.addDomain("not a domain", "x")).toThrow(/not a valid domain/);
    expect(() => db.removeDomain("nowhere.example")).toThrow(/not in the domain list/);
    expect(() => db.setPrimaryDomain("nowhere.example")).toThrow(/not in the domain list/);
  });
});

describe("what the domain list controls", () => {
  beforeEach(freshDb);

  it("signs senders on a listed domain", async () => {
    const result = await processRawMessage(message("scott@inspired.co", "ada@partner.example"), "scott@inspired.co", ["ada@partner.example"]);
    expect(result.skipped).toBe(false);
  });

  it("passes mail from other domains through untouched, and says why", async () => {
    const raw = message("someone@unlisted.example", "ada@partner.example");
    const result = await processRawMessage(raw, "someone@unlisted.example", ["ada@partner.example"]);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/unlisted\.example is not one of this organisation's domains/);
    expect(result.raw.toString("utf8")).toContain("Hello there");
    expect(result.raw.toString("utf8")).not.toContain("Marketing Director");
  });

  it("explains the skip in the rule tester", () => {
    const test = testSignature({ from: "someone@unlisted.example", to: "ada@partner.example" });
    expect(test.signature).toBeNull();
    expect(test.details[0]).toMatchObject({ kind: "domain", applied: false });
  });

  it("signs a second domain once it is added", async () => {
    db.addDomain("inspired-labs.example", "admin@inspired.co");
    const result = await processRawMessage(
      message("scott@inspired-labs.example", "ada@partner.example"),
      "scott@inspired-labs.example",
      ["ada@partner.example"]
    );
    expect(result.skipped).toBe(false);
  });

  it("treats recipients on any listed domain as internal, and nobody else", () => {
    const rules = { ...db.defaultRules(), recipients: { internal: true } };
    const sig = db.listSignatures()[0]!;
    db.saveSignatureRules(sig.id, rules);
    db.addDomain("inspired-labs.example", "admin@inspired.co");
    // A guest-like directory entry on a partner domain must not make that domain internal.
    const guest = emptyUser("bob@partner.example");
    guest.id = "entra:guest";
    guest.source = "entra";
    db.upsertDirectoryUser(guest);

    const toSecondary = testSignature({ from: "scott@inspired.co", to: "colleague@inspired-labs.example" });
    const toPartner = testSignature({ from: "scott@inspired.co", to: "bob@partner.example" });
    expect(toSecondary.signature?.id).toBe(sig.id);
    expect(toPartner.signature?.id).not.toBe(sig.id);
  });
});

describe("domains API", () => {
  let app: FastifyInstance;
  let cookieHeader = "";

  beforeAll(async () => {
    freshDb();
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

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: cookieHeader } });

  it("lists domains and suggests directory domains that are missing", async () => {
    const user = emptyUser("pat@subsidiary.example");
    user.id = "entra:pat";
    user.source = "entra";
    db.upsertDirectoryUser(user);
    const res = await call("GET", "/api/domains");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { domains: { name: string }[]; suggestions: { domain: string; people: number }[] };
    expect(body.domains.map((d) => d.name)).toContain("inspired.co");
    expect(body.suggestions).toContainEqual({ domain: "subsidiary.example", people: 1 });
  });

  it("adds, promotes and removes through the API, and rejects bad input with 400", async () => {
    expect((await call("POST", "/api/domains", { name: "subsidiary.example" })).statusCode).toBe(200);
    expect((await call("POST", "/api/domains", { name: "nope" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/domains/subsidiary.example/primary")).statusCode).toBe(200);
    expect((await call("DELETE", "/api/domains/subsidiary.example")).statusCode).toBe(400);
    expect((await call("DELETE", "/api/domains/inspired.co")).statusCode).toBe(200);
    expect(db.domainNames()).toEqual(["subsidiary.example"]);
  });

  it("requires a signed-in admin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/domains" });
    expect(res.statusCode).toBe(401);
  });
});
