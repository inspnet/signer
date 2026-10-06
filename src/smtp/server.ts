import fs from "node:fs";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import nodemailer from "nodemailer";
import ipaddr from "ipaddr.js";
import { config } from "../config.js";
import { logMail } from "../db/index.js";
import { processRawMessage } from "../mail/process.js";
import { getAllowedCidrs, initAllowedCidrs, startRangeRefresh } from "./ipranges.js";
import { relayTargetFor } from "./route.js";
import { describeFailure, RelayError, sameFailure } from "./explain.js";
import { noteMailOutcome } from "../alerts/index.js";
import { messageIdOf, queueSentItemsUpdate } from "../mail/sentitems.js";

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

export async function relayUpstream(raw: Buffer, envelopeFrom: string, envelopeTo: string[]): Promise<void> {
  // Each sender domain goes back to its own Microsoft 365 endpoint where that
  // can be determined (see route.ts); otherwise UPSTREAM_HOST.
  const target = await relayTargetFor(envelopeFrom);
  if (!target.host) {
    throw new Error("UPSTREAM_HOST is not configured; cannot return mail to Microsoft 365 / Google");
  }
  const transporter = nodemailer.createTransport({
    host: target.host,
    port: target.port,
    secure: target.secure,
    tls: { servername: target.servername, rejectUnauthorized: target.rejectUnauthorized },
    auth: target.auth,
    name: config.smtp.hostname
  });
  try {
    await transporter.sendMail({
      envelope: { from: envelopeFrom, to: envelopeTo },
      raw
    });
  } catch (err) {
    throw new RelayError(target, err);
  }
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
    size: config.smtp.maxMessageMb * 1024 * 1024,
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
      let bytes = 0;
      stream.on("data", (c: Buffer) => {
        // Past the limit, stop keeping the data: the message is refused below.
        if (stream.sizeExceeded) return;
        chunks.push(c);
        bytes += c.length;
      });
      stream.on("end", () => {
        if (stream.sizeExceeded) {
          chunks.length = 0;
          const tooBig = new Error(`Message exceeds the ${config.smtp.maxMessageMb} MB limit`) as Error & { responseCode: number };
          tooBig.responseCode = 552;
          return callback(tooBig);
        }
        const raw = Buffer.concat(chunks, bytes);
        chunks.length = 0;
        void handleMessage(raw, session)
          .then(() => callback())
          .catch((err: Error) => {
            // Reaching here means the message was not handed back: fail-open has
            // already tried relaying it unsigned. Never answer 250 for mail we
            // no longer hold. A 4xx leaves it queued at Microsoft/Google, which
            // retry; acknowledging it would silently drop it.
            console.error("[signer] Could not deliver a message; deferring it so the sender retries", err);
            const deferral = new Error("Temporary failure, please retry later") as Error & { responseCode: number };
            deferral.responseCode = 451;
            callback(deferral);
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

/** Activity logging must never change the SMTP answer for mail already delivered. */
function record(entry: Parameters<typeof logMail>[0]): void {
  // The same reason Activity shows, for journalctl.
  if (entry.status === "error" || entry.status === "deferred") console.warn(`[signer] Message ${entry.status}: ${entry.detail ?? ""}`);
  noteMailOutcome(entry.status, entry.detail ?? "", entry.sender);
  try {
    logMail(entry);
  } catch (err) {
    console.error("[signer] Could not write the activity log", err);
  }
}

const RETRY = "Refused with 451, so Microsoft 365 / Google keep it queued and retry.";
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

async function handleMessage(raw: Buffer, session: SMTPServerSession): Promise<void> {
  const started = Date.now();
  const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
  const envelopeTo = session.envelope.rcptTo.map((r) => r.address);
  const entry = () => ({
    messageId: "",
    sender: envelopeFrom,
    recipients: envelopeTo,
    subject: "",
    signatureId: null,
    disclaimerIds: [] as string[],
    campaignIds: [] as string[],
    processingMs: Date.now() - started
  });

  if (hasProcessedHeader(raw)) {
    try {
      await relayUpstream(raw, envelopeFrom, envelopeTo);
    } catch (err) {
      const detail = `${sentence(`Already signed, but handing it back failed: ${describeFailure(err)}`)} ${RETRY}`;
      record({ ...entry(), status: "deferred", detail });
      throw err;
    }
    record({ ...entry(), status: "loop-prevented" });
    return;
  }

  let result: Awaited<ReturnType<typeof processRawMessage>>;
  try {
    result = await processRawMessage(raw, envelopeFrom, envelopeTo);
  } catch (err) {
    return deliverUnsigned(raw, envelopeFrom, envelopeTo, `Signing failed: ${describeFailure(err)}`, err, entry);
  }
  try {
    await relayUpstream(result.raw, envelopeFrom, envelopeTo);
  } catch (err) {
    const stage = result.skipped ? "Handing it back failed" : "Signed, but handing it back failed";
    return deliverUnsigned(raw, envelopeFrom, envelopeTo, `${stage}: ${describeFailure(err)}`, err, entry);
  }
  // Swap the unsigned copy in the sender's Sent Items for this one (when turned on).
  if (!result.skipped && result.body) queueSentItemsUpdate(envelopeFrom, envelopeTo, messageIdOf(result.raw), result.body);
  record({
    ...entry(),
    signatureId: result.signatureId,
    disclaimerIds: result.disclaimerIds,
    campaignIds: result.campaignIds,
    status: result.skipped ? "passed-through" : "signed",
    detail: result.reason
  });
}

/**
 * The fallback when a message could not be signed and returned. The log says
 * which: "error" means it was delivered without a signature, "deferred" means
 * it was not delivered and Microsoft 365 / Google hold it and retry.
 */
async function deliverUnsigned(
  raw: Buffer,
  envelopeFrom: string,
  envelopeTo: string[],
  why: string,
  cause: unknown,
  entry: () => Omit<Parameters<typeof logMail>[0], "status">
): Promise<void> {
  if (config.failureMode !== "fail-open") {
    record({ ...entry(), status: "deferred", detail: `${sentence(why)} Not delivered (FAILURE_MODE=fail-closed). ${RETRY}` });
    throw cause;
  }
  try {
    await relayUpstream(raw, envelopeFrom, envelopeTo);
  } catch (relayErr) {
    const again = sameFailure(cause, relayErr)
      ? "Sending it unsigned failed the same way."
      : sentence(`Sending it unsigned also failed: ${describeFailure(relayErr)}`);
    record({ ...entry(), status: "deferred", detail: `${sentence(why)} ${again} ${RETRY}` });
    throw relayErr;
  }
  record({ ...entry(), status: "error", detail: `${sentence(why)} Delivered without a signature (FAILURE_MODE=fail-open).` });
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
