import { describe, expect, it } from "vitest";
import type os from "node:os";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
const { detectPublicIPv4, publicInterfaceAddresses } = await import("../src/system/publicip.js");

type Interfaces = ReturnType<typeof os.networkInterfaces>;

function nic(...addresses: string[]): Interfaces {
  return {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "", cidr: "127.0.0.1/8" }],
    eth0: addresses.map((address) => ({ address, family: "IPv4" as const, internal: false, netmask: "255.255.255.0", mac: "", cidr: `${address}/24` }))
  };
}

const resolvesTo = (...addresses: string[]) => async () => addresses;
const noDns = async (): Promise<string[]> => {
  throw new Error("ENOTFOUND");
};

describe("public IPv4", () => {
  it("ignores loopback, private, CGNAT and link-local addresses", () => {
    expect(publicInterfaceAddresses(nic("10.0.0.5", "192.168.1.2", "172.20.0.1", "100.64.0.9", "169.254.1.1"))).toEqual([]);
    expect(publicInterfaceAddresses(nic("192.168.1.2", "45.79.10.20"))).toEqual(["45.79.10.20"]);
  });

  it("reads the address from the network interface, as on a Linode", async () => {
    const ip = await detectPublicIPv4({ interfaces: nic("45.79.10.20"), resolve4: resolvesTo("45.79.10.20"), hostname: "signer.example.com", configured: "" });
    expect(ip).toMatchObject({ address: "45.79.10.20", source: "interface" });
    expect(ip.warning).toBeUndefined();
  });

  it("warns when the hostname's DNS points somewhere else", async () => {
    const ip = await detectPublicIPv4({ interfaces: nic("45.79.10.20"), resolve4: resolvesTo("45.79.99.99"), hostname: "signer.example.com", configured: "" });
    expect(ip.address).toBe("45.79.10.20");
    expect(ip.warning).toMatch(/resolves to 45\.79\.99\.99/);
  });

  it("falls back to DNS behind NAT, and says so", async () => {
    const ip = await detectPublicIPv4({ interfaces: nic("10.0.0.5"), resolve4: resolvesTo("45.79.10.20"), hostname: "signer.example.com", configured: "" });
    expect(ip).toMatchObject({ address: "45.79.10.20", source: "dns" });
    expect(ip.warning).toMatch(/behind NAT/);
  });

  it("lets PUBLIC_IPV4 override detection", async () => {
    const ip = await detectPublicIPv4({ interfaces: nic("45.79.10.20"), resolve4: noDns, hostname: "signer.example.com", configured: "198.51.100.4" });
    expect(ip).toMatchObject({ address: "198.51.100.4", source: "config" });
  });

  it("admits when it cannot tell", async () => {
    const ip = await detectPublicIPv4({ interfaces: nic("10.0.0.5"), resolve4: noDns, hostname: "signer.example.com", configured: "" });
    expect(ip).toMatchObject({ address: null, source: "none" });
  });
});
