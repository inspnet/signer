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

/** Wait before checking again when a DNS lookup failed for the moment. */
export const DMARC_RECHECK_MS = 1000;

/**
 * A DNS lookup that failed for the moment (SPF or DKIM "temperror") leaves
 * DMARC unable to pass, so DMARC reports a fail that is not one. Mail Exchange
 * routes to Signer is not DKIM-signed, so SPF is all DMARC has to go on, and
 * one DNS hiccup on this server used to bounce a real message.
 */
const unsure = (o: DmarcOutcome) =>
  [o.result, o.spf, o.dkim].some((r) => TEMPORARY.has(String(r ?? "").toLowerCase()));

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
 * The second of two gates. The first is the connection itself: only hosts in
 * SMTP_ALLOWED_CIDRS (Microsoft's or Google's published sending ranges) may
 * connect at all (see ipranges.ts).
 *
 * A message from one of this organisation's listed domains is then accepted
 * only when DMARC passes for that From domain, which shows it was authorised
 * for the domain and not just sent from somewhere on the provider's platform.
 *
 * A message from any other domain is not refused: it is passed through
 * unchanged and unsigned, as before (`listed: false`). Refusing it would bounce
 * mail from people whose address is still on, say, an onmicrosoft.com domain.
 *
 * Demo mode skips the DNS check so a lab can submit mail without a published
 * record. Production does not.
 */
export async function authorizeInbound(
  raw: Buffer,
  conn: { ip: string; helo: string; sender: string },
  check: DmarcCheck = checkDmarc,
  recheckMs = DMARC_RECHECK_MS
): Promise<{ domain: string; listed: boolean }> {
  const domains = await fromDomains(raw);
  if (!domains.length) throw new InboundRefusal("Message has no From address", false);
  if (domains.length > 1) throw new InboundRefusal("Message has more than one From domain", false);
  const domain = domains[0]!;
  if (!domainNames().includes(domain)) return { domain, listed: false };
  if (config.demoMode) return { domain, listed: true };

  const ip = clientIp(conn.ip);
  const run = async (): Promise<DmarcOutcome> => {
    try {
      return await check(raw, { ...conn, ip });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new InboundRefusal(`Temporary DMARC failure for ${domain} (${why})`, true);
    }
  };
  let outcome = await run();
  // One more look before deciding, as a DNS blip is usually gone a second later.
  if ((outcome.result || "").toLowerCase() !== "pass" && unsure(outcome)) {
    await new Promise((resolve) => setTimeout(resolve, recheckMs));
    outcome = await run();
  }
  const result = (outcome.result || "none").toLowerCase();
  if (result === "pass") return { domain, listed: true };
  const via = [outcome.spf && `spf=${outcome.spf}`, outcome.dkim && `dkim=${outcome.dkim}`].filter(Boolean).join(", ");
  const suffix = via ? ` (${via})` : "";
  if (unsure(outcome)) {
    // 451: Microsoft 365 keeps the message and retries, instead of bouncing it.
    throw new InboundRefusal(`Temporary DNS failure checking DMARC for ${domain}${suffix}; Microsoft 365 will retry`, true);
  }
  if (result === "none") {
    throw new InboundRefusal(`Sender domain ${domain} has no passing DMARC result${suffix}`, false);
  }
  throw new InboundRefusal(`DMARC did not pass for ${domain}${suffix}`, false);
}
