import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-update-"));
const dataDir = path.join(tmp, "data");
fs.mkdirSync(dataDir);
process.env.DATABASE_PATH = path.join(dataDir, "update.db");
process.env.DATA_DIR = dataDir;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const update = await import("../src/system/update.js");
const db = await import("../src/db/index.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

// A remote with one commit, and an install cloned from it, like /opt/signer.
const remote = path.join(tmp, "remote.git");
const seed = path.join(tmp, "seed");
const install = path.join(tmp, "install");
fs.mkdirSync(seed);
git(tmp, "init", "-q", "--bare", remote);
git(seed, "init", "-q");
fs.writeFileSync(path.join(seed, "README.md"), "v1\n");
git(seed, "add", ".");
git(seed, "commit", "-q", "-m", "First version");
git(seed, "remote", "add", "origin", remote);
git(seed, "push", "-q", "origin", "HEAD:main");
git(tmp, "clone", "-q", "--branch", "main", remote, install);

const originalCwd = process.cwd();
beforeAll(() => process.chdir(install));
afterAll(() => process.chdir(originalCwd));

describe("GitHub remotes", () => {
  it("recognises https and ssh remotes", () => {
    expect(update.githubRepo("https://github.com/inspnet/signer.git")).toEqual({ owner: "inspnet", repo: "signer" });
    expect(update.githubRepo("git@github.com:inspnet/signer.git")).toEqual({ owner: "inspnet", repo: "signer" });
    expect(update.githubRepo("https://github.com/inspnet/signer")).toEqual({ owner: "inspnet", repo: "signer" });
    expect(update.githubRepo("/srv/signer.git")).toBeNull();
  });

  it("lists the new commits newest first and notices installer changes", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          commits: [
            { sha: "a1", commit: { message: "Older change\n\nbody", author: { name: "A", date: "2026-10-01T00:00:00Z" } } },
            { sha: "b2", commit: { message: "Newer change", author: { name: "B", date: "2026-10-02T00:00:00Z" } } }
          ],
          files: [{ filename: "src/server.ts" }, { filename: "deploy/install.sh" }]
        }),
        { status: 200 }
      )) as typeof fetch;
    const changes = await update.githubChanges({ owner: "inspnet", repo: "signer" }, "base", "head", fakeFetch);
    expect(changes?.commits.map((c) => c.subject)).toEqual(["Newer change", "Older change"]);
    expect(changes?.installerChanged).toBe(true);
  });

  it("treats a GitHub failure as 'no commit list', not as a failed check", async () => {
    const failing = (async () => new Response("rate limited", { status: 403 })) as typeof fetch;
    expect(await update.githubChanges({ owner: "o", repo: "r" }, "a", "b", failing)).toBeNull();
  });
});

describe("version and update check", () => {
  it("reports the installed commit", async () => {
    const version = await update.currentVersion();
    expect(version.subject).toBe("First version");
    expect(version.branch).toBe("main");
    expect(version.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is up to date until the remote moves, then sees the new commit", async () => {
    expect((await update.checkForUpdates({ force: true })).updateAvailable).toBe(false);
    fs.writeFileSync(path.join(seed, "README.md"), "v2\n");
    git(seed, "commit", "-q", "-am", "Second version");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const check = await update.checkForUpdates({ force: true });
    expect(check.updateAvailable).toBe(true);
    expect(check.latest.commit).toBe(git(seed, "rev-parse", "HEAD"));
    // ls-remote only reads: the install itself is untouched.
    expect(git(install, "rev-parse", "HEAD")).toBe(check.current.commit);
  });
});

describe("requesting an update", () => {
  it("is unavailable until the installer has set up the updater", () => {
    expect(update.updaterAvailable()).toBe(false);
    expect(() => update.requestUpdate("owner@example.com")).toThrow(update.UpdateUnavailableError);
  });

  it("drops a request file for the root updater, once", () => {
    fs.mkdirSync(path.join(dataDir, "update"));
    expect(update.updaterAvailable()).toBe(true);
    update.requestUpdate("owner@example.com");
    expect(fs.existsSync(path.join(dataDir, "update", "request"))).toBe(true);
    expect(update.updateStatus().state).toBe("requested");
    expect(() => update.requestUpdate("owner@example.com")).toThrow(/already in progress/);
  });

  it("reports what the updater wrote", () => {
    fs.rmSync(path.join(dataDir, "update", "request"));
    fs.writeFileSync(
      path.join(dataDir, "update", "status.json"),
      JSON.stringify({ state: "rolled-back", message: "The new version did not start", from: "a", to: "b" })
    );
    fs.writeFileSync(path.join(dataDir, "update", "last.log"), "line 1\nline 2\n");
    const status = update.updateStatus();
    expect(status).toMatchObject({ state: "rolled-back", message: "The new version did not start" });
    expect(status.log).toEqual(["line 1", "line 2"]);
  });
});

describe("updates API", () => {
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

  it("shows the installed version and updater state", async () => {
    const res = await app.inject({ method: "GET", url: "/api/system/updates", headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { available: boolean; current: { subject: string } };
    expect(body.available).toBe(true);
    expect(body.current.subject).toBe("First version");
  });

  it("queues an install for an owner and refuses a second while it is pending", async () => {
    const first = await app.inject({ method: "POST", url: "/api/system/updates/install", headers: { cookie: cookieHeader } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/system/updates/install", headers: { cookie: cookieHeader } });
    expect(second.statusCode).toBe(409);
  });

  it("is closed to anonymous callers", async () => {
    expect((await app.inject({ method: "POST", url: "/api/system/updates/install" })).statusCode).toBe(401);
  });
});
