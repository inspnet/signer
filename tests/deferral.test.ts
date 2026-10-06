import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-deferral-"));
const signerPort = await freePort();
// Nothing listens here: the upstream is unreachable, as it is on a Linode
// whose outbound SMTP block has not been lifted yet.
const deadUpstreamPort = await freePort();

process.env.DATABASE_PATH = path.join(tmp, "deferral.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SMTP_PORT = String(signerPort);
process.env.SMTP_SUBMISSION_PORT = "0";
process.env.SMTP_ALT_PORT = "0";
process.env.SMTP_ALLOWED_CIDRS = "";
process.env.UPSTREAM_HOST = "127.0.0.1";
process.env.UPSTREAM_PORT = String(deadUpstreamPort);
process.env.FAILURE_MODE = "fail-open";

const { initDb, closeDb } = await import("../src/db/index.js");
const { startSmtp } = await import("../src/smtp/server.js");

let servers: SMTPServer[] = [];

beforeAll(async () => {
  initDb();
  servers = await startSmtp();
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(() => {
  for (const server of servers) server.close();
  closeDb();
});

async function send(headers: Record<string, string> = {}): Promise<unknown> {
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port: signerPort, secure: false, ignoreTLS: true });
  try {
    return await transport.sendMail({
      from: "scott@inspired.co",
      to: "ada@contoso.com",
      subject: "Hello",
      text: "Hello Ada",
      headers
    });
  } finally {
    transport.close();
  }
}

describe("when Signer cannot hand mail back", () => {
  it("defers the message instead of accepting and dropping it, even in fail-open mode", async () => {
    await expect(send()).rejects.toMatchObject({ responseCode: 451 });
  });

  it("defers already-processed mail too", async () => {
    await expect(send({ "X-Signer-MessageProcessed": "true" })).rejects.toMatchObject({ responseCode: 451 });
  });
});
