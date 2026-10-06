import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-accept-"));
process.env.DATABASE_PATH = path.join(tmp, "accept.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "false";
process.env.SUPER_ADMIN_EMAIL = "it@example.com";
process.env.PRIMARY_DOMAIN = "example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";

const { initDb, closeDb } = await import("../src/db/index.js");
const { config } = await import("../src/config.js");
const { authorizeInbound, InboundRefusal } = await import("../src/smtp/accept.js");
const { resolveIpv4 } = await import("../src/smtp/ipv4.js");
const { hasProcessedHeader, hasValidStamp, sealProcessed } = await import("../src/mail/stamp.js");

const conn = { ip: "::ffff:203.0.113.5", helo: "mail.example", sender: "ada@example.com" };

function message(from?: string): Buffer {
  const headers = ["To: bob@contoso.com", "Subject: Hi", "Content-Type: text/plain"];
  if (from) headers.unshift(`From: ${from}`);
  return Buffer.from([...headers, "", "Hello"].join("\r\n"));
}

beforeEach(() => {
  closeDb();
  initDb();
  config.demoMode = false;
});

afterEach(() => {
  closeDb();
  config.demoMode = false;
});

describe("inbound acceptance", () => {
  it("refuses a From domain that is not listed, without calling DMARC", async () => {
    await expect(
      authorizeInbound(message("Ada <ada@elsewhere.test>"), conn, async () => {
        throw new Error("should not check DMARC");
      })
    ).rejects.toMatchObject({ responseCode: 550, message: expect.stringContaining("elsewhere.test") });
  });

  it("refuses a message with no From address", async () => {
    await expect(authorizeInbound(message(), conn, async () => ({ result: "pass" }))).rejects.toBeInstanceOf(InboundRefusal);
  });

  it("accepts a listed domain when DMARC passes", async () => {
    const result = await authorizeInbound(message("Ada <ada@example.com>"), conn, async () => ({
      result: "pass",
      spf: "pass"
    }));
    expect(result.domain).toBe("example.com");
  });

  it("defers a temporary DMARC failure and refuses a permanent one", async () => {
    await expect(authorizeInbound(message("ada@example.com"), conn, async () => ({ result: "temperror", spf: "temperror" }))).rejects.toMatchObject({
      responseCode: 451
    });
    await expect(authorizeInbound(message("ada@example.com"), conn, async () => ({ result: "fail", spf: "fail", dkim: "none" }))).rejects.toMatchObject({
      responseCode: 550,
      message: expect.stringContaining("spf=fail")
    });
  });

  it("does not query DMARC in demo mode", async () => {
    config.demoMode = true;
    const result = await authorizeInbound(message("ada@example.com"), conn, async () => {
      throw new Error("should not check DMARC");
    });
    expect(result.domain).toBe("example.com");
  });
});

describe("processed stamp", () => {
  it("seals a message the public header alone cannot impersonate", () => {
    const raw = Buffer.from("From: ada@example.com\r\n\r\nBody");
    const sealed = sealProcessed(raw);
    expect(hasProcessedHeader(sealed)).toBe(true);
    expect(hasValidStamp(sealed)).toBe(true);
    const forged = Buffer.from("X-Signer-MessageProcessed: true\r\nFrom: ada@example.com\r\n\r\nBody");
    expect(hasValidStamp(forged)).toBe(false);
    expect(hasValidStamp(Buffer.from(sealed.toString("latin1").replace("Body", "Evil"), "latin1"))).toBe(false);
  });
});

describe("IPv4 return path", () => {
  it("keeps an IPv4 address and refuses an IPv6 address", async () => {
    await expect(resolveIpv4("192.0.2.10")).resolves.toBe("192.0.2.10");
    await expect(resolveIpv4("2001:db8::1")).rejects.toThrow(/IPv4 only/);
  });
});
