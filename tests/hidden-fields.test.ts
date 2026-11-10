import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-hidden-"));
process.env.DATABASE_PATH = path.join(tmp, "hidden.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "dirocco@belzbergco.com";
process.env.PRIMARY_DOMAIN = "belzbergco.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { emptyUser } = await import("../src/directory/fields.js");
const { senderProfile, linkMailbox } = await import("../src/directory/links.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

const DARA = "dirocco@belzbergco.com";
const person = (email: string, id: string, extra: object = {}) =>
  db.upsertDirectoryUser({
    ...emptyUser(email),
    id,
    displayName: "Dara Di Rocco",
    source: "entra",
    directoryId: id,
    domain: email.split("@")[1]!,
    mobile: "+1 604 555 0100",
    fax: "+1 604 555 0199",
    ...extra
  });

let app: FastifyInstance;
let cookieHeader = "";
const call = (method: "GET" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: cookieHeader } });

beforeAll(async () => {
  db.initDb();
  person(DARA, "dara");
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

describe("letting people hide fields from their signature", () => {
  it("is off until an admin allows it, field by field, and never for email", async () => {
    expect((await call("GET", "/api/fields")).json().find((f: { key: string }) => f.key === "mobile")).toMatchObject({ userHideable: false });
    await call("PUT", "/api/me/details", { hiddenFields: ["mobile"] });
    expect(senderProfile(DARA)!.mobile).toBe("+1 604 555 0100");

    const saved = await call("PUT", "/api/fields", { editable: ["pronouns"], hideable: ["mobile", "email"] });
    expect(saved.statusCode).toBe(200);
    const fields = (await call("GET", "/api/fields")).json() as { key: string; userEditable: boolean; userHideable: boolean }[];
    expect(fields.filter((f) => f.userHideable).map((f) => f.key)).toEqual(["mobile"]);
    expect(fields.find((f) => f.key === "pronouns")).toMatchObject({ userEditable: true });
  });

  it("leaves the field out of what mail is signed with, and keeps the value", async () => {
    const res = await call("PUT", "/api/me/details", { pronouns: "she/her", hiddenFields: ["mobile", "fax"] });
    expect(res.statusCode).toBe(200);
    const mine = (await call("GET", "/api/me/details")).json();
    // Fax may not be hidden, so only mobile is kept.
    expect(mine.hiddenFields).toEqual(["mobile"]);
    expect(mine.user.mobile).toBe("+1 604 555 0100");
    expect(senderProfile(DARA)).toMatchObject({ mobile: "", fax: "+1 604 555 0199", pronouns: "she/her" });
  });

  it("applies to a linked mailbox, and survives a directory sync", () => {
    person("ddirocco@balfourpacific.com", "dara-balfour", { displayName: "Dara Di Rocco - Balfour Pacific", mobile: "" });
    linkMailbox("ddirocco@balfourpacific.com", DARA);
    expect(senderProfile("ddirocco@balfourpacific.com")).toMatchObject({ email: "ddirocco@balfourpacific.com", mobile: "", fax: "+1 604 555 0199" });
    person(DARA, "dara", { mobile: "+1 604 555 0123" });
    expect(senderProfile(DARA)!.mobile).toBe("");
  });

  it("shows the field again when an admin stops allowing it", async () => {
    await call("PUT", "/api/fields", { editable: ["pronouns"], hideable: [] });
    expect(senderProfile(DARA)!.mobile).toBe("+1 604 555 0123");
    // Saving editable fields alone leaves Hide as it is.
    await call("PUT", "/api/fields", { editable: ["pronouns"], hideable: ["mobile"] });
    await call("PUT", "/api/fields", { editable: ["pronouns", "website"] });
    expect(senderProfile(DARA)!.mobile).toBe("");
  });
});
