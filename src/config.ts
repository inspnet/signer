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

/**
 * Which peers may set X-Forwarded-For. Only the reverse proxy in front of the
 * portal should be trusted: Nginx on the same machine (loopback),
 * or Caddy reaching a container through Docker's bridge (uniquelocal). Trusting
 * every peer would let a client pick its own address by sending the header
 * itself, which defeats the per-IP sign-in limit.
 *
 * Accepts addresses, CIDRs and the proxy-addr names loopback, linklocal and
 * uniquelocal, comma-separated. Fastify ignores hop counts, so a number is
 * rejected at startup rather than silently trusting nobody.
 */
export function parseTrustProxy(value: string | undefined): boolean | string {
  const raw = (value ?? "").trim();
  if (!raw) return "loopback";
  if (["true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["false", "no", "off"].includes(raw.toLowerCase())) return false;
  return raw;
}

const dataDir = path.resolve(env("DATA_DIR", "./data"));

export const config = {
  publicUrl: env("PUBLIC_URL", "http://localhost:3000").replace(/\/$/, ""),
  superAdminEmail: env("SUPER_ADMIN_EMAIL").toLowerCase(),
  /** The organisation's main email domain. Only seeds the domain list; manage the rest in the portal. */
  primaryDomain: env("PRIMARY_DOMAIN").toLowerCase().replace(/^@/, ""),
  sessionSecret: env("SESSION_SECRET"),
  databasePath: path.resolve(env("DATABASE_PATH", path.join(dataDir, "signer.db"))),
  dataDir,
  httpPort: envInt("HTTP_PORT", 3000),
  /** 127.0.0.1 when a reverse proxy on the same host fronts the portal; 0.0.0.0 inside Docker. */
  httpHost: env("HTTP_HOST", "0.0.0.0"),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  corsOrigins: env("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  demoMode: envBool("DEMO_MODE", false),
  allowDevLogin: envBool("AUTH_ALLOW_DEV_LOGIN", false),
  processedHeader: env("PROCESSED_HEADER", "X-Signer-MessageProcessed"),
  failureMode: env("FAILURE_MODE", "fail-open") as "fail-open" | "fail-closed",
  directorySyncMinutes: envInt("DIRECTORY_SYNC_MINUTES", 60),
  retention: {
    /** Days to keep the per-message activity log (sender, recipients, outcome). 0 keeps it forever. */
    mailLogDays: envInt("MAIL_LOG_RETENTION_DAYS", 30),
    /** Days to keep the admin audit trail. 0 keeps it forever. */
    auditLogDays: envInt("AUDIT_LOG_RETENTION_DAYS", 365)
  },
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
    tlsRejectUnauthorized: envBool("UPSTREAM_TLS_REJECT_UNAUTHORIZED", true),
    /**
     * auto: when the upstream is Microsoft 365, return each sender domain's mail
     * to that domain's own MX. fixed: always UPSTREAM_HOST.
     */
    routing: (env("UPSTREAM_ROUTING", "auto").toLowerCase() === "fixed" ? "fixed" : "auto") as "auto" | "fixed"
  },
  entra: {
    tenantId: env("ENTRA_TENANT_ID"),
    clientId: env("ENTRA_CLIENT_ID"),
    clientSecret: env("ENTRA_CLIENT_SECRET")
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

function readable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
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
        "automatically, list explicit CIDRs, or restrict the ports at the firewall (ufw, Linode Cloud " +
        "Firewall)."
    );
  }

  if (typeof config.trustProxy === "string" && /^\d+$/.test(config.trustProxy)) {
    fatal.push(
      `TRUST_PROXY=${config.trustProxy} is a hop count, which this server does not support. ` +
        "Name the proxy instead: loopback (Nginx on the same machine) or loopback,uniquelocal (Docker)."
    );
  }

  if (config.trustProxy === true) {
    warnings.push(
      "TRUST_PROXY is true, so any client can set its own address with X-Forwarded-For and bypass the " +
        "sign-in rate limit. Name the proxy instead, e.g. loopback."
    );
  }

  if (config.smtp.tlsCertPath || config.smtp.tlsKeyPath) {
    for (const [name, file] of [
      ["TLS_CERT_PATH", config.smtp.tlsCertPath],
      ["TLS_KEY_PATH", config.smtp.tlsKeyPath]
    ] as const) {
      if (!file) {
        fatal.push(`${name} is not set. Set both TLS_CERT_PATH and TLS_KEY_PATH, or neither.`);
      } else if (!readable(file)) {
        fatal.push(`${name} points at ${file}, which does not exist or cannot be read by this process.`);
      }
    }
  } else if (!config.demoMode) {
    warnings.push(
      "TLS_CERT_PATH / TLS_KEY_PATH are not set, so the SMTP listeners do not offer STARTTLS. Microsoft 365 " +
        "connectors require TLS and will not deliver to this host until a certificate is configured."
    );
  }

  if (!config.demoMode && config.smtp.hostname === "signer.local") {
    warnings.push("SMTP_HOSTNAME is not set. Set it to the name on the TLS certificate, e.g. signer.example.com.");
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

  // Sync now always uses the sign-in app; a separate directory app is no longer read.
  for (const legacy of ["ENTRA_DIRECTORY_CLIENT_ID", "ENTRA_DIRECTORY_CLIENT_SECRET"]) {
    if (env(legacy)) {
      warnings.push(
        `${legacy} is no longer used: directory sync uses ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET. Remove it, and give ` +
          "that app the Application permissions User.Read.All, Group.Read.All and GroupMember.Read.All."
      );
    }
  }

  if (!config.superAdminEmail) {
    warnings.push("SUPER_ADMIN_EMAIL is not set, so no account is granted the super admin role.");
  }

  if (!config.upstream.host) {
    warnings.push("UPSTREAM_HOST is not set; processed mail cannot be returned to Microsoft 365 or Google.");
  }

  return { fatal, warnings };
}
