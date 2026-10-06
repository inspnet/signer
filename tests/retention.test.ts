import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-retention-"));
process.env.DATABASE_PATH = path.join(tmp, "retention.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { emptyUser } = await import("../src/directory/fields.js");

const DAY = 24 * 60 * 60 * 1000;

function insertMail(at: Date, sender: string): void {
  db.getDb()
    .prepare("INSERT INTO mail_log (received_at, sender, recipients, status) VALUES (?, ?, '[]', 'signed')")
    .run(at.toISOString(), sender);
}

function insertAudit(at: Date, actor: string): void {
  db.getDb().prepare("INSERT INTO audit_log (at, actor, action) VALUES (?, ?, 'test')").run(at.toISOString(), actor);
}

function directoryUser(source: "entra" | "google", id: string, email: string) {
  const user = emptyUser(email);
  user.id = `${source}:${id}`;
  user.directoryId = id;
  user.source = source;
  user.displayName = email;
  user.mobile = "+44 7700 900000";
  return user;
}

beforeEach(() => {
  db.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  db.initDb();
  db.getDb().prepare("DELETE FROM mail_log").run();
  db.getDb().prepare("DELETE FROM audit_log").run();
});

afterAll(() => db.closeDb());

describe("activity and audit retention", () => {
  const now = new Date("2026-10-06T12:00:00Z");

  it("removes activity older than the retention period and keeps the rest", () => {
    insertMail(new Date(now.getTime() - 31 * DAY), "old@example.com");
    insertMail(new Date(now.getTime() - 29 * DAY), "recent@example.com");
    const removed = db.purgeExpiredLogs(now, { mailLogDays: 30, auditLogDays: 365 });
    expect(removed.mailLog).toBe(1);
    const left = db.getDb().prepare("SELECT sender FROM mail_log").all() as { sender: string }[];
    expect(left.map((r) => r.sender)).toEqual(["recent@example.com"]);
  });

  it("keeps the audit trail on its own, longer clock", () => {
    insertAudit(new Date(now.getTime() - 400 * DAY), "former-admin@example.com");
    insertAudit(new Date(now.getTime() - 40 * DAY), "admin@example.com");
    const removed = db.purgeExpiredLogs(now, { mailLogDays: 30, auditLogDays: 365 });
    expect(removed.auditLog).toBe(1);
    expect((db.getDb().prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c).toBe(1);
  });

  it("keeps everything when a period is 0", () => {
    insertMail(new Date(now.getTime() - 3650 * DAY), "ancient@example.com");
    expect(db.purgeExpiredLogs(now, { mailLogDays: 0, auditLogDays: 0 })).toEqual({ mailLog: 0, auditLog: 0 });
  });

  it("overwrites deleted rows rather than leaving them in free pages", () => {
    expect(db.getDb().pragma("secure_delete", { simple: true })).toBe(1);
  });
});

describe("directory pruning", () => {
  it("removes people a completed sync no longer returns, with their group memberships", () => {
    db.upsertDirectoryUser(directoryUser("entra", "1", "stays@example.com"));
    db.upsertDirectoryUser(directoryUser("entra", "2", "left@example.com"));
    db.replaceGroups("entra", [{ id: "entra:g", name: "Sales", email: "", source: "entra" }], [
      { groupId: "entra:g", userId: "entra:1" },
      { groupId: "entra:g", userId: "entra:2" }
    ]);

    expect(db.pruneDirectoryUsers("entra", ["entra:1"])).toBe(1);
    expect(db.getUserByEmail("left@example.com")).toBeNull();
    expect(db.getUserByEmail("stays@example.com")).not.toBeNull();
    const members = db.getDb().prepare("SELECT user_id FROM group_members WHERE group_id = 'entra:g'").all() as {
      user_id: string;
    }[];
    expect(members.map((m) => m.user_id)).toEqual(["entra:1"]);
  });

  it("only touches the source that was synced", () => {
    db.upsertDirectoryUser(directoryUser("entra", "1", "entra-user@example.com"));
    db.upsertDirectoryUser(directoryUser("google", "9", "google-user@example.com"));
    db.pruneDirectoryUsers("entra", ["entra:1"]);
    expect(db.getUserByEmail("google-user@example.com")).not.toBeNull();
  });

  it("ignores an empty sync, which usually means lost permissions rather than an empty company", () => {
    db.upsertDirectoryUser(directoryUser("entra", "1", "still-here@example.com"));
    expect(db.pruneDirectoryUsers("entra", [])).toBe(0);
    expect(db.getUserByEmail("still-here@example.com")).not.toBeNull();
  });

  it("never removes manually added or demo people", () => {
    const before = (db.getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE source != 'entra'").get() as { c: number })
      .c;
    db.upsertDirectoryUser(directoryUser("entra", "1", "someone@example.com"));
    db.pruneDirectoryUsers("entra", ["entra:1"]);
    const after = (db.getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE source != 'entra'").get() as { c: number })
      .c;
    expect(after).toBe(before);
  });
});
