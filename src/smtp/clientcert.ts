import fs from "node:fs";
import { X509Certificate } from "node:crypto";
import { config } from "../config.js";

/**
 * The certificate Signer presents when it hands mail back to Microsoft 365.
 *
 * The "Signer receive" connector can recognise Signer by its IP address or by
 * this certificate. By IP, Exchange still has to work out which tenant a
 * message belongs to from its sender's domain, and a message with an empty
 * sender (an out-of-office reply, a read receipt) has none, so it is refused
 * with 4.4.62 ATTR35. By certificate, the connector itself identifies the
 * tenant. Either way, presenting the certificate does no harm: a connector
 * that goes by IP ignores it.
 *
 * It is the same certificate SMTP STARTTLS serves (TLS_CERT_PATH and
 * TLS_KEY_PATH), read at startup; the renewal hook restarts Signer.
 */

const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const ANY_USAGE = "2.5.29.37.0";

export type ClientCertificate = {
  key: Buffer;
  cert: Buffer;
  subject: string;
  names: string[];
  issuer: string;
  validTo: string;
  /** Whether the certificate may be used to identify a client. Exchange needs this for a certificate-based connector. */
  clientAuth: boolean;
};

let cached: ClientCertificate | null | undefined;

function describe(key: Buffer, cert: Buffer): ClientCertificate {
  const x509 = new X509Certificate(cert);
  const field = (dn: string, name: string) => new RegExp(`(?:^|\\n)${name}=([^\\n]+)`).exec(dn)?.[1] ?? "";
  const names = (x509.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((n) => n.startsWith("DNS:"))
    .map((n) => n.slice(4));
  // An empty extended key usage list means "any use"; Node reports that as undefined.
  const usages = x509.keyUsage;
  return {
    key,
    cert,
    subject: field(x509.subject, "CN") || names[0] || "",
    names,
    issuer: field(x509.issuer, "O") || field(x509.issuer, "CN"),
    validTo: new Date(x509.validTo).toISOString(),
    clientAuth: !usages || usages.length === 0 || usages.includes(CLIENT_AUTH) || usages.includes(ANY_USAGE)
  };
}

/** The certificate and key to present, or null when the server has none. */
export function clientCertificate(): ClientCertificate | null {
  if (cached !== undefined) return cached;
  cached = null;
  const { tlsCertPath, tlsKeyPath } = config.smtp;
  if (tlsCertPath && tlsKeyPath && fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath)) {
    try {
      cached = describe(fs.readFileSync(tlsKeyPath), fs.readFileSync(tlsCertPath));
    } catch (err) {
      console.warn(`[signer] Could not read the TLS certificate to present to Microsoft 365: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cached;
}

/** TLS options that present the certificate, for nodemailer and tls.connect. */
export function clientTlsOptions(): { key?: Buffer; cert?: Buffer } {
  const c = clientCertificate();
  return c ? { key: c.key, cert: c.cert } : {};
}

/** For tests: read the certificate again on next use. */
export function resetClientCertificate(): void {
  cached = undefined;
}
