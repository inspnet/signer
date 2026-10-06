import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleParser } from "mailparser";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-embed-"));
process.env.DATABASE_PATH = path.join(tmp, "embed.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@inspired.co";
process.env.PRIMARY_DOMAIN = "inspired.co";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.PUBLIC_URL = "https://signer.inspired.co";

const db = await import("../src/db/index.js");
const { embedImages } = await import("../src/mail/embed.js");
const { processRawMessage, composeTestMessage } = await import("../src/mail/process.js");
const { findBody, parsePart, spliceBody } = await import("../src/mail/mime.js");

// A real 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const LOGO = "1759730000000_inspired-logo.png";

beforeAll(() => {
  db.initDb();
  fs.mkdirSync(path.join(tmp, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "uploads", LOGO), PNG);
  const sig = db.listSignatures()[0]!;
  const design = JSON.parse(sig.designJson) as { blocks: unknown[] };
  design.blocks.unshift({ id: "logo", type: "image", src: `/uploads/${LOGO}`, width: 140, alt: "Inspired" });
  db.saveSignature({ id: sig.id, name: sig.name, design: design as never });
});

afterAll(() => db.closeDb());

const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"));

describe("embedding uploaded images", () => {
  it("swaps upload links for cid: references, relative or under PUBLIC_URL, and attaches each image once", () => {
    const { html, inline } = embedImages(
      `<img src="/uploads/${LOGO}" width="140"><img alt="again" src='https://signer.inspired.co/uploads/${LOGO}'><img src="https://cdn.example.com/x.png">`
    );
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ filename: "inspired-logo.png", contentType: "image/png" });
    expect(inline[0]!.content.equals(PNG)).toBe(true);
    expect(html).toBe(
      `<img src="cid:${inline[0]!.cid}" width="140"><img alt="again" src='cid:${inline[0]!.cid}'><img src="https://cdn.example.com/x.png">`
    );
  });

  it("keeps a link, made absolute, when the uploaded file is gone", () => {
    expect(embedImages('<img src="/uploads/missing.png">').html).toBe('<img src="https://signer.inspired.co/uploads/missing.png">');
  });

  it("signs a message with the logo inside it, not linked", async () => {
    const raw = crlf([
      "From: Scott Williamson <scott@inspired.co>",
      "To: Ada <ada@contoso.com>",
      "Subject: Hello",
      "Message-ID: <m1@inspired.co>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello Ada",
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hello Ada</p>",
      "--alt--",
      ""
    ]);
    const result = await processRawMessage(raw, "scott@inspired.co", ["ada@contoso.com"]);
    expect(result.skipped).toBe(false);
    const parsed = await simpleParser(result.raw);
    const logo = parsed.attachments.find((a) => a.filename === "inspired-logo.png")!;
    expect(logo).toBeDefined();
    expect(logo.contentDisposition).toBe("inline");
    expect(logo.content.equals(PNG)).toBe(true);
    expect(result.raw.toString("latin1")).not.toContain(`/uploads/${LOGO}`);
    expect(result.raw.toString("latin1")).toMatch(/Content-Type: multipart\/related; type="text\/html"/);
    // What the Sent Items copy gets.
    expect(result.body!.inline.map((i) => i.filename)).toEqual(["inspired-logo.png"]);
    expect(result.body!.html).toContain(`cid:${result.body!.inline[0]!.cid}`);
  });

  it("puts the logo in the test email too", async () => {
    const { raw } = await composeTestMessage({ from: "scott@inspired.co", testedTo: "ada@contoso.com", deliverTo: "it-admin@inspired.co" });
    const parsed = await simpleParser(raw);
    expect(parsed.attachments.map((a) => a.filename)).toContain("inspired-logo.png");
    expect(raw.toString("latin1")).not.toContain("/uploads/");
  });
});

describe("where embedded images go in the MIME tree", () => {
  const image = { cid: "logo1@signer", filename: "logo.png", contentType: "image/png", content: PNG };

  it("joins an existing multipart/related container rather than nesting a new one", async () => {
    const raw = crlf([
      "From: a@inspired.co",
      "Subject: Pasted picture",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      "--rel",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>See <img src="cid:image001@x"></p>',
      "--rel",
      "Content-Type: image/jpeg",
      "Content-ID: <image001@x>",
      "Content-Transfer-Encoding: base64",
      "",
      "/9j/4AAQ",
      "--rel--",
      ""
    ]);
    const root = parsePart(raw, 0, raw.length);
    const out = spliceBody(raw, root, findBody(root), '<p>See <img src="cid:image001@x"></p><img src="cid:logo1@signer">', "", [image]);
    const text = out.toString("latin1");
    expect(text.match(/multipart\/related/g)).toHaveLength(1);
    const parsed = await simpleParser(out);
    expect(parsed.attachments.map((a) => a.contentId)).toEqual(["<image001@x>", "<logo1@signer>"]);
  });

  it("gives a plain-text message an HTML version carrying the image", async () => {
    const raw = crlf(["From: a@inspired.co", "Subject: Plain", "Content-Type: text/plain", "", "Hello"]);
    const root = parsePart(raw, 0, raw.length);
    const out = spliceBody(raw, root, findBody(root), '<div>Hello</div><img src="cid:logo1@signer">', "Hello", [image]);
    const parsed = await simpleParser(out, { keepCidLinks: true });
    expect(parsed.text).toContain("Hello");
    expect(parsed.attachments[0]).toMatchObject({ contentId: "<logo1@signer>", contentDisposition: "inline" });
    expect(parsed.html).toContain("cid:logo1@signer");
  });
});
