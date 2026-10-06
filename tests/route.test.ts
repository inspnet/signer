import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-route-"));
process.env.DATABASE_PATH = path.join(tmp, "route.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "false";
process.env.SUPER_ADMIN_EMAIL = "admin@contoso.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.UPSTREAM_HOST = "contoso-com.mail.protection.outlook.com";

const db = await import("../src/db/index.js");
const { config } = await import("../src/config.js");
const { returnRouteFor, clearRouteCache, perDomainMx } = await import("../src/smtp/route.js");

const mx = (records: Record<string, string>) => async (domain: string) => {
  if (!(domain in records)) throw Object.assign(new Error(`queryMx ENOTFOUND ${domain}`), { code: "ENOTFOUND" });
  return records[domain] ? [{ exchange: records[domain]!, priority: 10 }] : [];
};

beforeEach(() => {
  db.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
  db.initDb();
  db.addDomain("fabrikam.com", "admin@contoso.com");
  db.addDomain("filtered.example", "admin@contoso.com");
  clearRouteCache();
  config.upstream.routing = "auto";
});

afterAll(() => db.closeDb());

const records = {
  "contoso.com": "contoso-com.mail.protection.outlook.com.",
  "fabrikam.com": "fabrikam-com.mail.protection.outlook.com",
  "filtered.example": "eu-smtp-inbound-1.mimecast.com"
};

describe("returning signed mail", () => {
  it("routes per domain when the upstream is Microsoft 365", () => {
    expect(perDomainMx()).toBe(true);
  });

  it("sends each domain back to its own Microsoft 365 endpoint", async () => {
    const lookup = mx(records);
    expect(await returnRouteFor("a@contoso.com", lookup)).toMatchObject({ host: "contoso-com.mail.protection.outlook.com", via: "mx" });
    expect(await returnRouteFor("b@fabrikam.com", lookup)).toMatchObject({ host: "fabrikam-com.mail.protection.outlook.com", via: "mx" });
  });

  it("does not hand mail to a domain's filtering service; it uses the setup host", async () => {
    const route = await returnRouteFor("c@filtered.example", mx(records));
    expect(route).toMatchObject({ host: "contoso-com.mail.protection.outlook.com", via: "default" });
    expect(route.detail).toMatch(/not a Microsoft 365 endpoint/);
  });

  it("falls back to the setup host when DNS fails, rather than failing the message", async () => {
    const route = await returnRouteFor("d@fabrikam.com", mx({}));
    expect(route).toMatchObject({ host: "contoso-com.mail.protection.outlook.com", via: "default" });
    expect(route.detail).toMatch(/MX lookup for fabrikam\.com failed/);
  });

  it("never routes per domain for senders outside the domain list", async () => {
    const route = await returnRouteFor("x@unlisted.example", mx({ "unlisted.example": "unlisted-example.mail.protection.outlook.com" }));
    expect(route).toMatchObject({ host: "contoso-com.mail.protection.outlook.com", via: "default" });
  });

  it("uses a return host an admin set for the domain", async () => {
    db.setDomainReturnHost("filtered.example", "Filtered-Example.mail.protection.outlook.com.");
    const route = await returnRouteFor("c@filtered.example", mx(records));
    expect(route).toMatchObject({ host: "filtered-example.mail.protection.outlook.com", via: "override" });
    db.setDomainReturnHost("filtered.example", "");
    expect((await returnRouteFor("c@filtered.example", mx(records))).via).toBe("default");
  });

  it("rejects a return host that is not a host name", () => {
    expect(() => db.setDomainReturnHost("fabrikam.com", "not a host")).toThrow(db.DomainError);
  });

  it("keeps one fixed upstream when UPSTREAM_ROUTING=fixed", async () => {
    config.upstream.routing = "fixed";
    expect(perDomainMx()).toBe(false);
    expect(await returnRouteFor("b@fabrikam.com", mx(records))).toMatchObject({
      host: "contoso-com.mail.protection.outlook.com",
      via: "default"
    });
  });

  it("never uses MX for a Google relay upstream", async () => {
    const original = config.upstream.host;
    config.upstream.host = "smtp-relay.gmail.com";
    try {
      expect(perDomainMx()).toBe(false);
      expect((await returnRouteFor("b@fabrikam.com", mx({ "fabrikam.com": "aspmx.l.google.com" }))).host).toBe("smtp-relay.gmail.com");
    } finally {
      config.upstream.host = original;
    }
  });
});
