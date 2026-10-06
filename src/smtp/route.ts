import dns from "node:dns/promises";
import { config } from "../config.js";
import { domainNames, domainReturnHost } from "../db/index.js";

/**
 * Where a signed message goes back to.
 *
 * Every domain in a Microsoft 365 tenant has its own Exchange Online endpoint
 * (contoso-com.mail.protection.outlook.com, fabrikam-com.mail.protection...),
 * published as that domain's MX record. Returning each message to its sender
 * domain's endpoint keeps tenant attribution right for every domain, not just
 * the one entered at setup. The rules, in order:
 *
 *   1. A return host an admin set for the domain (Settings → Domains).
 *   2. With a Microsoft 365 upstream (UPSTREAM_ROUTING=auto), the sender
 *      domain's MX, but only if it is a *.mail.protection.outlook.com host.
 *      A domain whose MX is a filtering service (Mimecast, Proofpoint...)
 *      must not have outbound mail handed to that service as if inbound.
 *   3. UPSTREAM_HOST from setup.
 *
 * Only domains on the domain list are routed per domain; anything else uses
 * UPSTREAM_HOST. Google Workspace returns everything through its SMTP relay,
 * since a Google MX is the inbound server, so per-domain MX is never used there.
 */

export type ReturnRoute = { host: string; via: "override" | "mx" | "default"; detail: string };

export type MxLookup = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;

const MICROSOFT_EOP = /\.mail\.protection\.outlook\.com$/i;
const resolver = new dns.Resolver({ timeout: 5000, tries: 2 });
const dnsLookup: MxLookup = (domain) => resolver.resolveMx(domain);

const cache = new Map<string, { route: ReturnRoute; expires: number }>();
const FOUND_MS = 10 * 60 * 1000;
const FAILED_MS = 60 * 1000;

/** True when routing follows each sender domain's MX. */
export function perDomainMx(): boolean {
  return config.upstream.routing === "auto" && MICROSOFT_EOP.test(config.upstream.host);
}

export function clearRouteCache(): void {
  cache.clear();
}

export async function returnRouteFor(senderEmail: string, lookup: MxLookup = dnsLookup): Promise<ReturnRoute> {
  const fallback = (detail: string): ReturnRoute => ({ host: config.upstream.host, via: "default", detail });
  const domain = senderEmail.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain || !domainNames().includes(domain)) {
    return fallback("the sender's domain is not on the domain list");
  }

  const override = domainReturnHost(domain);
  if (override) return { host: override, via: "override", detail: "set for this domain in Settings → Domains" };
  if (!perDomainMx()) return fallback("UPSTREAM_HOST is used for every domain");

  const hit = cache.get(domain);
  if (hit && hit.expires > Date.now()) return hit.route;

  let route: ReturnRoute;
  let ttl = FOUND_MS;
  try {
    const records = [...(await lookup(domain))].sort((a, b) => a.priority - b.priority);
    const best = records[0]?.exchange.replace(/\.$/, "").toLowerCase() ?? "";
    if (best && MICROSOFT_EOP.test(best)) {
      route = { host: best, via: "mx", detail: `${domain}'s MX record` };
    } else if (best) {
      route = fallback(`${domain}'s MX (${best}) is not a Microsoft 365 endpoint, so UPSTREAM_HOST is used`);
    } else {
      route = fallback(`${domain} has no MX record, so UPSTREAM_HOST is used`);
    }
  } catch (err) {
    ttl = FAILED_MS;
    route = fallback(`MX lookup for ${domain} failed (${err instanceof Error ? err.message : String(err)}), so UPSTREAM_HOST is used`);
  }
  cache.set(domain, { route, expires: Date.now() + ttl });
  return route;
}
