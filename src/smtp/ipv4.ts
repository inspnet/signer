import dns from "node:dns/promises";
import net from "node:net";

/**
 * Address to open for a return connection.
 *
 * Nodemailer collects A and AAAA records and then picks one at random, so a
 * host with both can be dialled over IPv6. Microsoft 365 rejects that path:
 * the IPv6 address is often listed, and Exchange will not take IPv6 mail
 * unless it already passes SPF or DKIM. The connector and the return-path
 * test are IPv4, so the real send uses an A record too.
 */
export async function resolveIpv4(hostname: string): Promise<string> {
  const host = hostname.trim().replace(/\.$/, "");
  if (net.isIP(host) === 4) return host;
  if (net.isIP(host) === 6) {
    throw Object.assign(new Error(`${host} is an IPv6 address. Mail is returned over IPv4 only.`), { code: "EDNS" });
  }
  try {
    const addresses = await dns.resolve4(host);
    const ipv4 = addresses.find((address) => net.isIP(address) === 4);
    if (!ipv4) throw Object.assign(new Error(`${host} has no IPv4 address`), { code: "EDNS" });
    return ipv4;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "EDNS") throw err;
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : "";
    throw Object.assign(new Error(`${host} has no IPv4 address${code ? ` (${code})` : ""}`), { code: code || "EDNS" });
  }
}
