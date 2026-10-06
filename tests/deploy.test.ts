import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-deploy-"));
process.env.DATABASE_PATH = path.join(tmp, "deploy.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "true";
process.env.AUTH_ALLOW_DEV_LOGIN = "true";
process.env.SUPER_ADMIN_EMAIL = "it-admin@example.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SMTP_HOSTNAME = "signer.example.com";

const { config, validateConfig } = await import("../src/config.js");
const { initDb, closeDb } = await import("../src/db/index.js");
const { authPlugin, registerAuthRoutes } = await import("../src/auth/index.js");
const { registerApi } = await import("../src/routes/api.js");

const original = structuredClone({ smtp: config.smtp, demoMode: config.demoMode, trustProxy: config.trustProxy });

function restore(): void {
  Object.assign(config.smtp, structuredClone(original.smtp));
  config.demoMode = original.demoMode;
  config.trustProxy = original.trustProxy;
}

describe("startup checks for a production host", () => {
  beforeEach(restore);
  afterAll(restore);

  it("refuses to start when a configured certificate file is missing", () => {
    // Silently dropping STARTTLS would stop Microsoft 365 delivering, with no error anywhere.
    config.smtp.tlsCertPath = path.join(tmp, "missing-fullchain.pem");
    config.smtp.tlsKeyPath = path.join(tmp, "missing-privkey.pem");
    const { fatal } = validateConfig();
    expect(fatal.some((f) => f.includes("TLS_CERT_PATH"))).toBe(true);
    expect(fatal.some((f) => f.includes("TLS_KEY_PATH"))).toBe(true);
  });

  it("refuses half a certificate configuration", () => {
    const cert = path.join(tmp, "fullchain.pem");
    fs.writeFileSync(cert, "cert");
    config.smtp.tlsCertPath = cert;
    config.smtp.tlsKeyPath = "";
    const { fatal } = validateConfig();
    expect(fatal).toEqual([expect.stringContaining("TLS_KEY_PATH is not set")]);
  });

  it("accepts a readable certificate and key", () => {
    const cert = path.join(tmp, "ok-fullchain.pem");
    const key = path.join(tmp, "ok-privkey.pem");
    fs.writeFileSync(cert, "cert");
    fs.writeFileSync(key, "key");
    config.smtp.tlsCertPath = cert;
    config.smtp.tlsKeyPath = key;
    expect(validateConfig().fatal).toEqual([]);
  });

  it("warns outside demo mode when SMTP has no certificate", () => {
    config.demoMode = false;
    config.smtp.tlsCertPath = "";
    config.smtp.tlsKeyPath = "";
    const { warnings } = validateConfig();
    expect(warnings.some((w) => w.includes("STARTTLS"))).toBe(true);
  });

  it("rejects a hop count for TRUST_PROXY, which Fastify would quietly ignore", () => {
    config.trustProxy = "1";
    expect(validateConfig().fatal.some((f) => f.includes("TRUST_PROXY"))).toBe(true);
  });

  it("warns when every peer is trusted to set X-Forwarded-For", () => {
    config.trustProxy = true;
    expect(validateConfig().warnings.some((w) => w.includes("TRUST_PROXY is true"))).toBe(true);
  });
});

describe("Microsoft 365 connector instructions", () => {
  let app: FastifyInstance;
  let cookieHeader = "";

  beforeAll(async () => {
    initDb();
    app = Fastify();
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    await app.register(authPlugin);
    registerAuthRoutes(app);
    registerApi(app);
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/auth/dev-login" });
    cookieHeader = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  });

  afterAll(async () => {
    await app.close();
    closeDb();
  });

  async function mailFlow(): Promise<{ microsoft: { powershell: string; sendConnector: { smartHost: string } } }> {
    const res = await app.inject({ method: "GET", url: "/api/mail-flow", headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("returns signed mail through an on-premises connector, so Exchange relays it to external recipients", async () => {
    const { microsoft } = await mailFlow();
    const inbound = microsoft.powershell.split("\n").find((l) => l.startsWith("New-InboundConnector"))!;
    expect(inbound).toContain("-ConnectorType OnPremises");
    expect(inbound).toContain("-SenderIPAddresses $signerIp");
    expect(inbound).toContain("-RequireTls $true");
  });

  it("never restricts all sender domains to Signer", async () => {
    // With -SenderDomains *, either restriction rejects every inbound message
    // to the tenant that does not come from Signer.
    const { microsoft } = await mailFlow();
    expect(microsoft.powershell).not.toContain("RestrictDomainsToCertificate $true");
    expect(microsoft.powershell).not.toContain("RestrictDomainsToIPAddresses $true");
  });

  it("creates the routing rule disabled, with pilot and go-live steps", async () => {
    const { microsoft } = await mailFlow();
    const create = microsoft.powershell.split("\n").find((l) => l.startsWith("New-TransportRule"))!;
    expect(create).toContain("-Enabled $false");
    expect(microsoft.powershell).toMatch(/Set-TransportRule .* -From "pilot\.user@yourdomain\.com" -Enabled \$true/);
    expect(microsoft.powershell).toMatch(/Set-TransportRule .* -From \$null/);
  });

  it("validates Signer's certificate and does not advertise a port Exchange cannot use", async () => {
    const { microsoft } = await mailFlow();
    expect(microsoft.powershell).toContain("-TlsSettings DomainValidation -TlsDomain $smartHost");
    expect(microsoft.sendConnector.smartHost).toBe("signer.example.com");
  });
});
