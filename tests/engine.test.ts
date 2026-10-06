import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";

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
  function sigBefore(html: string, marker: string) {
    const out = insertHtml(html, "<p>SIG</p>");
    expect(out.indexOf("SIG"), html).toBeGreaterThan(out.indexOf("latest reply"));
    expect(out.indexOf("SIG"), html).toBeLessThan(out.indexOf(marker));
    expect(out.indexOf("signer-signature")).toBeLessThan(out.lastIndexOf("</body>") === -1 ? out.length : out.lastIndexOf("</body>"));
    return out;
  }

  it("inserts HTML before a Gmail quote", () => {
    const original = `<div>latest reply</div><div class="gmail_quote">quoted</div>`;
    const out = insertHtml(original, "<p>SIG</p>");
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("gmail_quote"));
  });

  it("inserts text before Outlook original message", () => {
    const original = `Hello\n\n-----Original Message-----\nFrom: A`;
    const out = insertText(original, "SIG");
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("Original Message"));
  });

  it("inserts before Apple Mail cite blockquotes", () => {
    sigBefore(
      `<html><body><div>latest reply</div><blockquote type="cite">older</blockquote></body></html>`,
      `blockquote`
    );
  });

  it("inserts before Outlook reply separator", () => {
    sigBefore(
      `<html><body><div>latest reply</div><div id="divRplyFwdMsg"><b>From:</b> Ada</div></body></html>`,
      `divRplyFwdMsg`
    );
  });

  it("inserts before Outlook appendonsend when the reply precedes it", () => {
    sigBefore(
      `<html><body><div>latest reply</div><div id="appendonsend"></div><div>quoted history</div></body></html>`,
      `appendonsend`
    );
  });

  it("inserts before Thunderbird, Yahoo, and Proton quote wrappers", () => {
    sigBefore(`<div>latest reply</div><div class="moz-cite-prefix">On Monday Ada wrote:</div><blockquote>old</blockquote>`, "moz-cite-prefix");
    sigBefore(`<div>latest reply</div><div class="yahoo_quoted">old</div>`, "yahoo_quoted");
    sigBefore(`<div>latest reply</div><div class="protonmail_quote">old</div>`, "protonmail_quote");
  });

  it("treats Outlook-rewritten x_ class prefixes as Gmail quotes", () => {
    sigBefore(`<div>latest reply</div><div class="x_gmail_quote">quoted</div>`, "x_gmail_quote");
  });

  it("uses the earliest quote marker in the body, not the first pattern in the list", () => {
    const original = [
      "<html><body><div>latest reply</div>",
      '<div class="gmail_quote">On Mon Ada wrote:',
      "<p>mid-thread</p>",
      "<b>From:</b> older Outlook copy at the bottom of the thread",
      "</div></body></html>"
    ].join("");
    const out = insertHtml(original, "<p>SIG</p>");
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("gmail_quote"));
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("<b>From:</b>"));
    expect(out.indexOf("signer-signature")).toBeLessThan(out.indexOf("</body>"));
  });

  it("does not fall through to </body> when a quote exists", () => {
    const original = `<html><body><p>latest reply</p><div class="gmail_quote">thread</div><p>footer in quote</p></body></html>`;
    const out = insertHtml(original, "<p>SIG</p>");
    expect(out.indexOf("signer-signature")).toBeLessThan(out.indexOf("gmail_quote"));
    expect(out.indexOf("signer-signature")).toBeLessThan(out.indexOf("</body>"));
  });

  it("inserts before an existing signature when the client left no quote markup", () => {
    const original = `<div>latest reply</div><div class="signer-signature">old sig</div><p>previous message with no quote wrapper</p>`;
    const out = insertHtml(original, "<p>SIG</p>");
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("old sig"));
    expect(out.indexOf("SIG")).toBeGreaterThan(out.indexOf("latest reply"));
  });

  it("still appends before </body> on a new message with no thread", () => {
    const original = `<html><body><p>Hello Ada</p></body></html>`;
    const out = insertHtml(original, "<p>SIG</p>");
    expect(out.indexOf("SIG")).toBeGreaterThan(out.indexOf("Hello Ada"));
    expect(out.indexOf("signer-signature")).toBeLessThan(out.indexOf("</body>"));
  });

  it("places the signature after a bottom-posted reply instead of above the quote", () => {
    const original = `<html><body><blockquote type="cite">older thread</blockquote><div>latest reply</div></body></html>`;
    const out = insertHtml(original, "<p>SIG</p>");
    expect(out.indexOf("SIG")).toBeGreaterThan(out.indexOf("latest reply"));
    expect(out.indexOf("blockquote")).toBeLessThan(out.indexOf("SIG"));
  });

  it("inserts text before Gmail On-wrote and quoted lines", () => {
    const onWrote = `Thanks\n\nOn Tue, Sep 15, 2026 at 9:00 AM Ada <ada@contoso.com> wrote:\n> Status?`;
    const out = insertText(onWrote, "SIG");
    expect(out.indexOf("SIG")).toBeLessThan(out.indexOf("On Tue"));
    const quoted = `Thanks\n\n> Status?\n> Please advise`;
    const qOut = insertText(quoted, "SIG");
    expect(qOut.indexOf("SIG")).toBeLessThan(qOut.indexOf("> Status?"));
  });

  it("appends text when the quote comes first (bottom-post)", () => {
    const original = `On Tue, Sep 15, 2026 at 9:00 AM Ada <ada@contoso.com> wrote:\n> Status?\n\nShipped just now.`;
    const out = insertText(original, "SIG");
    expect(out.indexOf("SIG")).toBeGreaterThan(out.indexOf("Shipped just now."));
  });

  it("detects replies", () => {
    expect(isReplyMessage({ inReplyTo: "<id>" }, "hi")).toBe(true);
    expect(isReplyMessage({ subject: "Re: lunch" }, "hi")).toBe(true);
    expect(isReplyMessage({ subject: "Lunch" }, "hi")).toBe(false);
    expect(isReplyMessage({ subject: "Lunch" }, "Hi\n\nOn Tue, Sep 15, 2026 Jane wrote:\n> hey")).toBe(true);
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

  it("sizes text in points, like Outlook, and defaults to Aptos as Outlook writes it", () => {
    const user = emptyUser("scott@inspired.co");
    const text = (style: object, fontUnit?: "pt") => ({
      width: 520,
      fontUnit,
      blocks: [{ id: "t", type: "text" as const, content: "Hi", style }]
    });
    const aptos = "Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif";
    // Saved in points: 12 means Outlook's 12.
    expect(renderDesign(text({ fontSize: 12 }, "pt"), user)).toContain(`font-family:${aptos};font-size:12pt`);
    // Saved before sizes were points: 12px is 9pt, so it looks as it did.
    expect(renderDesign(text({ fontSize: 12 }), user)).toContain("font-size:9pt");
    // An Aptos picked before gets Outlook's cloud-font names too.
    expect(renderDesign(text({ fontFamily: "Aptos, Calibri, Arial, sans-serif", fontSize: 12 }, "pt"), user)).toContain(`font-family:${aptos};`);
    // Another font chosen on purpose stays.
    expect(renderDesign(text({ fontFamily: "Georgia, serif", fontSize: 12 }, "pt"), user)).toContain("font-family:Georgia, serif;");
  });

  it("gives the signature no background unless a colour was chosen, so dark mode shows no box", () => {
    const user = emptyUser("scott@inspired.co");
    const design = (background?: string) => ({ width: 520, background, blocks: [{ id: "t", type: "text" as const, content: "Hi" }] });
    for (const none of [undefined, "", "#ffffff", "#FFF", "white"]) {
      expect(renderDesign(design(none), user)).not.toContain("background:");
    }
    expect(renderDesign(design("#f1f5fa"), user)).toContain("background:#f1f5fa;");
  });

  it("turns a text block into a link, with directory fields in the address", () => {
    const user = emptyUser("scott@inspired.co");
    user.website = "www.inspired.co";
    const design = (href: string, underline = false) => ({
      width: 520,
      blocks: [{ id: "t", type: "text" as const, content: "Book a meeting", href, underline }]
    });
    expect(renderDesign(design("https://cal.example.com/scott"), user)).toContain(
      '<a href="https://cal.example.com/scott" style="color:inherit;text-decoration:none;">Book a meeting</a>'
    );
    expect(renderDesign(design("{{website}}", true), user)).toContain(
      '<a href="https://www.inspired.co" style="color:inherit;text-decoration:underline;">Book a meeting</a>'
    );
    expect(renderDesign(design("mailto:{{email}}"), user)).toContain('href="mailto:scott@inspired.co"');
    // Anything but web, mail and phone links is dropped, not rendered.
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "not a link"]) {
      const html = renderDesign(design(bad), user);
      expect(html).not.toContain("<a ");
      expect(html).toContain("Book a meeting");
    }
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
    expect(result.raw.toString("utf8")).toMatch(/X-Signer-MessageProcessed: true/i);
    // Read the decoded body: quoted-printable may wrap a word across lines in the raw bytes.
    const html = String((await simpleParser(result.raw)).html);
    expect(html).toContain("Scott Williamson");
    expect(html.toLowerCase()).toContain("confidential");
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

  it("places the processed signature under the reply and before the quoted thread", async () => {
    const raw = Buffer.from(
      [
        "From: Scott Williamson <scott@inspired.co>",
        "To: Ada <ada@contoso.com>",
        "Subject: Re: Project update",
        "In-Reply-To: <prev@inspired.co>",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><div>Thanks Ada, shipped.</div>",
        '<div class="gmail_quote"><div>On Mon Ada wrote:</div><p>Status?</p>',
        "<p>old footer that must stay below the signature</p></div></body></html>"
      ].join("\r\n")
    );
    const result = await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"]);
    // Decoded: quoted-printable can wrap a long line in the middle of a word.
    const html = String((await simpleParser(result.raw)).html);
    expect(html.indexOf("signer-signature")).toBeGreaterThan(html.indexOf("Thanks Ada"));
    expect(html.indexOf("signer-signature")).toBeLessThan(html.indexOf("gmail_quote"));
    expect(html.indexOf("signer-signature")).toBeLessThan(html.indexOf("old footer"));
  });
});
