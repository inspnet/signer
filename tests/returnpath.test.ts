import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SMTPServer } from "smtp-server";
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-returnpath-"));

/** A self-signed certificate for signer.example.com with the given extended key usage. */
function certificate(name: string, eku: string): { cert: string; key: string } {
  const cert = path.join(tmp, `${name}.pem`);
  const key = path.join(tmp, `${name}.key`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-keyout", key, "-out", cert, "-subj", "/CN=signer.example.com",
    "-addext", "subjectAltName=DNS:signer.example.com",
    "-addext", `extendedKeyUsage=${eku}`
  ], { stdio: "ignore" });
  return { cert, key };
}

const serverOnly = certificate("server-only", "serverAuth");
const both = certificate("both", "serverAuth,clientAuth");

const signerPort = await freePort();
const upstreamPort = await freePort();
process.env.DATABASE_PATH = path.join(tmp, "returnpath.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SMTP_PORT = String(signerPort);
process.env.SMTP_SUBMISSION_PORT = "0";
process.env.SMTP_ALT_PORT = "0";
process.env.SMTP_ALLOWED_CIDRS = "";
process.env.UPSTREAM_HOST = "127.0.0.1";
process.env.UPSTREAM_PORT = String(upstreamPort);
process.env.UPSTREAM_RETRY_DELAY_MS = "20";
process.env.FAILURE_MODE = "fail-open";

const db = await import("../src/db/index.js");
const { config } = await import("../src/config.js");
const { startSmtp } = await import("../src/smtp/server.js");
const { clientCertificate, resetClientCertificate } = await import("../src/smtp/clientcert.js");
const { relayHint } = await import("../src/smtp/explain.js");
const { presentedCertificateStep } = await import("../src/smtp/diagnose.js");

/** Stands in for Exchange Online: refuses the first `refusals` recipients with 451 4.4.62, then accepts. */
let refusals = 0;
const received: string[] = [];
const upstream = new SMTPServer({
  authOptional: true,
  hideSTARTTLS: true,
  onRcptTo(_address, _session, callback) {
    if (refusals > 0) {
      refusals -= 1;
      return callback(
        Object.assign(new Error("4.4.62 Mail sent to the wrong Office 365 region. ATTR35. [ValidationStatus of '' is EmptyCertificate]"), {
          responseCode: 451
        })
      );
    }
    callback();
  },
  onData(stream, _session, callback) {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      callback();
    });
  }
});

let servers: Awaited<ReturnType<typeof startSmtp>> = [];

beforeAll(async () => {
  db.initDb();
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  servers = await startSmtp();
});

afterAll(() => {
  for (const s of servers) s.close();
  upstream.close();
  db.closeDb();
});

async function send(): Promise<void> {
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port: signerPort, secure: false, ignoreTLS: true });
  try {
    await transport.sendMail({ from: "scott@inspired.co", to: "ada@contoso.com", subject: "Hello", text: "Hello Ada" });
  } finally {
    transport.close();
  }
}

const lastLog = () => db.getDb().prepare("SELECT status, detail FROM mail_log ORDER BY id DESC LIMIT 1").get() as { status: string; detail: string };

describe("handing signed mail back", () => {
  it("tries the signed copy once more after a temporary refusal, instead of sending it unsigned", async () => {
    received.length = 0;
    refusals = 1;
    await send();
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("X-Signer-MessageProcessed: true");
    const row = lastLog();
    expect(row.status).toBe("signed");
    expect(row.detail).toMatch(/^Signed\. Accepted on the second try; the first was refused: .*4\.4\.62/);
  });

  it("falls back to unsigned only when the second try is refused too", async () => {
    received.length = 0;
    refusals = 2;
    await send();
    expect(received).toHaveLength(1);
    expect(received[0]).not.toContain("X-Signer-MessageProcessed: true");
    expect(lastLog().status).toBe("error");
  });
});

describe("the certificate Signer presents to Microsoft 365", () => {
  const use = (c: { cert: string; key: string } | null) => {
    config.smtp.tlsCertPath = c?.cert ?? "";
    config.smtp.tlsKeyPath = c?.key ?? "";
    resetClientCertificate();
  };

  it("reports whether the certificate allows client authentication", () => {
    use(serverOnly);
    expect(clientCertificate()).toMatchObject({ subject: "signer.example.com", names: ["signer.example.com"], clientAuth: false });
    expect(presentedCertificateStep()).toMatchObject({ status: "warn", detail: expect.stringContaining("servers only") });
    use(both);
    expect(clientCertificate()).toMatchObject({ clientAuth: true });
    expect(presentedCertificateStep()).toMatchObject({ status: "ok", detail: expect.stringContaining("identify Signer by certificate") });
    use(null);
    expect(clientCertificate()).toBeNull();
    expect(presentedCertificateStep()).toMatchObject({ status: "warn", detail: expect.stringContaining("None presented") });
  });
});

describe("explaining 4.4.62", () => {
  it("talks about tenant attribution, not the TLS certificate", () => {
    const err = Object.assign(
      new Error("Can't send mail - all recipients were rejected: 451 4.4.62 Mail sent to the wrong Office 365 region. ATTR35. [ValidationStatus of '' is EmptyCertificate]"),
      { responseCode: 451 }
    );
    const hint = relayHint(err, { host: "contoso-com.mail.protection.outlook.com", port: 25 });
    expect(hint).toMatch(/could not tell which tenant/);
    expect(hint).toMatch(/empty sender/);
    expect(hint).toMatch(/switch it back to the IP address option/);
    expect(hint).not.toMatch(/TLS certificate check/);
  });
});
