import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-passthrough-"));
process.env.DATABASE_PATH = path.join(tmp, "passthrough.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { processRawMessage } = await import("../src/mail/process.js");

beforeAll(() => db.initDb());
afterAll(() => db.closeDb());

const rules = (over: object) => ({
  senders: { everyone: true },
  senderExceptions: {},
  recipients: { any: true },
  dateTime: null,
  advanced: { bodySearch: "anywhere", ifNotApplied: "continue" },
  ...over
});

const plain = Buffer.from(
  ["From: Scott Williamson <scott@inspired.co>", "To: Ada <ada@inspired.co>", "Subject: Lunch", "Content-Type: text/plain; charset=utf-8", "", "Noon?", ""].join("\r\n")
);

describe("why a message passed through", () => {
  it("names the meeting response rather than a MIME type alone", async () => {
    const invite = Buffer.from(
      [
        "From: Scott Williamson <scott@inspired.co>",
        "To: Adam <adam@moelis.example>",
        "Subject: Accepted: Board call",
        'Content-Type: multipart/alternative; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Accepted",
        "--b",
        "Content-Type: text/calendar; method=REPLY; charset=utf-8",
        "",
        "BEGIN:VCALENDAR",
        "END:VCALENDAR",
        "--b--",
        ""
      ].join("\r\n")
    );
    const result = await processRawMessage(invite, "scott@inspired.co", ["adam@moelis.example"]);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/^Passed through untouched: it is a meeting invite or response, and changing it could break the calendar item \(Content-Type: text\/calendar\)$/i);
  });

  it("says, for each signature and disclaimer, which check stopped it", async () => {
    for (const s of db.listSignatures()) db.saveSignatureRules(s.id, rules({ senders: { domains: ["belzbergco.com"] } }) as never);
    for (const d of db.listDisclaimers()) db.saveDisclaimer({ id: d.id, name: d.name, html: d.html, rules: rules({ recipients: { external: true } }) as never });
    const result = await processRawMessage(plain, "scott@inspired.co", ["ada@inspired.co"]);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("Nothing applied.");
    expect(result.reason).toMatch(/\(signature\): Senders: scott@inspired\.co is not among the senders \(domain belzbergco\.com\)/);
    expect(result.reason).toMatch(/\(disclaimer\): Recipients: no recipient is external \(all are on your domains\)/);
  });
});
