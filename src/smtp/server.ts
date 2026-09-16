import fs from "node:fs";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import nodemailer from "nodemailer";
import ipaddr from "ipaddr.js";
import { config } from "../config.js";
import { logMail } from "../db/index.js";
import { processRawMessage } from "../mail/process.js";
import { getAllowedCidrs, initAllowedCidrs, startRangeRefresh } from "./ipranges.js";

export function ipAllowed(ip: string, cidrs: string[] = getAllowedCidrs()): boolean {
  if (!cidrs.length) return true;
  try {
    const addr = ipaddr.process(ip);
    return cidrs.some((cidr) => {
      const [range, bits] = cidr.split("/");
      if (!range) return false;
      const parsed = ipaddr.process(range);
      if (addr.kind() !== parsed.kind()) return false;
      return addr.match(parsed, Number(bits || (addr.kind() === "ipv4" ? 32 : 128)));
    });
  } catch {
    return false;
  }
}

let cachedTls: { key?: Buffer; cert?: Buffer } | null = null;

/** Read once: createServer consults this several times per listener. */
function tlsOptions(): { key?: Buffer; cert?: Buffer } {
  if (cachedTls) return cachedTls;
  if (config.smtp.tlsCertPath && config.smtp.tlsKeyPath && fs.existsSync(config.smtp.tlsCertPath)) {
    cachedTls = {
      key: fs.readFileSync(config.smtp.tlsKeyPath),
      cert: fs.readFileSync(config.smtp.tlsCertPath)
    };
  } else {
    cachedTls = {};
  }
  return cachedTls;
}

async function relayUpstream(raw: Buffer, envelopeFrom: string, envelopeTo: string[]): Promise<void> {
  if (!config.upstream.host) {
    throw new Error("UPSTREAM_HOST is not configured; cannot return mail to Microsoft 365 / Google");
  }
  const transporter = nodemailer.createTransport({
    host: config.upstream.host,
    port: config.upstream.port,
    secure: config.upstream.secure,
    tls: {
      servername: config.upstream.tlsServername || config.upstream.host,
      rejectUnauthorized: config.upstream.tlsRejectUnauthorized
    },
    auth: config.upstream.user
      ? { user: config.upstream.user, pass: config.upstream.pass }
      : undefined,
    name: config.smtp.hostname
  });
  await transporter.sendMail({
    envelope: { from: envelopeFrom, to: envelopeTo },
    raw
  });
}

function createServer(banner: string): SMTPServer {
  return new SMTPServer({
    name: config.smtp.hostname,
    banner,
    authOptional: true,
    disabledCommands: tlsOptions().key ? [] : ["AUTH"],
    hideSTARTTLS: !tlsOptions().key,
    key: tlsOptions().key,
    cert: tlsOptions().cert,
    size: 35 * 1024 * 1024,
    onConnect(session, callback) {
      if (!ipAllowed(session.remoteAddress)) {
        return callback(new Error("Relay access denied"));
      }
      callback();
    },
    onMailFrom(_address, _session, callback) {
      callback();
    },
    onRcptTo(_address, _session, callback) {
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(c as Buffer));
      stream.on("end", () => {
        void handleMessage(Buffer.concat(chunks), session)
          .then(() => callback())
          .catch((err: Error) => {
            if (config.failureMode === "fail-closed") {
              callback(err);
            } else {
              console.error("Signer processing failed; fail-open", err);
              callback();
            }
          });
      });
    }
  });
}

/**
 * Detect the loop-prevention header in the *header block* only.
 *
 * Searching the whole message matches the header name wherever it appears —
 * including quoted documentation, a forwarded message, or a base64 attachment
 * that happens to decode to it — and any such message would silently go
 * unsigned. The header block ends at the first blank line.
 */
export function hasProcessedHeader(raw: Buffer): boolean {
  const text = raw.toString("latin1");
  const blankLine = text.search(/\r?\n\r?\n/);
  const headerBlock = blankLine === -1 ? text : text.slice(0, blankLine);
  const name = config.processedHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${name}:[ \t]*true[ \t]*$`, "im").test(headerBlock.replace(/\r?\n[ \t]+/g, " "));
}

async function handleMessage(raw: Buffer, session: SMTPServerSession): Promise<void> {
  const started = Date.now();
  const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
  const envelopeTo = session.envelope.rcptTo.map((r) => r.address);
  if (hasProcessedHeader(raw)) {
    await relayUpstream(raw, envelopeFrom, envelopeTo);
    logMail({
      messageId: "",
      sender: envelopeFrom,
      recipients: envelopeTo,
      subject: "",
      signatureId: null,
      disclaimerIds: [],
      campaignIds: [],
      status: "loop-prevented",
      processingMs: Date.now() - started
    });
    return;
  }

  try {
    const result = await processRawMessage(raw, envelopeFrom, envelopeTo);
    await relayUpstream(result.raw, envelopeFrom, envelopeTo);
    logMail({
      messageId: "",
      sender: envelopeFrom,
      recipients: envelopeTo,
      subject: "",
      signatureId: result.signatureId,
      disclaimerIds: result.disclaimerIds,
      campaignIds: result.campaignIds,
      status: result.skipped ? "passed-through" : "signed",
      detail: result.reason,
      processingMs: Date.now() - started
    });
  } catch (err) {
    logMail({
      messageId: "",
      sender: envelopeFrom,
      recipients: envelopeTo,
      subject: "",
      signatureId: null,
      disclaimerIds: [],
      campaignIds: [],
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
      processingMs: Date.now() - started
    });
    if (config.failureMode === "fail-open") {
      try {
        await relayUpstream(raw, envelopeFrom, envelopeTo);
      } catch (relayErr) {
        console.error("Fail-open relay also failed", relayErr);
        throw err;
      }
      return;
    }
    throw err;
  }
}

export async function startSmtp(): Promise<SMTPServer[]> {
  const resolved = await initAllowedCidrs();
  if (resolved.invalid.length) {
    console.warn(`[signer] Ignoring unrecognised SMTP_ALLOWED_CIDRS entries: ${resolved.invalid.join(", ")}`);
  }
  if (resolved.cidrs.length) {
    const sources = [...resolved.live, ...resolved.stale.map((p) => `${p} (cached)`)];
    const from = sources.length ? ` from ${sources.join(", ")}` : "";
    console.log(`[signer] SMTP allowlist: ${resolved.cidrs.length} ranges${from}`);
  }
  startRangeRefresh();

  const servers: SMTPServer[] = [];
  const ports = [...new Set([config.smtp.port, config.smtp.submissionPort, config.smtp.altPort])].filter((p) => p > 0);
  for (const port of ports) {
    const server = createServer(`Signer signature gateway`);
    server.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EADDRINUSE") {
        console.warn(`SMTP port ${port} unavailable (${code}); continuing`);
        return;
      }
      console.error("SMTP error", err);
    });
    try {
      server.listen(port, "0.0.0.0", () => {
        console.log(`SMTP listening on ${port}`);
      });
      servers.push(server);
    } catch (err) {
      console.warn(`SMTP port ${port} failed to bind`, err);
    }
  }
  return servers;
}
