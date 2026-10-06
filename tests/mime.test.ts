import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { decodeText, findBody, headerBlock, parsePart, quotedPrintable, spliceBody } from "../src/mail/mime.js";

const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"), "latin1");

/** Outlook's usual shape: mixed → alternative(text, html) + attachments. */
function outlookMessage(attachment: Buffer): Buffer {
  return Buffer.concat([
    crlf([
      "From: Scott <scott@inspired.co>",
      "To: Ada <ada@contoso.com>",
      "Subject: Report",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="_mixed_"',
      "",
      "--_mixed_",
      'Content-Type: multipart/alternative; boundary="_alt_"',
      "",
      "--_alt_",
      'Content-Type: text/plain; charset="iso-8859-1"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=E9 report attached.",
      "",
      "--_alt_",
      'Content-Type: text/html; charset="iso-8859-1"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      '<html><head><meta http-equiv=3D"Content-Type" content=3D"text/html; charset=3Diso-8859-1"></head><body><p>Caf=E9 report attached.</p></body></html>',
      "",
      "--_alt_--",
      "",
      "--_mixed_",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      ""
    ]),
    attachment,
    crlf(["", "--_mixed_--", ""])
  ]);
}

function encodedAttachment(bytes: number, seed = 1): Buffer {
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 31 + seed) & 0xff;
  const b64 = data.toString("base64");
  return Buffer.from(b64.match(/.{1,76}/g)!.join("\r\n"), "latin1");
}

describe("finding the body", () => {
  it("finds the text and HTML versions in Outlook's structure, and decodes their charset", () => {
    const raw = outlookMessage(encodedAttachment(1000));
    const root = parsePart(raw, 0, raw.length);
    const body = findBody(root);
    expect(body.html?.type).toBe("text/html");
    expect(body.text?.type).toBe("text/plain");
    expect(decodeText(raw, body.text!).trim()).toBe("Café report attached.");
    expect(decodeText(raw, body.html!)).toContain("<p>Café report attached.</p>");
  });

  it("ignores text attachments and attached messages", () => {
    const raw = crlf([
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      "",
      "not the body",
      "--m--",
      ""
    ]);
    expect(findBody(parsePart(raw, 0, raw.length))).toEqual({});
  });

  it("does not mistake a boundary-like line inside a part for a boundary", () => {
    const raw = crlf([
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Line mentioning --b-ish text and x--b",
      "--b--",
      ""
    ]);
    const body = findBody(parsePart(raw, 0, raw.length));
    expect(decodeText(raw, body.text!)).toBe("Line mentioning --b-ish text and x--b");
  });
});

describe("splicing the signature in", () => {
  it("rewrites only the body parts and copies the attachment through byte for byte", async () => {
    const attachment = encodedAttachment(200_000);
    const raw = outlookMessage(attachment);
    const root = parsePart(raw, 0, raw.length);
    const body = findBody(root);
    const html = decodeText(raw, body.html!).replace("</body>", "<p>SIGNATURE ✓</p></body>");
    const out = spliceBody(raw, root, body, html, "Café report attached.\n\nSIGNATURE ✓");

    expect(out.includes(attachment)).toBe(true);
    expect(out.subarray(0, 60).toString()).toBe(raw.subarray(0, 60).toString());

    const parsed = await simpleParser(out);
    expect(parsed.html).toContain("SIGNATURE ✓");
    // The part is UTF-8 now, and the HTML's own <meta> charset says so too.
    expect(parsed.html).toContain("charset=utf-8");
    expect(parsed.html).not.toContain("iso-8859-1");
    expect(parsed.text).toContain("SIGNATURE ✓");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe("report.pdf");
    expect(parsed.attachments[0]!.content.equals(Buffer.from(attachment.toString("latin1"), "base64"))).toBe(true);
  });

  it("gives a plain-text message an HTML version for the signature", async () => {
    const raw = crlf(["From: a@inspired.co", "To: b@contoso.com", "Subject: Hi", "Content-Type: text/plain; charset=us-ascii", "", "Hello"]);
    const root = parsePart(raw, 0, raw.length);
    const out = spliceBody(raw, root, findBody(root), "<div>Hello</div><p>SIG</p>", "Hello\n\nSIG");
    const parsed = await simpleParser(out);
    expect(parsed.headers.get("content-type")).toMatchObject({ value: "multipart/alternative" });
    expect(parsed.subject).toBe("Hi");
    expect(parsed.text).toContain("SIG");
    expect(parsed.html).toContain("<p>SIG</p>");
  });

  it("keeps the top headers intact for parsing From, To and Subject without the body", async () => {
    const raw = outlookMessage(encodedAttachment(1000));
    const parsed = await simpleParser(headerBlock(raw));
    expect(parsed.subject).toBe("Report");
    expect(parsed.from?.value[0]?.address).toBe("scott@inspired.co");
  });
});

describe("quoted-printable", () => {
  it("keeps lines within 76 characters and round-trips UTF-8", async () => {
    const text = `${"é".repeat(60)} ${"x".repeat(200)} = trailing space `;
    const encoded = quotedPrintable(text);
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    const parsed = await simpleParser(
      Buffer.from(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encoded}`)
    );
    expect(parsed.text).toBe(text);
  });
});
