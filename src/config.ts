import fs from "node:fs";
import path from "node:path";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = path.resolve(env("DATA_DIR", "./data"));

export const config = {
  publicUrl: env("PUBLIC_URL", "http://localhost:3000").replace(/\/$/, ""),
  superAdminEmail: env("SUPER_ADMIN_EMAIL").toLowerCase(),
  sessionSecret: env("SESSION_SECRET", "dev-only-insecure-session-secret"),
  databasePath: path.resolve(env("DATABASE_PATH", path.join(dataDir, "signer.db"))),
  dataDir,
  httpPort: envInt("HTTP_PORT", 3000),
  corsOrigins: env("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  demoMode: envBool("DEMO_MODE", false),
  allowDevLogin: envBool("AUTH_ALLOW_DEV_LOGIN", false),
  processedHeader: env("PROCESSED_HEADER", "X-Signer-MessageProcessed"),
  failureMode: env("FAILURE_MODE", "fail-open") as "fail-open" | "fail-closed",
  directorySyncMinutes: envInt("DIRECTORY_SYNC_MINUTES", 240),
  smtp: {
    port: envInt("SMTP_PORT", 25),
    submissionPort: envInt("SMTP_SUBMISSION_PORT", 587),
    altPort: envInt("SMTP_ALT_PORT", 2525),
    hostname: env("SMTP_HOSTNAME", "signer.local"),
    allowedCidrs: env("SMTP_ALLOWED_CIDRS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tlsCertPath: env("TLS_CERT_PATH"),
    tlsKeyPath: env("TLS_KEY_PATH")
  },
  upstream: {
    host: env("UPSTREAM_HOST"),
    port: envInt("UPSTREAM_PORT", 25),
    secure: envBool("UPSTREAM_SECURE", false),
    user: env("UPSTREAM_USER"),
    pass: env("UPSTREAM_PASS"),
    tlsServername: env("UPSTREAM_TLS_SERVERNAME")
  },
  entra: {
    tenantId: env("ENTRA_TENANT_ID"),
    clientId: env("ENTRA_CLIENT_ID"),
    clientSecret: env("ENTRA_CLIENT_SECRET"),
    directoryClientId: env("ENTRA_DIRECTORY_CLIENT_ID") || env("ENTRA_CLIENT_ID"),
    directoryClientSecret: env("ENTRA_DIRECTORY_CLIENT_SECRET") || env("ENTRA_CLIENT_SECRET")
  },
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    serviceAccountJson: env("GOOGLE_SERVICE_ACCOUNT_JSON"),
    adminEmail: env("GOOGLE_ADMIN_EMAIL")
  }
};

export function entraConfigured(): boolean {
  return Boolean(config.entra.tenantId && config.entra.clientId && config.entra.clientSecret);
}

export function googleLoginConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

export function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "uploads"), { recursive: true });
}
