import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { config } from "../config.js";
import { relayHint } from "./explain.js";
import { relayTargetFor, type MxLookup, type RelayTarget } from "./route.js";

/**
 * The return-path test (Settings → Connectors): talks SMTP to the host signed
 * mail goes back to, step by step, exactly as a real message would, and stops
 * before DATA so nothing is delivered.
 *
 * The external recipient is what makes it useful for Microsoft 365. Exchange
 * Online accepts mail for your own domains from anyone, so an internal
 * recipient passes even when the "Signer receive" connector does not match.
 * Relaying to an outside address is only allowed when it does; otherwise the
 * RCPT is refused with 550 5.7.64 TenantAttribution, which is the failure that
 * leaves messages stuck.
 */

export type StepStatus = "ok" | "warn" | "fail" | "skipped";
export type DiagnosticStep = { step: string; status: StepStatus; detail: string; ms: number };
export type RelayDiagnosis = {
  ok: boolean;
  domain: string;
  sender: string;
  target: { host: string; port: number; via: string; route: string; tls: string; auth: boolean };
  steps: DiagnosticStep[];
  hint: string;
};

export const DEFAULT_EXTERNAL_RECIPIENT = "signer-relay-check@example.com";
const MICROSOFT = /\.mail\.protection\.outlook\.com$/i;

type Reply = { code: number; text: string };

/** A minimal SMTP client: one command, one (possibly multi-line) reply. */
class SmtpLine {
  private buffer = "";
  private lines: string[] = [];
  private waiting: ((reply: Reply) => void) | null = null;
  private failed: ((err: Error) => void) | null = null;
  private error: Error | null = null;

  constructor(
    public socket: net.Socket,
    private timeoutMs: number
  ) {
    this.attach(socket);
  }

  attach(socket: net.Socket): void {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => this.fail(new Error("Connection closed by the server")));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.map((l) => l.slice(4)).join("\n") };
        this.lines = [];
        const resolve = this.waiting;
        this.waiting = null;
        this.failed = null;
        resolve?.(reply);
      }
    }
  }

  private fail(err: Error): void {
    if (!this.error) this.error = err;
    const reject = this.failed;
    this.waiting = null;
    this.failed = null;
    reject?.(err);
  }

  /** Waits for the next reply, after sending a command if one is given. */
  read(command?: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      const timer = setTimeout(() => {
        this.waiting = null;
        this.failed = null;
        reject(Object.assign(new Error(`No reply within ${Math.round(this.timeoutMs / 1000)}s`), { code: "ETIMEDOUT" }));
      }, this.timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.failed = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      if (command) this.socket.write(`${command}\r\n`);
    });
  }

  /** Stop listening to the plain socket before it is upgraded to TLS. */
  detach(): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
  }
}

function connectTcp(host: string, address: string, port: number, timeoutMs: number, secure: boolean, target: RelayTarget) {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: address, port, servername: net.isIP(target.servername) ? undefined : target.servername, rejectUnauthorized: target.rejectUnauthorized })
      : net.connect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`Connection to ${host}:${port} timed out after ${Math.round(timeoutMs / 1000)}s`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.once(secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function upgrade(socket: net.Socket, target: RelayTarget, timeoutMs: number) {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(target.servername) ? undefined : target.servername, rejectUnauthorized: target.rejectUnauthorized });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(Object.assign(new Error("TLS handshake timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function describeCertificate(socket: tls.TLSSocket): string {
  const cert = socket.getPeerCertificate();
  const subject = cert?.subject?.CN ? `certificate for ${cert.subject.CN}` : "certificate";
  const issuer = cert?.issuer?.O || cert?.issuer?.CN;
  const verified = socket.authorized ? "verified" : `not verified (${socket.authorizationError ?? "unknown"})`;
  return `${socket.getProtocol() ?? "TLS"}, ${subject}${issuer ? ` from ${issuer}` : ""}, ${verified}`;
}

export type DiagnoseOptions = {
  domain: string;
  /** Envelope sender; defaults to postmaster@domain. */
  sender?: string;
  /** One of your own mailboxes: checks plain delivery. */
  internalRecipient?: string;
  /** Somewhere outside the organisation: checks Microsoft 365 will relay for Signer. */
  externalRecipient?: string;
  timeoutMs?: number;
  lookup?: MxLookup;
};

export async function diagnoseRelay(options: DiagnoseOptions): Promise<RelayDiagnosis> {
  const domain = options.domain.trim().toLowerCase();
  const sender = (options.sender || `postmaster@${domain}`).toLowerCase();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const steps: DiagnosticStep[] = [];
  const target = await relayTargetFor(sender, options.lookup);
  const microsoft = MICROSOFT.test(target.host);
  let hint = "";
  let failure: unknown = null;

  const run = async <T>(step: string, fn: () => Promise<{ value: T; detail: string; status?: StepStatus }>) => {
    const started = Date.now();
    try {
      const { value, detail, status } = await fn();
      steps.push({ step, status: status ?? "ok", detail, ms: Date.now() - started });
      return value;
    } catch (err) {
      failure = err;
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step, status: "fail", detail: message, ms: Date.now() - started });
      hint = relayHint(err, target);
      throw err;
    }
  };
  const expect = (reply: Reply, ok: (code: number) => boolean, label: string) => {
    if (!ok(reply.code)) {
      throw Object.assign(new Error(`${label}: ${reply.code} ${reply.text}`), { responseCode: reply.code, response: `${reply.code} ${reply.text}` });
    }
    return `${reply.code} ${reply.text.split("\n")[0]}`;
  };

  let session: SmtpLine | null = null;
  try {
    if (!target.host) throw new Error("UPSTREAM_HOST is not configured, so there is nowhere to return mail to.");

    const address = await run("Look up the return host", async () => {
      if (net.isIP(target.host)) return { value: target.host, detail: `${target.host} (${target.route.detail})` };
      // Mail goes out over IPv4 (nodemailer prefers it, and the connector lists an IPv4 address).
      const found = await dns.lookup(target.host, { family: 4, all: true });
      const first = found[0]?.address;
      if (!first) throw Object.assign(new Error(`${target.host} has no IPv4 address`), { code: "EDNS" });
      return { value: first, detail: `${target.host} → ${found.map((a) => a.address).join(", ")} (${target.route.detail})` };
    });

    const socket = await run(`Connect to port ${target.port}`, async () => ({
      value: await connectTcp(target.host, address, target.port, timeoutMs, target.secure, target),
      detail: `Connected to ${address}:${target.port}${target.secure ? " over TLS" : ""}`
    }));
    // Exchange matches the "Signer receive" connector on this address.
    if (socket.localAddress) steps.at(-1)!.detail += ` from ${socket.localAddress.replace(/^::ffff:/, "")}`;
    session = new SmtpLine(socket, timeoutMs);
    const line = session;

    await run("Greeting", async () => ({ value: null, detail: expect(await line.read(), (c) => c === 220, "Greeting refused") }));

    let ehlo = await run("EHLO", async () => {
      const reply = await line.read(`EHLO ${config.smtp.hostname}`);
      expect(reply, (c) => c === 250, "EHLO refused");
      return { value: reply.text, detail: `Introduced as ${config.smtp.hostname}` };
    });

    if (!target.secure) {
      const offered = /^STARTTLS\b/im.test(ehlo);
      if (!offered) {
        await run("STARTTLS", async () => ({
          value: null,
          status: microsoft ? "fail" : "warn",
          detail: microsoft
            ? "Not offered. Microsoft 365 always offers it, so something between this server and Microsoft is interfering."
            : "Not offered: mail to this host goes unencrypted."
        }));
        if (microsoft) throw new Error("STARTTLS not offered");
      } else {
        const secured = await run("STARTTLS", async () => {
          expect(await line.read("STARTTLS"), (c) => c === 220, "STARTTLS refused");
          line.detach();
          const upgraded = await upgrade(line.socket, target, timeoutMs);
          return { value: upgraded, detail: describeCertificate(upgraded) };
        });
        line.attach(secured);
        ehlo = await run("EHLO over TLS", async () => {
          const reply = await line.read(`EHLO ${config.smtp.hostname}`);
          expect(reply, (c) => c === 250, "EHLO refused");
          return { value: reply.text, detail: "Accepted" };
        });
      }
    } else {
      steps.push({ step: "TLS", status: "ok", detail: describeCertificate(socket as tls.TLSSocket), ms: 0 });
    }

    if (target.auth) {
      const auth = target.auth;
      await run("Sign in", async () => {
        const token = Buffer.from(`\u0000${auth.user}\u0000${auth.pass}`).toString("base64");
        const reply = await line.read(`AUTH PLAIN ${token}`);
        if (reply.code !== 235) {
          throw Object.assign(new Error(`Sign-in refused: ${reply.code} ${reply.text}`), { code: "EAUTH", responseCode: reply.code });
        }
        return { value: null, detail: `Signed in as ${auth.user}` };
      });
    }

    await run(`MAIL FROM ${sender}`, async () => ({
      value: null,
      detail: expect(await line.read(`MAIL FROM:<${sender}>`), (c) => c === 250, "Sender refused")
    }));

    const recipients: Array<[string, string]> = [];
    if (options.internalRecipient) recipients.push(["internal", options.internalRecipient]);
    recipients.push(["external", options.externalRecipient || DEFAULT_EXTERNAL_RECIPIENT]);
    for (const [kind, rcpt] of recipients) {
      await run(`RCPT TO ${rcpt} (${kind})`, async () => {
        const detail = expect(await line.read(`RCPT TO:<${rcpt}>`), (c) => c === 250 || c === 251, "Recipient refused");
        return {
          value: null,
          detail:
            kind === "external" && microsoft
              ? `${detail}. Microsoft 365 will relay for Signer: the "Signer receive" connector matches.`
              : detail
        };
      });
    }

    // Stop before DATA: the test never delivers anything.
    await line.read("RSET").catch(() => null);
    await line.read("QUIT").catch(() => null);
  } catch (err) {
    if (!failure) {
      failure = err;
      hint = relayHint(err, target);
      if (!steps.some((s) => s.status === "fail")) {
        steps.push({ step: "Start", status: "fail", detail: err instanceof Error ? err.message : String(err), ms: 0 });
      }
    }
  } finally {
    session?.socket.destroy();
  }

  return {
    ok: !steps.some((s) => s.status === "fail"),
    domain,
    sender,
    target: {
      host: target.host,
      port: target.port,
      via: target.route.via,
      route: target.route.detail,
      tls: target.secure ? "implicit TLS" : "STARTTLS",
      auth: Boolean(target.auth)
    },
    steps,
    hint
  };
}
