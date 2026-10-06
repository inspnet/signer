import { simpleParser } from "mailparser";
import { authenticate } from "mailauth";
import ipaddr from "ipaddr.js";
import { config } from "../config.js";
import { domainNames } from "../db/index.js";
import { headerBlock } from "../mail/mime.js";

export class InboundRefusal extends Error {
  readonly responseCode: number;
  constructor(message: string, temporary: boolean) {
    super(message.replace(/[\r\n]+/g, " ").trim());
    this.name = "InboundRefusal";
    this.responseCode = temporary ? 451 : 550;
  }
}

export type DmarcOutcome = { result: string; spf?: string; dkim?: string };

export type DmarcCheck = (
  raw: Buffer,
  conn: { ip: string; helo: string; sender: string }
) => Promise<DmarcOutcome>;

const TEMPORARY = new Set(["temperror", "temperr"]);

function clientIp(ip: string): string {
  try {
    return ipaddr.process(ip).toString();
  } catch {
    return ip;
  }
}

/** Domains in the From header. More than one is not a message we can attribute. */
export async function fromDomains(raw: Buffer): Promise<string[]> {
  const parsed = await simpleParser(headerBlock(raw));
  const value = parsed.from;
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const domains = list.flatMap((item) =>
    item.value.map((entry: { address?: string | null }) => (entry.address || "").toLowerCase().split("@")[1] || "").filter(Boolean)
  );
  return [...new Set(domains)];
}

/** Live DMARC evaluation. Injected in tests so they do not depend on DNS. */
export async function checkDmarc(
  raw: Buffer,
  conn: { ip: string; helo: string; sender: string }
): Promise<DmarcOutcome> {
  const checked = await withTimeout(
    authenticate(raw, {
      ip: conn.ip,
      helo: conn.helo || conn.ip,
      sender: conn.sender || undefined,
      mta: config.smtp.hostname,
      disableArc: true,
      disableBimi: true
    }),
    20_000
  );
  const dmarc = checked.dmarc ? checked.dmarc.status.result : "none";
  const spf = checked.spf ? checked.spf.status?.result : undefined;
  const aligned = checked.dkim?.results?.find((item) => item.status?.aligned && item.status.result === "pass");
  return { result: dmarc, spf, dkim: aligned ? "pass" : checked.dkim?.results?.[0]?.status?.result };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Accept mail only for a domain this organisation has listed, and only when
 * DMARC passes for that From domain. Sender IP ranges are not consulted:
 * connector addresses change, and a passing DMARC result is what shows the
 * message was authorised for the domain.
 *
 * Demo mode still requires a listed domain, and skips the DNS check so a lab
 * can submit mail without a published record. Production does not.
 */
export async function authorizeInbound(
  raw: Buffer,
  conn: { ip: string; helo: string; sender: string },
  check: DmarcCheck = checkDmarc
): Promise<{ domain: string }> {
  const domains = await fromDomains(raw);
  if (!domains.length) throw new InboundRefusal("Message has no From address", false);
  if (domains.length > 1) throw new InboundRefusal("Message has more than one From domain", false);
  const domain = domains[0]!;
  const known = domainNames();
  if (!known.length) {
    throw new InboundRefusal("This server has no organisation domains configured", false);
  }
  if (!known.includes(domain)) {
    throw new InboundRefusal(`Sender domain ${domain} is not one of this organisation's domains`, false);
  }
  if (config.demoMode) return { domain };

  const ip = clientIp(conn.ip);
  let outcome: DmarcOutcome;
  try {
    outcome = await check(raw, { ...conn, ip });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new InboundRefusal(`Temporary DMARC failure for ${domain} (${why})`, true);
  }
  const result = (outcome.result || "none").toLowerCase();
  if (result === "pass") return { domain };
  const via = [outcome.spf && `spf=${outcome.spf}`, outcome.dkim && `dkim=${outcome.dkim}`].filter(Boolean).join(", ");
  const suffix = via ? ` (${via})` : "";
  if (TEMPORARY.has(result)) {
    throw new InboundRefusal(`Temporary DMARC failure for ${domain}${suffix}`, true);
  }
  if (result === "none") {
    throw new InboundRefusal(`Sender domain ${domain} has no passing DMARC result${suffix}`, false);
  }
  throw new InboundRefusal(`DMARC did not pass for ${domain}${suffix}`, false);
}
