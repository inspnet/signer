import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-directory-"));
process.env.DATABASE_PATH = path.join(tmp, "directory.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "false";
process.env.SUPER_ADMIN_EMAIL = "admin@contoso.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.ENTRA_TENANT_ID = "tenant";
process.env.ENTRA_CLIENT_ID = "client";
process.env.ENTRA_CLIENT_SECRET = "secret";

const db = await import("../src/db/index.js");
const { syncEntra, syncDirectory } = await import("../src/directory/sync.js");

type GraphUser = { id: string; mail: string; displayName: string; userType?: string };

/** Stands in for login.microsoftonline.com and Microsoft Graph. */
function stubGraph(users: GraphUser[], options: { usersStatus?: number } = {}) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes("/oauth2/v2.0/token")) return json({ access_token: "token" });
    if (url.includes("/v1.0/users")) {
      if (options.usersStatus) {
        return json(
          { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } },
          options.usersStatus
        );
      }
      return json({ value: users });
    }
    if (url.includes("/members")) return json({ value: users.filter((u) => u.userType !== "Guest").map((u) => ({ id: u.id })) });
    if (url.includes("/v1.0/groups")) return json({ value: [{ id: "g1", displayName: "Everyone" }] });
    throw new Error(`Unexpected request ${url}`);
  });
}

function rowsFor(email: string): { id: string }[] {
  return db.getDb().prepare("SELECT id FROM users WHERE email = ?").all(email) as { id: string }[];
}

beforeEach(() => {
  db.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  db.initDb();
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => db.closeDb());

describe("Entra directory sync", () => {
  it("takes over the super admin's placeholder instead of failing on the duplicate email", async () => {
    // Before any sync, the super admin has a placeholder so they can sign in and edit My Details.
    expect(rowsFor("admin@contoso.com").map((r) => r.id)).toEqual(["u-superadmin"]);
    db.setUserOverrides("admin@contoso.com", { pronouns: "they/them" });

    stubGraph([
      { id: "a1", mail: "admin@contoso.com", displayName: "Alex Admin" },
      { id: "b2", mail: "bob@contoso.com", displayName: "Bob" }
    ]);
    const result = await syncEntra();

    expect(result).toMatchObject({ users: 2, source: "entra" });
    expect(rowsFor("admin@contoso.com").map((r) => r.id)).toEqual(["entra:a1"]);
    const admin = db.getUserByEmail("admin@contoso.com")!;
    expect(admin.displayName).toBe("Alex Admin");
    // What they saved under My Details survives the takeover.
    const overrides = db.getDb().prepare("SELECT overrides_json FROM users WHERE id = 'entra:a1'").get() as {
      overrides_json: string;
    };
    expect(JSON.parse(overrides.overrides_json)).toEqual({ pronouns: "they/them" });
  });

  it("copes with an account deleted and re-created in Entra (same email, new id)", async () => {
    stubGraph([{ id: "old", mail: "bob@contoso.com", displayName: "Bob" }]);
    await syncEntra();
    stubGraph([{ id: "new", mail: "bob@contoso.com", displayName: "Bob" }]);
    await syncEntra();
    expect(rowsFor("bob@contoso.com").map((r) => r.id)).toEqual(["entra:new"]);
  });

  it("is idempotent: a second sync of the same directory changes nothing", async () => {
    const users = [
      { id: "a1", mail: "admin@contoso.com", displayName: "Alex Admin" },
      { id: "b2", mail: "bob@contoso.com", displayName: "Bob" }
    ];
    stubGraph(users);
    await syncEntra();
    stubGraph(users);
    const again = await syncEntra();
    expect(again).toMatchObject({ users: 2, removed: 0 });
    expect(rowsFor("bob@contoso.com")).toHaveLength(1);
  });

  it("skips guest accounts", async () => {
    stubGraph([
      { id: "b2", mail: "bob@contoso.com", displayName: "Bob" },
      { id: "g9", mail: "partner@fabrikam.example", displayName: "Partner", userType: "Guest" }
    ]);
    const result = await syncEntra();
    expect(result.users).toBe(1);
    expect(db.getUserByEmail("partner@fabrikam.example")).toBeNull();
  });

  it("joins a sync already in progress instead of running two at once", async () => {
    stubGraph([{ id: "b2", mail: "bob@contoso.com", displayName: "Bob" }]);
    const first = syncDirectory();
    const second = syncDirectory();
    expect(second).toBe(first);
    await first;
    expect(syncDirectory()).not.toBe(first);
  });

  it("explains missing Application permissions", async () => {
    stubGraph([], { usersStatus: 403 });
    await expect(syncEntra()).rejects.toThrow(/Application permissions[\s\S]*Grant admin consent/);
  });
});
