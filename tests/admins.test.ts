import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { SignJWT } from "jose";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-admins-"));
process.env.DATABASE_PATH = path.join(tmp, "admins.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

const COOKIE = "signer_session";

let app: FastifyInstance;
let superAdmin = "";

/** A signed-in session for anyone; the role itself is looked up on every request. */
async function sessionFor(email: string): Promise<string> {
  const secret = new Uint8Array(createHash("sha256").update(process.env.SESSION_SECRET!).digest());
  const token = await new SignJWT({ email, name: email, provider: "entra", role: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  return `${COOKIE}=${token}`;
}

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
  superAdmin = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
});

beforeEach(() => {
  for (const r of db.listAdminRoles()) db.removeAdminRole(r.email);
  db.setAdminRole("alex@inspired.co", "admin", "setup");
  db.setAdminRole("olive@inspired.co", "owner", "setup");
  db.setAdminRole("ed@inspired.co", "editor", "setup");
});

afterAll(async () => {
  await app.close();
  db.closeDb();
});

const put = (as: string, email: string, role: string) =>
  app.inject({ method: "PUT", url: "/api/admins", payload: { email, role }, headers: { cookie: as } });
const del = (as: string, email: string) =>
  app.inject({ method: "DELETE", url: `/api/admins/${encodeURIComponent(email)}`, headers: { cookie: as } });
const roleOf = (email: string) => db.resolveRole(email);

describe("changing and removing roles", () => {
  it("lets an admin change someone's role, and remove it", async () => {
    const alex = await sessionFor("alex@inspired.co");
    expect((await put(alex, "ed@inspired.co", "designer")).statusCode).toBe(200);
    expect(roleOf("ed@inspired.co")).toBe("designer");
    expect((await del(alex, "ED@inspired.co")).statusCode).toBe(200);
    expect(roleOf("ed@inspired.co")).toBe("user");
    expect(db.listAdminRoles().map((r) => r.email)).not.toContain("ed@inspired.co");
  });

  it("takes effect on the next request, without signing out", async () => {
    const ed = await sessionFor("ed@inspired.co");
    expect((await app.inject({ method: "GET", url: "/api/admins", headers: { cookie: ed } })).statusCode).toBe(403);
    await put(superAdmin, "ed@inspired.co", "admin");
    expect((await app.inject({ method: "GET", url: "/api/admins", headers: { cookie: ed } })).statusCode).toBe(200);
  });

  it("does not let anyone change or remove their own role", async () => {
    const alex = await sessionFor("alex@inspired.co");
    expect((await put(alex, "alex@inspired.co", "editor")).json().error).toMatch(/cannot change your own role/);
    expect((await del(alex, "alex@inspired.co")).statusCode).toBe(403);
    expect(roleOf("alex@inspired.co")).toBe("admin");
  });

  it("keeps owners for the super admin to manage", async () => {
    const alex = await sessionFor("alex@inspired.co");
    expect((await put(alex, "olive@inspired.co", "editor")).statusCode).toBe(403);
    expect((await del(alex, "olive@inspired.co")).statusCode).toBe(403);
    expect((await put(alex, "ed@inspired.co", "owner")).statusCode).toBe(403);
    expect(roleOf("olive@inspired.co")).toBe("owner");

    expect((await put(superAdmin, "olive@inspired.co", "admin")).statusCode).toBe(200);
    expect((await del(superAdmin, "olive@inspired.co")).statusCode).toBe(200);
    expect(roleOf("olive@inspired.co")).toBe("user");
  });

  it("leaves the super admin to SUPER_ADMIN_EMAIL", async () => {
    const alex = await sessionFor("alex@inspired.co");
    expect((await put(alex, "it-admin@inspired.co", "editor")).statusCode).toBe(403);
    expect((await del(alex, "it-admin@inspired.co")).statusCode).toBe(403);
  });

  it("rejects addresses that are not email addresses, and unknown removals", async () => {
    expect((await put(superAdmin, "not an address", "editor")).statusCode).toBe(400);
    expect((await del(superAdmin, "nobody@inspired.co")).statusCode).toBe(404);
  });

  it("is closed to editors", async () => {
    const ed = await sessionFor("ed@inspired.co");
    expect((await put(ed, "someone@inspired.co", "admin")).statusCode).toBe(403);
    expect((await del(ed, "alex@inspired.co")).statusCode).toBe(403);
  });
});
