import os from "node:os";
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { config } from "../config.js";

/**
 * The public IPv4 this server sends mail from. Exchange's inbound connector
 * and Google's SMTP relay allow list both identify Signer by it.
 *
 * On a Linode the public address sits directly on the network interface, so it
 * is read locally rather than asking an outside "what is my IP" service. The
 * hostname's DNS A record is checked against it, because the connector must
 * list the address mail actually leaves from, and a mismatch is worth knowing
 * about. Behind NAT there is no public interface address; the A record is the
 * best remaining guess, and PUBLIC_IPV4 overrides both.
 */

export type PublicIp = {
  address: string | null;
  source: "config" | "interface" | "dns" | "none";
  dnsAddresses: string[];
  warning?: string;
};

type Interfaces = ReturnType<typeof os.networkInterfaces>;
type Resolve4 = (hostname: string) => Promise<string[]>;

/** Non-loopback IPv4 addresses that are publicly routable (not private, CGNAT or link-local). */
export function publicInterfaceAddresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      try {
        if (ipaddr.IPv4.parse(entry.address).range() === "unicast") found.push(entry.address);
      } catch {
        /* not an address we can use */
      }
    }
  }
  return [...new Set(found)];
}

export async function detectPublicIPv4(
  options: { interfaces?: Interfaces; resolve4?: Resolve4; hostname?: string; configured?: string } = {}
): Promise<PublicIp> {
  const configured = (options.configured ?? config.publicIPv4).trim();
  const hostname = options.hostname ?? config.smtp.hostname;
  const resolve4 = options.resolve4 ?? ((name: string) => dns.resolve4(name));
  const dnsAddresses = await resolve4(hostname).catch(() => [] as string[]);

  if (configured) return { address: configured, source: "config", dnsAddresses };

  const local = publicInterfaceAddresses(options.interfaces);
  if (local.length) {
    const address = local[0]!;
    const warning =
      dnsAddresses.length && !dnsAddresses.includes(address)
        ? `${hostname} resolves to ${dnsAddresses.join(", ")}, but this server's address is ${address}. ` +
          "Exchange identifies Signer by the address mail leaves from, so check DNS."
        : local.length > 1
          ? `This server has several public addresses (${local.join(", ")}); ${address} is shown. Set PUBLIC_IPV4 if mail leaves from another.`
          : undefined;
    return { address, source: "interface", dnsAddresses, warning };
  }

  if (dnsAddresses.length) {
    return {
      address: dnsAddresses[0]!,
      source: "dns",
      dnsAddresses,
      warning: `No public address on this server's network interfaces (it may be behind NAT), so ${hostname}'s DNS record is shown. Set PUBLIC_IPV4 if mail leaves from a different address.`
    };
  }

  return {
    address: null,
    source: "none",
    dnsAddresses,
    warning: "Could not determine this server's public IPv4. Set PUBLIC_IPV4 in the configuration."
  };
}
