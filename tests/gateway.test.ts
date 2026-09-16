import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-gateway-"));

process.env.DATABASE_PATH = path.join(tmp, "gateway.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const {
  initDb,
  closeDb,
  saveCampaign,
  saveSignatureRules,
  saveDisclaimer,
  defaultRules,
  listSignatures,
  listDisclaimers,
  listCampaigns
} = await import("../src/db/index.js");
const { processRawMessage, evaluateMessage } = await import("../src/mail/process.js");
const { latestBodyText } = await import("../src/mail/insert.js");
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

function message(headers: string[], body: string): Buffer {
  return Buffer.from([...headers, "", body].join("\r\n"));
}

describe("header preservation", () => {
  it("keeps Reply-To on a signed message", async () => {
    const raw = message(
      [
        "From: Scott Williamson <scott@inspired.co>",
        "To: Ada <ada@contoso.com>",
        "Reply-To: Sales Team <sales@inspired.co>",
        "Subject: Quote",
        "Content-Type: text/plain; charset=utf-8"
      ],
      "Here is the quote."
    );
    const result = await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"]);
    expect(result.skipped).toBe(false);
    expect(result.raw.toString("utf8")).toMatch(/^Reply-To: .*sales@inspired\.co/im);
  });

  it("keeps structured headers that mailparser does not expose as strings", async () => {
    const raw = message(
      [
        "From: Scott Williamson <scott@inspired.co>",
        "To: Ada <ada@contoso.com>",
        "Subject: Newsletter",
        "Return-Path: <bounce@inspired.co>",
        "List-Unsubscribe: <mailto:unsubscribe@inspired.co>",
        "X-Custom-Trace: keep-me",
        "Content-Type: text/plain; charset=utf-8"
      ],
      "Body text."
    );
    const out = (await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"])).raw.toString("utf8");
    expect(out).toMatch(/^Return-Path: <bounce@inspired\.co>/im);
    expect(out).toMatch(/^List-Unsubscribe: <mailto:unsubscribe@inspired\.co>/im);
    expect(out).toMatch(/^X-Custom-Trace: keep-me/im);
  });

  it("does not duplicate the processed header", async () => {
    const raw = message(
      ["From: scott@inspired.co", "To: ada@contoso.com", "Subject: Hi", "Content-Type: text/plain"],
      "Hello"
    );
    const out = (await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"])).raw.toString("utf8");
    expect(out.match(/X-Signer-MessageProcessed:/gi)?.length).toBe(1);
  });
});

describe("messages that must not be rewritten", () => {
  it("passes a calendar invite through untouched", async () => {
    const raw = Buffer.from(
      [
        "From: Scott Williamson <scott@inspired.co>",
        "To: Ada <ada@contoso.com>",
        "Subject: Invite",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Meeting at 3pm",
        "--b1",
        "Content-Type: text/calendar; method=REQUEST; charset=utf-8",
        "",
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "END:VCALENDAR",
        "--b1--",
        ""
      ].join("\r\n")
    );
    const result = await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"]);
    expect(result.skipped).toBe(true);
    const out = result.raw.toString("utf8");
    expect(out).toContain("BEGIN:VCALENDAR");
    expect(out).toContain("END:VCALENDAR");
    // Everything after the added header is the original message, byte for byte.
    expect(out.slice(out.indexOf("\r\n") + 2)).toBe(raw.toString("utf8"));
  });

  it("passes S/MIME signed mail through untouched", async () => {
    const raw = Buffer.from(
      [
        "From: scott@inspired.co",
        "To: ada@contoso.com",
        "Subject: Signed",
        'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="s"',
        "",
        "--s",
        "Content-Type: text/plain",
        "",
        "Signed body",
        "--s--",
        ""
      ].join("\r\n")
    );
    const result = await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"]);
    expect(result.skipped).toBe(true);
    expect(result.raw.toString("utf8")).toContain("multipart/signed");
  });

  it("relays the original bytes when no signature matches", async () => {
    const nobody = { ...defaultRules(), senders: { emails: ["nobody@example.com"] } };
    for (const sig of listSignatures()) saveSignatureRules(sig.id, nobody);
    for (const d of listDisclaimers()) saveDisclaimer({ id: d.id, name: d.name, html: d.html, enabled: false });
    expect(listCampaigns().filter((c) => c.enabled).length).toBe(0);
    const raw = message(
      ["From: outsider@example.org", "To: ada@contoso.com", "Subject: Hi", "Content-Type: text/plain"],
      "No signature applies here."
    );
    const result = await processRawMessage(raw, "outsider@example.org", ["ada@contoso.com"]);
    expect(result.skipped).toBe(true);
    expect(result.raw.toString("utf8")).toContain(raw.toString("utf8"));
  });
});

describe("campaign rendering", () => {
  it("escapes campaign text and drops unsafe links", () => {
    saveCampaign({
      name: "Q4",
      imageUrl: "https://cdn.example.com/banner.png",
      href: "javascript:alert(1)",
      alt: 'Autumn "sale" <script>alert(1)</script>',
      enabled: true,
      rules: defaultRules()
    });
    const ctx = {
      sender: emptyUser("scott@inspired.co"),
      senderEmail: "scott@inspired.co",
      recipientEmails: ["ada@contoso.com"],
      internalDomains: ["inspired.co"],
      subject: "Hi",
      bodyText: "Hi",
      latestBodyText: latestBodyText("Hi"),
      isReply: false
    };
    const html = evaluateMessage(ctx, "Hi").htmlPreview;
    expect(html).toContain("https://cdn.example.com/banner.png");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;sale&quot;");
  });
});

const { hasProcessedHeader } = await import("../src/smtp/server.js");

describe("loop prevention", () => {
  it("detects the processed header in the header block", () => {
    const raw = Buffer.from(
      ["From: a@b.co", "To: c@d.co", "X-Signer-MessageProcessed: true", "", "Body"].join("\r\n")
    );
    expect(hasProcessedHeader(raw)).toBe(true);
  });

  it("is case-insensitive and tolerates extra whitespace", () => {
    const raw = Buffer.from(
      ["From: a@b.co", "x-signer-messageprocessed:   true  ", "", "Body"].join("\r\n")
    );
    expect(hasProcessedHeader(raw)).toBe(true);
  });

  it("ignores the header name appearing in the body", () => {
    const raw = Buffer.from(
      [
        "From: a@b.co",
        "To: c@d.co",
        "Subject: Runbook",
        "Content-Type: text/plain",
        "",
        "Exchange sets X-Signer-MessageProcessed: true on the way back out.",
        "Quoted from the docs above."
      ].join("\r\n")
    );
    expect(hasProcessedHeader(raw)).toBe(false);
  });

  it("ignores the header inside a forwarded message", () => {
    const raw = Buffer.from(
      [
        "From: a@b.co",
        "Subject: Fwd: report",
        "Content-Type: text/plain",
        "",
        "---------- Forwarded message ----------",
        "From: old@b.co",
        "X-Signer-MessageProcessed: true",
        "",
        "Original body"
      ].join("\r\n")
    );
    expect(hasProcessedHeader(raw)).toBe(false);
  });
});
