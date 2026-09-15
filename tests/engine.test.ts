import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-"));

process.env.DATABASE_PATH = path.join(tmp, "test.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";

const { initDb, closeDb, getUserByEmail, saveSignature, saveSignatureRules, defaultRules, listSignatures } = await import("../src/db/index.js");
const { evaluateRules } = await import("../src/mail/rules.js");
const { insertHtml, insertText, isReplyMessage } = await import("../src/mail/insert.js");
const { renderDesign } = await import("../src/mail/render.js");
const { defaultProfessionalDesign } = await import("../src/mail/templates.js");
const { processRawMessage, testSignature } = await import("../src/mail/process.js");
const { emptyUser } = await import("../src/directory/fields.js");

beforeEach(() => {
  closeDb();
  initDb();
});

afterEach(() => {
  closeDb();
  try {
    fs.unlinkSync(process.env.DATABASE_PATH!);
  } catch {
    /* ignore */
  }
});

describe("rule matching", () => {
  it("matches everyone and external recipients", () => {
    const sender = emptyUser("alex@inspired.co");
    sender.groupIds = ["g-marketing"];
    const result = evaluateRules(
      {
        senders: { everyone: true },
        senderExceptions: {},
        recipients: { external: true },
        dateTime: null,
        advanced: { bodySearch: "anywhere", ifNotApplied: "continue" }
      },
      {
        sender,
        senderEmail: "alex@inspired.co",
        recipientEmails: ["customer@contoso.com"],
        internalDomains: ["inspired.co"],
        subject: "Hello",
        bodyText: "Hi there",
        latestBodyText: "Hi there",
        isReply: false
      }
    );
    expect(result.applied).toBe(true);
  });

  it("excludes a sender by group and stops on exclusion text", () => {
    const sender = emptyUser("alex@inspired.co");
    sender.groupIds = ["g-marketing"];
    const result = evaluateRules(
      {
        senders: { groups: ["g-other"] },
        senderExceptions: {},
        recipients: { any: true },
        dateTime: null,
        advanced: { bodyDoesNotContain: "Inspired Networks", bodySearch: "anywhere", ifNotApplied: "stop" }
      },
      {
        sender,
        senderEmail: "alex@inspired.co",
        recipientEmails: ["a@inspired.co"],
        internalDomains: ["inspired.co"],
        subject: "Re: Hello",
        bodyText: "Thanks\nInspired Networks\nOn Monday wrote:",
        latestBodyText: "Thanks",
        isReply: true
      }
    );
    expect(result.applied).toBe(false);
    expect(result.stopProcessing).toBe(true);
  });

  it("matches wildcard recipient domains", () => {
    const sender = emptyUser("alex@inspired.co");
    const result = evaluateRules(
      { ...defaultRules(), recipients: { domains: ["@contoso.*"] } },
      {
        sender,
        senderEmail: sender.email,
        recipientEmails: ["buyer@contoso.com"],
        internalDomains: ["inspired.co"],
        subject: "Quote",
        bodyText: "Quote attached",
        latestBodyText: "Quote attached",
        isReply: false
      }
    );
    expect(result.applied).toBe(true);
  });
});

describe("mime insertion", () => {
  it("inserts HTML before a Gmail quote", () => {
    const original = `<div>Hello</div><div class="gmail_quote">quoted</div>`;
    const out = insertHtml(original, "<p>SIG</p>");
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("gmail_quote"));
  });

  it("inserts text before Outlook original message", () => {
    const original = `Hello\n\n-----Original Message-----\nFrom: A`;
    const out = insertText(original, "SIG");
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("Original Message"));
  });

  it("detects replies", () => {
    expect(isReplyMessage({ inReplyTo: "<id>" }, "hi")).toBe(true);
    expect(isReplyMessage({ subject: "Re: lunch" }, "hi")).toBe(true);
    expect(isReplyMessage({ subject: "Lunch" }, "hi")).toBe(false);
  });
});

describe("design renderer", () => {
  it("fills directory fields and hides empty ones", () => {
    const user = emptyUser("scott@inspired.co");
    user.displayName = "Scott Williamson";
    user.jobTitle = "Marketing Director";
    const html = renderDesign(defaultProfessionalDesign(), user);
    expect(html).toContain("Scott Williamson");
    expect(html).toContain("Marketing Director");
    expect(html).not.toContain("{{");
  });

  it("rewrites hosted uploads to the public URL", () => {
    const html = renderDesign(
      {
        width: 400,
        blocks: [{ id: "i", type: "image", src: "/uploads/logo.png", width: 80, alt: "Logo" }]
      },
      emptyUser("a@b.com"),
      false
    );
    expect(html).toContain("http://localhost:3000/uploads/logo.png");
  });
});

describe("end-to-end processing", () => {
  it("applies the first matching signature and loop header", async () => {
    const raw = Buffer.from(
      [
        "From: Scott Williamson <scott@inspired.co>",
        "To: Ada <ada@contoso.com>",
        "Subject: Project update",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hello Ada, please see the update.</p>"
      ].join("\r\n")
    );
    const result = await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"]);
    expect(result.skipped).toBe(false);
    expect(result.signatureId).toBeTruthy();
    const text = result.raw.toString("utf8");
    expect(text).toMatch(/X-Signer-MessageProcessed: true/i);
    expect(text).toContain("Scott Williamson");
    expect(text.toLowerCase()).toContain("confidential");
  });

  it("drops DKIM and ARC headers so the tenant can sign the modified body", async () => {
    const raw = Buffer.from(
      [
        "From: Scott Williamson <scott@inspired.co>",
        "To: Ada <ada@contoso.com>",
        "Subject: Project update",
        "DKIM-Signature: v=1; a=rsa-sha256; d=inspired.co; s=selector; bh=old;",
        "ARC-Seal: i=1; cv=none;",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hello Ada, please see the update.</p>"
      ].join("\r\n")
    );
    const result = await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"]);
    const text = result.raw.toString("utf8");
    expect(text).not.toMatch(/^DKIM-Signature:/im);
    expect(text).not.toMatch(/^ARC-Seal:/im);
    expect(text).toMatch(/X-Signer-MessageProcessed: true/i);
  });

  it("does not apply an exception sender", async () => {
    const sig = listSignatures()[0]!;
    saveSignatureRules(sig.id, {
      ...defaultRules(),
      senders: { emails: ["nobody@inspired.co"] }
    });
    const test = testSignature({ from: "scott@inspired.co", to: "ada@contoso.com", body: "Hi" });
    expect(test.signature).toBeNull();
  });

  it("creates another signature without breaking the first", () => {
    saveSignature({ name: "Reply compact" });
    expect(listSignatures().length).toBeGreaterThanOrEqual(2);
    expect(getUserByEmail("scott@inspired.co")?.displayName).toBe("Scott Williamson");
  });
});
