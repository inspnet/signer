import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { config } from "../config.js";

/**
 * Resolve provider names in SMTP_ALLOWED_CIDRS into real CIDR lists.
 *
 * Microsoft and Google both publish the addresses their mail servers send from
 * as SPF records, which is exactly the set that connects to this gateway. SPF
 * is used rather than Microsoft's endpoints.office.com web service because it
 * needs only DNS (no outbound HTTPS, no client GUID), it is the same mechanism
 * for both providers, and it lists sending hosts specifically rather than every
 * address the service uses.
 *
 * These ranges cover the provider's whole platform, not one tenant: allowing
 * "microsoft" means any Microsoft 365 tenant could reach this gateway, not only
 * yours. That keeps the open internet out, which is the point, but it is not
 * tenant isolation — pair it with TLS on the connector.
 */
const PROVIDER_SPF: Record<string, string[]> = {
  microsoft: ["spf.protection.outlook.com"],
  google: ["_spf.google.com"]
};

const PROVIDER_ALIASES: Record<string, string> = {
  microsoft: "microsoft",
  microsoft365: "microsoft",
  m365: "microsoft",
  office365: "microsoft",
  o365: "microsoft",
  exchange: "microsoft",
  outlook: "microsoft",
  google: "google",
  googleworkspace: "google",
  workspace: "google",
  gmail: "google"
};

export function providerFor(entry: string): string | null {
  return PROVIDER_ALIASES[entry.trim().toLowerCase().replace(/[\s_-]/g, "")] ?? null;
}

/** SPF allows at most 10 DNS-querying mechanisms; the same bound stops include loops. */
const MAX_SPF_DEPTH = 10;
const DNS_TIMEOUT_MS = 5000;

/** Injectable so tests do not depend on live DNS. */
export type TxtLookup = (name: string) => Promise<string[]>;

const dnsTxtLookup: TxtLookup = (name) => {
  const lookup = dns.resolveTxt(name).then((chunks) => chunks.map((parts) => parts.join("")));
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`DNS lookup for ${name} timed out`)), DNS_TIMEOUT_MS)
  );
  return Promise.race([lookup, timeout]);
};

function normalizeCidr(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    if (raw.includes("/")) {
      const [addr, bits] = ipaddr.parseCIDR(raw);
      return `${addr.toString()}/${bits}`;
    }
    const addr = ipaddr.parse(raw);
    return `${addr.toString()}/${addr.kind() === "ipv4" ? 32 : 128}`;
  } catch {
    return null;
  }
}

/**
 * Walk an SPF record collecting ip4/ip6 mechanisms, following include: and
 * redirect=. Mechanisms that resolve to a host rather than a range (a, mx, ptr,
 * exists) are ignored: they are not used by either provider's mail records, and
 * expanding them would widen the allowlist in ways the operator cannot see.
 */
async function spfCidrs(
  name: string,
  lookup: TxtLookup,
  depth = 0,
  seen = new Set<string>()
): Promise<string[]> {
  if (depth > MAX_SPF_DEPTH || seen.has(name)) return [];
  seen.add(name);

  const records = await lookup(name);
  const spf = records.find((r) => r.trim().toLowerCase().startsWith("v=spf1"));
  if (!spf) throw new Error(`${name} has no v=spf1 TXT record`);

  const cidrs: string[] = [];
  const nested: string[] = [];
  for (const term of spf.split(/\s+/).slice(1)) {
    const mechanism = term.replace(/^[+\-~?]/, "");
    const lower = mechanism.toLowerCase();
    if (lower.startsWith("ip4:") || lower.startsWith("ip6:")) {
      const cidr = normalizeCidr(mechanism.slice(4));
      if (cidr) cidrs.push(cidr);
    } else if (lower.startsWith("include:")) {
      nested.push(mechanism.slice("include:".length));
    } else if (lower.startsWith("redirect=")) {
      nested.push(mechanism.slice("redirect=".length));
    }
  }

  for (const target of nested) {
    cidrs.push(...(await spfCidrs(target, lookup, depth + 1, seen)));
  }
  return cidrs;
}

async function resolveProvider(provider: string, lookup: TxtLookup): Promise<string[]> {
  const names = PROVIDER_SPF[provider];
  if (!names) throw new Error(`Unknown provider "${provider}"`);
  const collected = new Set<string>();
  for (const name of names) {
    for (const cidr of await spfCidrs(name, lookup)) collected.add(cidr);
  }
  if (!collected.size) throw new Error(`${provider} published no usable ranges`);
  return [...collected];
}

type CacheFile = Record<string, { cidrs: string[]; fetchedAt: string }>;

function cachePath(): string {
  return path.join(config.dataDir, "ip-ranges.cache.json");
}

function readCache(): CacheFile {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

function writeCache(cache: CacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("[signer] Could not write the IP range cache", err);
  }
}

export type ResolvedRanges = {
  cidrs: string[];
  /** Provider tokens that resolved from the network on this pass. */
  live: string[];
  /** Provider tokens served from the on-disk cache because DNS failed. */
  stale: string[];
  /** Provider tokens that could neither be resolved nor read from cache. */
  failed: string[];
  /** Entries that were not provider tokens and were rejected as CIDRs. */
  invalid: string[];
};

/**
 * Turn the configured entries into a flat CIDR list. Provider tokens are
 * resolved from DNS and cached to disk; on a DNS failure the last good answer
 * is reused, because narrowing the allowlist to nothing would silently drop
 * mail and widening it to everything would silently open the relay.
 */
export async function resolveAllowedCidrs(
  entries: string[],
  lookup: TxtLookup = dnsTxtLookup
): Promise<ResolvedRanges> {
  const resolve = lookup ?? dnsTxtLookup;
  const cache = readCache();
  const result: ResolvedRanges = { cidrs: [], live: [], stale: [], failed: [], invalid: [] };
  const seen = new Set<string>();
  const add = (cidr: string) => {
    if (!seen.has(cidr)) {
      seen.add(cidr);
      result.cidrs.push(cidr);
    }
  };

  for (const entry of entries) {
    const provider = providerFor(entry);
    if (!provider) {
      const cidr = normalizeCidr(entry);
      if (cidr) add(cidr);
      else result.invalid.push(entry);
      continue;
    }

    try {
      const cidrs = await resolveProvider(provider, resolve);
      cache[provider] = { cidrs, fetchedAt: new Date().toISOString() };
      result.live.push(provider);
      for (const cidr of cidrs) add(cidr);
    } catch (err) {
      const cached = cache[provider];
      if (cached?.cidrs.length) {
        result.stale.push(provider);
        for (const cidr of cached.cidrs) add(cidr);
        console.warn(
          `[signer] Could not refresh ${provider} ranges (${err instanceof Error ? err.message : String(err)}); ` +
            `using the copy cached at ${cached.fetchedAt}.`
        );
      } else {
        result.failed.push(provider);
        console.error(
          `[signer] Could not resolve ${provider} ranges and no cached copy exists: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  if (result.live.length) writeCache(cache);
  return result;
}

let activeCidrs: string[] = [];
let lastResolved: ResolvedRanges | null = null;

export function getAllowedCidrs(): string[] {
  return activeCidrs;
}

export function getRangeStatus(): ResolvedRanges | null {
  return lastResolved;
}

/**
 * Resolve the configured entries once at startup.
 *
 * Throws when a provider token cannot be resolved at all, because an empty
 * allowlist means "accept from anyone": failing to start is the safe outcome,
 * and the disk cache means this only bites on a first boot with broken DNS.
 */
export async function initAllowedCidrs(lookup?: TxtLookup): Promise<ResolvedRanges> {
  const resolved = await resolveAllowedCidrs(config.smtp.allowedCidrs, lookup);
  if (resolved.failed.length) {
    throw new Error(
      `SMTP_ALLOWED_CIDRS names ${resolved.failed.join(", ")} but those ranges could not be resolved and ` +
        `nothing is cached. Refusing to start: an unresolved allowlist would accept mail from anyone. ` +
        `Fix DNS, or list explicit CIDRs instead.`
    );
  }
  activeCidrs = resolved.cidrs;
  lastResolved = resolved;
  return resolved;
}

/**
 * Providers renumber, so re-resolve periodically. A failed refresh keeps the
 * ranges already in force rather than replacing them with a partial answer.
 */
export function startRangeRefresh(intervalMinutes = config.smtp.rangeRefreshMinutes): NodeJS.Timeout | null {
  const hasProvider = config.smtp.allowedCidrs.some((entry) => providerFor(entry));
  if (!hasProvider || intervalMinutes <= 0) return null;
  const timer = setInterval(
    () => {
      void resolveAllowedCidrs(config.smtp.allowedCidrs)
        .then((resolved) => {
          if (resolved.failed.length || !resolved.cidrs.length) return;
          const changed =
            resolved.cidrs.length !== activeCidrs.length ||
            resolved.cidrs.some((cidr) => !activeCidrs.includes(cidr));
          activeCidrs = resolved.cidrs;
          lastResolved = resolved;
          if (changed) console.log(`[signer] SMTP allowlist refreshed: ${resolved.cidrs.length} ranges`);
        })
        .catch((err) => console.warn("[signer] SMTP allowlist refresh failed; keeping current ranges", err));
    },
    intervalMinutes * 60 * 1000
  );
  timer.unref();
  return timer;
}
