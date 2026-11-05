import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The installer's DNS step, run for real with systemctl and getent replaced:
 * configure_dns() and the helpers it uses are cut out of deploy/install.sh.
 */
const script = fs.readFileSync(path.join(import.meta.dirname, "../deploy/install.sh"), "utf8");
const fn = (name: string) => {
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(script) ?? new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(script);
  if (!m) throw new Error(`${name} not found in install.sh`);
  return m[0];
};

function run(opts: { mode?: string; dnsWorks?: boolean; existing?: string; linkDropin?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-dns-"));
  const dropin = path.join(dir, "resolved.conf.d", "signer-dns.conf");
  if (opts.existing !== undefined) {
    fs.mkdirSync(path.dirname(dropin), { recursive: true });
    fs.writeFileSync(dropin, opts.existing);
  }
  const log = path.join(dir, "calls");
  const networkd = path.join(dir, "network");
  fs.mkdirSync(networkd);
  if (opts.linkDropin) {
    fs.mkdirSync(path.join(networkd, "05-eth0.network.d"));
    fs.writeFileSync(path.join(networkd, "05-eth0.network.d", "signer-dns.conf"), "[Network]\nDNSDefaultRoute=no\n");
  }
  const bash = [
    "set -euo pipefail",
    fn("note"),
    fn("warn"),
    `systemctl() { echo "systemctl $*" >> ${JSON.stringify(log)}; }`,
    `resolvectl() { echo "resolvectl $*" >> ${JSON.stringify(log)}; }`,
    // Linode: one interface, eth0, with a default route over IPv4 and IPv6, set up by systemd-networkd.
    `ip() { case "$*" in *default*) echo "default via 139.177.199.1 dev eth0 proto static" ;; esac; }`,
    `networkctl() { printf '%s\\n' "       Link File: /usr/lib/systemd/network/99-default.link" "    Network File: /etc/systemd/network/05-eth0.network"; }`,
    `getent() { ${opts.dnsWorks === false ? "return 2" : "return 0"}; }`,
    `DNS_MODE=${JSON.stringify(opts.mode ?? "cloudflare")}`,
    `RESOLVED_DROPIN=${JSON.stringify(dropin)}`,
    `NETWORKD_DIR=${JSON.stringify(networkd)}`,
    fn("dns_links"),
    fn("link_default_route"),
    fn("remove_link_dropins"),
    fn("configure_dns"),
    "configure_dns"
  ].join("\n");
  const out = execFileSync("bash", ["-c", bash], { encoding: "utf8" });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  const linkDropinPath = path.join(networkd, "05-eth0.network.d", "signer-dns.conf");
  return {
    out,
    defaultRoute: calls.split("\n").filter((l) => l.startsWith("resolvectl default-route")),
    linkDropin: fs.existsSync(linkDropinPath) ? fs.readFileSync(linkDropinPath, "utf8") : null,
    file: fs.existsSync(dropin) ? fs.readFileSync(dropin, "utf8") : null,
    restarts: (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter((l) => l.includes("restart")).length
  };
}

describe("installer DNS step", () => {
  it("points every lookup at Cloudflare, with Quad9 as fallback", () => {
    const { file, restarts, out } = run({});
    expect(file).toContain("DNS=1.1.1.1 1.0.0.1 2606:4700:4700::1111 2606:4700:4700::1001");
    expect(file).toContain("FallbackDNS=9.9.9.9");
    expect(file).toMatch(/^Domains=~\.$/m);
    expect(restarts).toBe(1);
    expect(out).toContain("Cloudflare (1.1.1.1, 1.0.0.1)");
  });

  it("stops eth0 being a DNS default route, now and after a reboot, so Linode's resolvers are not asked", () => {
    const { defaultRoute, linkDropin } = run({});
    // Once, though eth0 has both an IPv4 and an IPv6 default route.
    expect(defaultRoute).toEqual(["resolvectl default-route eth0 no"]);
    expect(linkDropin).toMatch(/^\[Network\]\nDNSDefaultRoute=no$/m);
  });

  it("does not restart the resolver when nothing changed", () => {
    const first = run({}).file!;
    expect(run({ existing: first.replace(/\n$/, "") }).restarts).toBe(0);
  });

  it("puts the host's resolvers back when DNS stops working through Cloudflare", () => {
    const { file, restarts, out, defaultRoute, linkDropin } = run({ dnsWorks: false });
    expect(file).toBeNull();
    expect(linkDropin).toBeNull();
    expect(defaultRoute).toEqual(["resolvectl default-route eth0 no", "resolvectl default-route eth0 yes"]);
    expect(restarts).toBe(2);
    expect(out).toContain("kept the host's own resolvers");
  });

  it("removes its setting with SIGNER_DNS=system", () => {
    const { file, out, linkDropin, defaultRoute } = run({ mode: "system", existing: "[Resolve]\nDNS=1.1.1.1\n", linkDropin: true });
    expect(file).toBeNull();
    expect(linkDropin).toBeNull();
    expect(defaultRoute).toEqual(["resolvectl default-route eth0 yes"]);
    expect(out).toContain("SIGNER_DNS=system");
  });
});
