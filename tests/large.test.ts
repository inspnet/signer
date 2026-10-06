import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-large-"));
const signerPort = await freePort();
const sinkPort = await freePort();

process.env.DATABASE_PATH = path.join(tmp, "large.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SMTP_PORT = String(signerPort);
process.env.SMTP_SUBMISSION_PORT = "0";
process.env.SMTP_ALT_PORT = "0";
process.env.SMTP_ALLOWED_CIDRS = "";
process.env.UPSTREAM_HOST = "127.0.0.1";
process.env.UPSTREAM_PORT = String(sinkPort);

const { initDb, closeDb, mailStats } = await import("../src/db/index.js");
const { config } = await import("../src/config.js");
const { startSmtp } = await import("../src/smtp/server.js");

/** Stands in for Microsoft 365 on the return path. */
let delivered: Buffer | null = null;
let sink: SMTPServer;
let servers: SMTPServer[] = [];

beforeAll(async () => {
  initDb();
  sink = new SMTPServer({
    authOptional: true,
    hideSTARTTLS: true,
    size: 200 * 1024 * 1024,
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        delivered = Buffer.concat(chunks);
        callback();
      });
    }
  });
  await new Promise<void>((resolve) => sink.listen(sinkPort, "127.0.0.1", resolve));
  servers = await startSmtp();
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(() => {
  for (const s of servers) s.close();
  sink.close();
  closeDb();
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function send(attachment: Buffer) {
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port: signerPort, secure: false, ignoreTLS: true });
  return transport
    .sendMail({
      from: "Scott Williamson <scott@inspired.co>",
      to: "ada@contoso.com",
      subject: "The big file",
      text: "Here it is.",
      html: "<p>Here it is.</p>",
      attachments: [{ filename: "survey.bin", content: attachment, contentType: "application/octet-stream" }]
    })
    .finally(() => transport.close());
}

describe("large messages", () => {
  it("signs a 100 MB message and hands back the attachment unchanged", { timeout: 120_000 }, async () => {
    // 75 MB of data is about 100 MB once base64-encoded, as it travels.
    const attachment = Buffer.alloc(75 * 1024 * 1024);
    for (let i = 0; i < attachment.length; i += 4096) attachment.writeUInt32LE(i, i);
    const started = Date.now();
    await send(attachment);
    const took = Date.now() - started;

    expect(delivered).not.toBeNull();
    expect(delivered!.length).toBeGreaterThan(100 * 1024 * 1024);
    const parsed = await simpleParser(delivered!);
    expect(parsed.html).toContain("Scott Williamson");
    expect(parsed.attachments).toHaveLength(1);
    expect(sha(parsed.attachments[0]!.content)).toBe(sha(attachment));
    expect(mailStats().recent[0]).toMatchObject({ status: "signed" });
    console.log(`[large] 100 MB message signed and relayed in ${took} ms`);
  });

  it("refuses a message over the limit with 552 instead of holding it", { timeout: 60_000 }, async () => {
    const limit = config.smtp.maxMessageMb;
    expect(limit).toBe(150);
    // Just over 150 MB once encoded.
    const tooBig = Buffer.alloc(115 * 1024 * 1024, 1);
    await expect(send(tooBig)).rejects.toMatchObject({ responseCode: 552 });
  });
});
