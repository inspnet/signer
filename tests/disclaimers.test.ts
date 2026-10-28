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
  it("always leaves a set space, and gives paragraphs their own margins", () => {
    const html = testSignature({ from: "scott@inspired.co", to: "ada@contoso.example" }).htmlPreview;
    expect(html).toContain(
      '<div style="height:8pt;line-height:8pt;font-size:1px;mso-line-height-rule:exactly;">&nbsp;</div><div style="font-family:Aptos'
    );
    expect(html).toContain('<p style="margin:0 0 4pt 0;">Inspired Ltd, registered in England.</p>');
  });
});

describe("disclaimer text and spacing settings", () => {
  it("sets the base font, size, colour and line height, and the spacing, from the disclaimer's style", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/disclaimers",
      headers: { cookie: cookieHeader },
      payload: {
        name: "Styled",
        html: "<p>One</p><p>Two<br>still two</p>",
        style: { fontFamily: "Arial, sans-serif", fontSize: 8, color: "#6b7280", lineHeight: 1.15, paragraphSpacing: 0, spaceAbove: 0, junk: "x" },
        rules: { senders: { everyone: true }, senderExceptions: {}, recipients: { any: true }, dateTime: null, advanced: { bodySearch: "anywhere", ifNotApplied: "continue" } }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().style).toEqual({ fontFamily: "Arial, sans-serif", fontSize: 8, color: "#6b7280", lineHeight: 1.15, paragraphSpacing: 0, spaceAbove: 0 });
    const html = testSignature({ from: "scott@inspired.co", to: "ada@contoso.example" }).htmlPreview;
    expect(html).toContain(
      '<div style="font-family:Arial, sans-serif;font-size:8pt;color:#6b7280;line-height:115%;"><p style="margin:0 0 0pt 0;">One</p><p style="margin:0 0 0pt 0;">Two<br>still two</p></div>'
    );
    db.deleteDisclaimer(res.json().id);
  });

  it("keeps margins the HTML sets, and refuses values that would break out of the style", async () => {
    const { spaceParagraphs, cleanDisclaimerStyle } = await import("../src/mail/disclaimer.js");
    expect(spaceParagraphs('<p style="margin:12px 0">A</p><div style="color:red">B</div><ul><li>C</li></ul>', 6)).toBe(
      '<p style="margin:12px 0">A</p><div style="margin:0 0 6pt 0;color:red">B</div><ul style="margin:0 0 6pt 0;padding-left:20px;"><li>C</li></ul>'
    );
    expect(cleanDisclaimerStyle({ fontFamily: 'Arial;}" onload="x', color: "red;", fontSize: 500, spaceAbove: -4 })).toEqual({
      fontFamily: "Arial onload=x",
      fontSize: 36,
      spaceAbove: 0
    });
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