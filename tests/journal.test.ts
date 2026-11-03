import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-journal-"));
process.env.DATABASE_PATH = path.join(tmp, "journal.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { processRawMessage } = await import("../src/mail/process.js");
const { removeJournalMarker, journalHeaderNames, setJournalSignedCopy } = await import("../src/mail/journal.js");
const { hasValidStamp } = await import("../src/mail/stamp.js");

beforeAll(() => db.initDb());
afterAll(() => db.closeDb());

/** A message as Exchange hands it to Signer after journaling it on the way out. */
const message = (marker = true) =>
  Buffer.from(
    [
      "Received: from YQXSPR01MB0031.CANPRD01.PROD.OUTLOOK.COM",
      ...(marker ? ["X-MS-Exchange-CrossPremises-Processed-By-Journaling: Journal", " Agent"] : []),
      "X-MS-Exchange-CrossPremises-AuthAs: Internal",
      "From: Scott Williamson <scott@inspired.co>",
      "To: Ada <ada@contoso.com>",
      "Subject: Quarterly update",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello Ada",
      "X-MS-Exchange-CrossPremises-Processed-By-Journaling: in the body, not a header",
      ""
    ].join("\r\n")
  );

const headers = (raw: Buffer) => raw.toString("latin1").split(/\r?\n\r?\n/)[0]!;

describe("Exchange's journaling marker", () => {
  it("is removed with its folded continuation, leaving other headers and the body alone", () => {
    const { raw, removed } = removeJournalMarker(message());
    expect(removed).toEqual(["X-MS-Exchange-CrossPremises-Processed-By-Journaling"]);
    expect(headers(raw)).not.toMatch(/Processed-By-Journaling|^ Agent/m);
    expect(headers(raw)).toContain("X-MS-Exchange-CrossPremises-AuthAs: Internal");
    expect(raw.toString("latin1")).toContain("X-MS-Exchange-CrossPremises-Processed-By-Journaling: in the body, not a header");
    expect(journalHeaderNames(message())).toEqual(["X-MS-Exchange-CrossPremises-Processed-By-Journaling"]);
    expect(removeJournalMarker(message(false)).removed).toEqual([]);
  });

  it("stays on signed mail unless Journal the signed copy is on", async () => {
    setJournalSignedCopy(false);
    const off = await processRawMessage(message(), "scott@inspired.co", ["ada@contoso.com"]);
    expect(off.skipped).toBe(false);
    expect(headers(off.raw)).toContain("Processed-By-Journaling");
    expect(off.reason).toBe("signed");
  });

  it("is removed from signed mail when it is on, before the stamp, and Activity says so", async () => {
    setJournalSignedCopy(true);
    try {
      const on = await processRawMessage(message(), "scott@inspired.co", ["ada@contoso.com"]);
      expect(on.skipped).toBe(false);
      expect(headers(on.raw)).not.toContain("Processed-By-Journaling");
      expect(hasValidStamp(on.raw)).toBe(true);
      expect(on.reason).toBe(
        "Signed. Journaling marker removed (X-MS-Exchange-CrossPremises-Processed-By-Journaling), so Exchange journals this signed copy."
      );

      const none = await processRawMessage(message(false), "scott@inspired.co", ["ada@contoso.com"]);
      expect(none.reason).toMatch(/is on, but the message had no journaling marker/);
    } finally {
      setJournalSignedCopy(false);
    }
  });
});
