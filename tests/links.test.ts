import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-links-"));
process.env.DATABASE_PATH = path.join(tmp, "links.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "false";
process.env.SUPER_ADMIN_EMAIL = "it@belzbergco.com";
process.env.PRIMARY_DOMAIN = "belzbergco.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const db = await import("../src/db/index.js");
const { emptyUser } = await import("../src/directory/fields.js");
const { linkMailbox, senderProfile, suggestLinks, LinkError } = await import("../src/directory/links.js");
const { testSignature } = await import("../src/mail/process.js");

function person(id: string, email: string, displayName: string, extra: object = {}) {
  db.upsertDirectoryUser({ ...emptyUser(email), id, displayName, source: "entra", directoryId: id, domain: email.split("@")[1]!, ...extra });
}

beforeEach(() => {
  db.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  db.initDb();
  db.addDomain("balfourpacific.com", "test");
  db.addDomain("belzbergcapital.com", "test");
  person("u-dara", "dirocco@belzbergco.com", "Dara Di Rocco", { jobTitle: "Managing Director", mobile: "+1 416 555 0100" });
  person("u-dara-bp", "ddirocco@balfourpacific.com", "Dara Di Rocco - Balfour Pacific");
  person("u-dara-bc", "dirocco@belzbergcapital.com", "Dara Di Rocco - Belzberg Capital", { enabled: 0 });
  person("u-dara-ev", "dara.dirocco@belzbergco.com", "Dara Di Rocco - Everberg");
  person("u-ann", "ann@belzbergco.com", "Ann Lee");
});

afterAll(() => db.closeDb());

describe("secondary mailboxes", () => {
  it("suggests mailboxes named after a person, and only those", () => {
    expect(suggestLinks().map((s) => [s.email, s.primaryEmail])).toEqual([
      ["ddirocco@balfourpacific.com", "dirocco@belzbergco.com"],
      ["dirocco@belzbergcapital.com", "dirocco@belzbergco.com"],
      ["dara.dirocco@belzbergco.com", "dirocco@belzbergco.com"]
    ]);
    linkMailbox("ddirocco@balfourpacific.com", "dirocco@belzbergco.com");
    expect(suggestLinks().map((s) => s.email)).not.toContain("ddirocco@balfourpacific.com");
  });

  it("signs a linked mailbox with the person's details and the mailbox's own address", () => {
    linkMailbox("ddirocco@balfourpacific.com", "dirocco@belzbergco.com");
    expect(senderProfile("DDiRocco@balfourpacific.com")).toMatchObject({
      email: "ddirocco@balfourpacific.com",
      domain: "balfourpacific.com",
      displayName: "Dara Di Rocco",
      jobTitle: "Managing Director",
      mobile: "+1 416 555 0100"
    });
    expect(senderProfile("ann@belzbergco.com")).toMatchObject({ displayName: "Ann Lee" });
  });

  it("applies the signature for the mailbox's domain, filled from the person, with group rules seeing both", () => {
    const db_ = db.getDb();
    db_.prepare("INSERT INTO groups (id, name, email, source) VALUES ('g-partners', 'Partners', '', 'entra')").run();
    db_.prepare("INSERT INTO group_members (group_id, user_id) VALUES ('g-partners', 'u-dara')").run();
    const design = {
      width: 520,
      fontUnit: "pt" as const,
      blocks: [
        { id: "n", type: "field" as const, field: "displayName" },
        { id: "t", type: "field" as const, field: "jobTitle" },
        { id: "e", type: "field" as const, field: "email" },
        { id: "c", type: "text" as const, content: "Balfour Pacific" }
      ]
    };
    const bp = db.saveSignature({ name: "Balfour Pacific", design });
    db.saveSignatureRules(bp.id, {
      senders: { domains: ["balfourpacific.com"], groups: ["g-partners"] },
      senderExceptions: {},
      recipients: { any: true },
      dateTime: null,
      advanced: { bodySearch: "anywhere", ifNotApplied: "continue" }
    } as never);

    const before = testSignature({ from: "ddirocco@balfourpacific.com", to: "client@example.com" });
    expect(before.signature?.html ?? "").not.toContain("Managing Director");

    linkMailbox("ddirocco@balfourpacific.com", "dirocco@belzbergco.com");
    const after = testSignature({ from: "ddirocco@balfourpacific.com", to: "client@example.com" });
    expect(after.signature?.name).toBe("Balfour Pacific");
    expect(after.signature?.html).toContain("Dara Di Rocco");
    expect(after.signature?.html).toContain("Managing Director");
    expect(after.signature?.html).toContain("ddirocco@balfourpacific.com");
    expect(after.signature?.html).not.toContain("dirocco@belzbergco.com");
    expect(after.signature?.html).not.toContain("- Balfour Pacific");
  });

  it("refuses links that would chain or point at the mailbox itself, and unlinks", () => {
    linkMailbox("ddirocco@balfourpacific.com", "dirocco@belzbergco.com");
    expect(() => linkMailbox("dara.dirocco@belzbergco.com", "ddirocco@balfourpacific.com")).toThrow(LinkError);
    expect(() => linkMailbox("dirocco@belzbergco.com", "ann@belzbergco.com")).toThrow(/unlink them first/);
    expect(() => linkMailbox("ann@belzbergco.com", "ann@belzbergco.com")).toThrow(/itself/);
    expect(() => linkMailbox("nobody@belzbergco.com", "ann@belzbergco.com")).toThrow(/not in the directory/);
    linkMailbox("ddirocco@balfourpacific.com", "");
    expect(senderProfile("ddirocco@balfourpacific.com")).toMatchObject({ displayName: "Dara Di Rocco - Balfour Pacific" });
  });

  it("keeps links when the directory re-creates an account, and drops them when the person is deleted", () => {
    linkMailbox("ddirocco@balfourpacific.com", "dirocco@belzbergco.com");
    // The person's account is deleted and re-created in Entra: same address, new id.
    person("u-dara-new", "dirocco@belzbergco.com", "Dara Di Rocco", { jobTitle: "Partner" });
    expect(senderProfile("ddirocco@balfourpacific.com")).toMatchObject({ jobTitle: "Partner", primaryUserId: "u-dara-new" });
    // The mailbox itself is re-created.
    person("u-dara-bp-new", "ddirocco@balfourpacific.com", "Dara Di Rocco - Balfour Pacific");
    expect(senderProfile("ddirocco@balfourpacific.com")).toMatchObject({ jobTitle: "Partner" });
    // The person leaves: the mailbox goes back to its own details.
    db.pruneDirectoryUsers("entra", ["u-dara-bp-new", "u-dara-bc", "u-dara-ev", "u-ann"]);
    expect(senderProfile("ddirocco@balfourpacific.com")).toMatchObject({ displayName: "Dara Di Rocco - Balfour Pacific", primaryUserId: "" });
  });
});
