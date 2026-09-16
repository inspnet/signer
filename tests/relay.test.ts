import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";

/** Bind port 0, read what the OS gave us, release it. */
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-relay-"));
const signerPort = await freePort();
const sinkPort = await freePort();

process.env.DATABASE_PATH = path.join(tmp, "relay.db");
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

const { initDb, closeDb } = await import("../src/db/index.js");
const { startSmtp } = await import("../src/smtp/server.js");

/** Stands in for Microsoft 365 / Google on the return path. */
const delivered: string[] = [];
let sink: SMTPServer;
let signerServers: SMTPServer[] = [];

beforeAll(async () => {
  initDb();

  sink = new SMTPServer({
    authOptional: true,
    hideSTARTTLS: true,
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(c as Buffer));
      stream.on("end", () => {
        delivered.push(Buffer.concat(chunks).toString("utf8"));
        callback();
      });
    }
  });
  await new Promise<void>((resolve) => sink.listen(sinkPort, "127.0.0.1", resolve));

  signerServers = await startSmtp();
  // startSmtp returns as soon as listen is called; give the listener a tick.
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(async () => {
  for (const server of signerServers) server.close();
  sink?.close();
  closeDb();
});

async function sendThroughSigner(message: {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  icalEvent?: { method: string; content: string };
  replyTo?: string;
}): Promise<string> {
  const before = delivered.length;
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: signerPort,
    secure: false,
    ignoreTLS: true
  });
  await transport.sendMail(message);
  transport.close();

  for (let i = 0; i < 100 && delivered.length === before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(delivered.length).toBeGreaterThan(before);
  return delivered[delivered.length - 1]!;
}

describe("SMTP round trip through the gateway", () => {
  it("signs a plain message and relays it upstream", async () => {
    const received = await sendThroughSigner({
      from: "Scott Williamson <scott@inspired.co>",
      to: "ada@contoso.com",
      subject: "Project update",
      text: "Hello Ada, please see the update."
    });

    expect(received).toContain("Hello Ada");
    expect(received).toContain("Scott Williamson");
    expect(received).toMatch(/X-Signer-MessageProcessed: true/i);
  });

  it("carries Reply-To through the relay", async () => {
    const received = await sendThroughSigner({
      from: "scott@inspired.co",
      to: "ada@contoso.com",
      replyTo: "Sales <sales@inspired.co>",
      subject: "Quote",
      text: "Here is the quote."
    });

    expect(received).toMatch(/^Reply-To: .*sales@inspired\.co/im);
  });

  it("relays a calendar invite without destroying the invite", async () => {
    const received = await sendThroughSigner({
      from: "scott@inspired.co",
      to: "ada@contoso.com",
      subject: "Invite",
      text: "Meeting at 3pm",
      icalEvent: {
        method: "REQUEST",
        content: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nEND:VEVENT\r\nEND:VCALENDAR"
      }
    });

    expect(received).toContain("VCALENDAR");
    expect(received).toMatch(/X-Signer-MessageProcessed: true/i);
  });

  it("does not sign a message that already carries the processed header", async () => {
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: signerPort,
      secure: false,
      ignoreTLS: true
    });
    const before = delivered.length;
    await transport.sendMail({
      from: "scott@inspired.co",
      to: "ada@contoso.com",
      subject: "Already done",
      text: "Body",
      headers: { "X-Signer-MessageProcessed": "true" }
    });
    transport.close();
    for (let i = 0; i < 100 && delivered.length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const received = delivered[delivered.length - 1]!;
    expect(received).not.toContain("Marketing Director");
  });
});
