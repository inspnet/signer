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
  sessionSecret: env("SESSION_SECRET"),
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
  auth: {
    /** Sign-in attempts allowed per client IP per window. */
    rateLimitMax: envInt("AUTH_RATE_LIMIT_MAX", 20),
    rateLimitWindowMinutes: envInt("AUTH_RATE_LIMIT_WINDOW_MINUTES", 5),
    /** How long a provider's OIDC discovery document is reused. */
    discoveryCacheMinutes: envInt("OIDC_DISCOVERY_CACHE_MINUTES", 60)
  },
  smtp: {
    port: envInt("SMTP_PORT", 25),
    submissionPort: envInt("SMTP_SUBMISSION_PORT", 587),
    altPort: envInt("SMTP_ALT_PORT", 2525),
    hostname: env("SMTP_HOSTNAME", "signer.local"),
    allowedCidrs: env("SMTP_ALLOWED_CIDRS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rangeRefreshMinutes: envInt("SMTP_RANGE_REFRESH_MINUTES", 720),
    tlsCertPath: env("TLS_CERT_PATH"),
    tlsKeyPath: env("TLS_KEY_PATH")
  },
  upstream: {
    host: env("UPSTREAM_HOST"),
    port: envInt("UPSTREAM_PORT", 25),
    secure: envBool("UPSTREAM_SECURE", false),
    user: env("UPSTREAM_USER"),
    pass: env("UPSTREAM_PASS"),
    tlsServername: env("UPSTREAM_TLS_SERVERNAME"),
    tlsRejectUnauthorized: envBool("UPSTREAM_TLS_REJECT_UNAUTHORIZED", true)
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

/**
 * Configuration that is safe in a lab but dangerous once the instance handles
 * real mail. Hard failures abort startup; warnings are printed once and loudly
 * so they cannot be missed in a deploy log.
 */
export function validateConfig(): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];

  if (!config.sessionSecret) {
    if (config.demoMode) {
      warnings.push("SESSION_SECRET is not set; using an ephemeral key. Sessions end when the process restarts.");
    } else {
      fatal.push("SESSION_SECRET is not set. Generate one with: openssl rand -base64 48");
    }
  } else if (config.sessionSecret.length < 32) {
    warnings.push("SESSION_SECRET is shorter than 32 characters. Use at least 48 random bytes.");
  }

  if (config.demoMode) {
    warnings.push("DEMO_MODE is on: sample data is seeded and dev login may be enabled. Never use this for real mail.");
  }

  if (!config.smtp.allowedCidrs.length) {
    warnings.push(
      "SMTP_ALLOWED_CIDRS is empty, so any host that can reach the SMTP ports may relay mail through this " +
        'instance. Set SMTP_ALLOWED_CIDRS="microsoft" or "google" to track the published sender ranges ' +
        "automatically, list explicit CIDRs, or restrict the ports at the firewall (NSG, VPC firewall, " +
        "security group)."
    );
  }

  if (!config.upstream.tlsRejectUnauthorized) {
    warnings.push(
      "UPSTREAM_TLS_REJECT_UNAUTHORIZED is off: mail is relayed upstream without verifying the server " +
        "certificate, so the connection can be intercepted."
    );
  }

  if (!config.demoMode && !entraConfigured() && !googleLoginConfigured()) {
    warnings.push("Neither Entra nor Google login is configured; nobody can sign in to the portal.");
  }

  if (!config.superAdminEmail) {
    warnings.push("SUPER_ADMIN_EMAIL is not set, so no account is granted the super admin role.");
  }

  if (!config.upstream.host) {
    warnings.push("UPSTREAM_HOST is not set; processed mail cannot be returned to Microsoft 365 or Google.");
  }

  return { fatal, warnings };
}
