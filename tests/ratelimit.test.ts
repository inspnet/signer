import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-ratelimit-"));
process.env.DATABASE_PATH = path.join(tmp, "rl.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.AUTH_RATE_LIMIT_MAX = "3";
process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES = "5";

const { initDb, closeDb } = await import("../src/db/index.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");

let app: FastifyInstance;

beforeAll(async () => {
  initDb();
  app = Fastify({ trustProxy: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);
  registerAuthRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe("auth rate limiting", () => {
  it("caps repeated sign-in attempts from one IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/dev-login",
        remoteAddress: "198.51.100.7"
      });
      codes.push(res.statusCode);
    }
    // AUTH_RATE_LIMIT_MAX=3, so the 4th and 5th are turned away.
    expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
    expect(codes[3]).toBe(429);
    expect(codes[4]).toBe(429);
  });

  it("counts per client IP, so one caller cannot lock out another", async () => {
    for (let i = 0; i < 4; i += 1) {
      await app.inject({ method: "POST", url: "/api/auth/dev-login", remoteAddress: "203.0.113.5" });
    }
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      remoteAddress: "203.0.113.99"
    });
    expect(other.statusCode).not.toBe(429);
  });

  it("leaves the endpoints the portal polls uncapped", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const me = await app.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "198.51.100.30" });
      const providers = await app.inject({
        method: "GET",
        url: "/api/auth/providers",
        remoteAddress: "198.51.100.30"
      });
      codes.push(me.statusCode, providers.statusCode);
    }
    expect(codes.every((c) => c === 200)).toBe(true);
  });
});
