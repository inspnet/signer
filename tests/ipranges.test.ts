import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-ranges-"));
process.env.DATA_DIR = tmp;
process.env.DATABASE_PATH = path.join(tmp, "ranges.db");
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SMTP_ALLOWED_CIDRS = "microsoft";

const { resolveAllowedCidrs, providerFor } = await import("../src/smtp/ipranges.js");
type TxtLookup = (name: string) => Promise<string[]>;

/** Stand-in for DNS. Records are the real published ones unless a test says otherwise. */
function fakeDns(records: Record<string, string>): TxtLookup {
  return async (name: string) => {
    const record = records[name];
    if (!record) throw new Error(`NXDOMAIN ${name}`);
    return [record];
  };
}

const LIVE_MICROSOFT =
  "v=spf1 ip4:40.92.0.0/15 ip4:40.107.0.0/16 ip4:52.100.0.0/15 ip4:52.102.0.0/16 ip4:52.103.0.0/17 " +
  "ip4:104.47.0.0/17 ip6:2a01:111:f400::/48 ip6:2a01:111:f403::/49 ip6:2a01:111:f403:8000::/51 " +
  "ip6:2a01:111:f403:c000::/51 ip6:2a01:111:f403:f000::/52 -all";
const LIVE_GOOGLE =
  "v=spf1 ip4:74.125.0.0/16 ip4:209.85.128.0/17 ip6:2001:4860:4864::/56 ip6:2404:6800:4864::/56 " +
  "ip6:2607:f8b0:4864::/56 ip6:2800:3f0:4864::/56 ip6:2a00:1450:4864::/56 ip6:2c0f:fb50:4864::/56 ~all";
const liveDns = fakeDns({
  "spf.protection.outlook.com": LIVE_MICROSOFT,
  "_spf.google.com": LIVE_GOOGLE
});
const { ipAllowed } = await import("../src/smtp/server.js");

const cacheFile = path.join(tmp, "ip-ranges.cache.json");

beforeEach(() => {
  try {
    fs.unlinkSync(cacheFile);
  } catch {
    /* ignore */
  }
});

describe("provider token parsing", () => {
  it("accepts the documented spellings and aliases", () => {
    for (const token of ["microsoft", "Microsoft", "M365", "office365", "o365", "exchange", "outlook"]) {
      expect(providerFor(token)).toBe("microsoft");
    }
    for (const token of ["google", "Google Workspace", "workspace", "gmail"]) {
      expect(providerFor(token)).toBe("google");
    }
  });

  it("does not mistake a CIDR for a provider", () => {
    expect(providerFor("10.0.0.0/8")).toBeNull();
    expect(providerFor("2a01:111:f400::/48")).toBeNull();
  });
});

describe("literal CIDR entries", () => {
  it("keeps valid ranges and reports the rest", async () => {
    const result = await resolveAllowedCidrs(["10.0.0.0/8", "2001:db8::/32", "192.168.1.5", "not-a-range"]);
    expect(result.cidrs).toContain("10.0.0.0/8");
    expect(result.cidrs).toContain("2001:db8::/32");
    expect(result.cidrs).toContain("192.168.1.5/32");
    expect(result.invalid).toEqual(["not-a-range"]);
    expect(result.failed).toEqual([]);
  });

  it("de-duplicates overlapping entries", async () => {
    const result = await resolveAllowedCidrs(["10.0.0.0/8", "10.0.0.0/8"]);
    expect(result.cidrs.filter((c) => c === "10.0.0.0/8")).toHaveLength(1);
  });
});

describe("matching resolved ranges", () => {
  const cidrs = ["40.107.0.0/16", "2a01:111:f400::/48"];

  it("admits an address inside a range and rejects one outside", () => {
    expect(ipAllowed("40.107.1.2", cidrs)).toBe(true);
    expect(ipAllowed("203.0.113.9", cidrs)).toBe(false);
  });

  it("admits an IPv4 client reported as IPv4-mapped IPv6", () => {
    // Node reports IPv4 peers on a dual-stack listener in this form.
    expect(ipAllowed("::ffff:40.107.1.2", cidrs)).toBe(true);
    expect(ipAllowed("::ffff:203.0.113.9", cidrs)).toBe(false);
  });

  it("matches IPv6 ranges", () => {
    expect(ipAllowed("2a01:111:f400::25", cidrs)).toBe(true);
    expect(ipAllowed("2606:4700::1", cidrs)).toBe(false);
  });

  it("accepts everyone only when the list is empty", () => {
    expect(ipAllowed("203.0.113.9", [])).toBe(true);
  });

  it("rejects an unparseable peer address rather than admitting it", () => {
    expect(ipAllowed("not-an-ip", cidrs)).toBe(false);
  });
});

describe("provider resolution", () => {
  it("expands microsoft to its published sender ranges", async () => {
    const result = await resolveAllowedCidrs(["microsoft"], liveDns);
    expect(result.live).toEqual(["microsoft"]);
    expect(result.failed).toEqual([]);
    expect(result.cidrs).toContain("40.107.0.0/16");
    expect(result.cidrs).toContain("2a01:111:f400::/48");
    expect(ipAllowed("40.107.1.2", result.cidrs)).toBe(true);
    expect(ipAllowed("203.0.113.9", result.cidrs)).toBe(false);
  });

  it("expands google to its published sender ranges", async () => {
    const result = await resolveAllowedCidrs(["google"], liveDns);
    expect(result.cidrs).toContain("209.85.128.0/17");
    expect(ipAllowed("209.85.200.1", result.cidrs)).toBe(true);
    expect(ipAllowed("40.107.1.2", result.cidrs)).toBe(false);
  });

  it("combines providers with literal CIDRs", async () => {
    const result = await resolveAllowedCidrs(["microsoft", "google", "10.1.2.0/24"], liveDns);
    expect(ipAllowed("40.107.1.2", result.cidrs)).toBe(true);
    expect(ipAllowed("209.85.200.1", result.cidrs)).toBe(true);
    expect(ipAllowed("10.1.2.7", result.cidrs)).toBe(true);
    expect(ipAllowed("203.0.113.9", result.cidrs)).toBe(false);
  });
});

describe("SPF parsing", () => {
  it("follows include: and redirect=", async () => {
    const dns = fakeDns({
      "top.example": "v=spf1 ip4:1.1.1.0/24 include:nested.example redirect=more.example -all",
      "nested.example": "v=spf1 ip4:2.2.2.0/24 ~all",
      "more.example": "v=spf1 ip6:2001:db8::/32 ~all"
    });
    const result = await resolveAllowedCidrs(["microsoft"], async (name) =>
      name === "spf.protection.outlook.com" ? ["v=spf1 include:top.example -all"] : dns(name)
    );
    expect(result.cidrs).toContain("1.1.1.0/24");
    expect(result.cidrs).toContain("2.2.2.0/24");
    expect(result.cidrs).toContain("2001:db8::/32");
  });

  it("strips mechanism qualifiers and ignores host-based mechanisms", async () => {
    const result = await resolveAllowedCidrs(["google"], async () => [
      "v=spf1 +ip4:3.3.3.0/24 -ip4:4.4.4.0/24 a mx ptr exists:x.example ~all"
    ]);
    expect(result.cidrs).toEqual(expect.arrayContaining(["3.3.3.0/24", "4.4.4.0/24"]));
    expect(result.cidrs).toHaveLength(2);
  });

  it("terminates on an include: loop instead of recursing forever", async () => {
    const result = await resolveAllowedCidrs(["google"], async (name) =>
      name === "_spf.google.com"
        ? ["v=spf1 ip4:5.5.5.0/24 include:loop.example ~all"]
        : ["v=spf1 include:_spf.google.com ip4:6.6.6.0/24 ~all"]
    );
    expect(result.cidrs).toContain("5.5.5.0/24");
    expect(result.failed).toEqual([]);
  });

  it("treats a record with no v=spf1 as a failure, not an empty allowlist", async () => {
    const result = await resolveAllowedCidrs(["microsoft"], async () => ["some-other-txt-record"]);
    expect(result.failed).toEqual(["microsoft"]);
    expect(result.cidrs).toHaveLength(0);
  });
});

describe("cache behaviour", () => {
  it("writes resolved ranges to disk", async () => {
    await resolveAllowedCidrs(["microsoft"], liveDns);
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(cache.microsoft.cidrs).toContain("40.107.0.0/16");
    expect(cache.microsoft.fetchedAt).toBeTruthy();
  });

  it("falls back to the cached copy when DNS fails", async () => {
    await resolveAllowedCidrs(["microsoft"], liveDns);
    const result = await resolveAllowedCidrs(["microsoft"], async () => {
      throw new Error("SERVFAIL");
    });
    expect(result.stale).toEqual(["microsoft"]);
    expect(result.failed).toEqual([]);
    expect(result.cidrs).toContain("40.107.0.0/16");
  });

  it("reports failure rather than an empty allowlist when DNS fails with no cache", async () => {
    const result = await resolveAllowedCidrs(["microsoft"], async () => {
      throw new Error("SERVFAIL");
    });
    expect(result.failed).toEqual(["microsoft"]);
    expect(result.cidrs).toHaveLength(0);
    // An empty list means "accept everyone", so this must never be the outcome
    // of a failed lookup — initAllowedCidrs turns it into a startup failure.
    expect(ipAllowed("203.0.113.9", result.cidrs)).toBe(true);
  });

  it("does not overwrite a good cache with a failed lookup", async () => {
    await resolveAllowedCidrs(["microsoft"], liveDns);
    await resolveAllowedCidrs(["microsoft"], async () => {
      throw new Error("SERVFAIL");
    });
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(cache.microsoft.cidrs).toContain("40.107.0.0/16");
  });
});

const { initAllowedCidrs, getAllowedCidrs } = await import("../src/smtp/ipranges.js");

describe("startup behaviour", () => {
  it("refuses to start when a provider cannot be resolved and nothing is cached", async () => {
    await expect(
      initAllowedCidrs(async () => {
        throw new Error("SERVFAIL");
      })
    ).rejects.toThrow(/could not be resolved/);
  });

  it("starts on the cached copy when DNS is down", async () => {
    await resolveAllowedCidrs(["microsoft"], liveDns);
    const resolved = await initAllowedCidrs(async () => {
      throw new Error("SERVFAIL");
    });
    expect(resolved.stale).toEqual(["microsoft"]);
    expect(getAllowedCidrs()).toContain("40.107.0.0/16");
  });
});
