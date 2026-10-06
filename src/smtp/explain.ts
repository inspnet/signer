import type { RelayTarget } from "./route.js";

/**
 * Turns a failure handing mail back to Microsoft 365 or Google into something
 * an admin can act on. The same wording appears in the Activity log and in the
 * return-path test (Settings → Connectors), so a failure seen in one can be
 * reproduced and checked in the other.
 */

type Failure = { message: string; code?: string; responseCode?: number; response?: string };

const GOOGLE_RELAY = /(^|\.)smtp-relay\.gmail\.com$/i;
const MICROSOFT = /\.mail\.protection\.outlook\.com$/i;

function failureOf(err: unknown): Failure {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; responseCode?: unknown; response?: unknown };
    return {
      message: String(e.message ?? err),
      code: typeof e.code === "string" ? e.code : undefined,
      responseCode: typeof e.responseCode === "number" ? e.responseCode : undefined,
      response: typeof e.response === "string" ? e.response : undefined
    };
  }
  return { message: String(err) };
}

/** What probably went wrong and what to do about it, or "" when there is nothing more useful to say. */
export function relayHint(err: unknown, target: Pick<RelayTarget, "host" | "port">): string {
  const f = failureOf(err);
  const text = `${f.message} ${f.response ?? ""}`;
  const where = `${target.host}:${target.port}`;

  if (/5\.7\.64|TenantAttribution/i.test(text)) {
    return (
      "Microsoft 365 did not recognise this server as part of your organisation, so it refused to relay to outside recipients. " +
      "Check that the \"Signer receive\" inbound connector exists, is enabled (Get-InboundConnector \"Signer receive\" | fl Enabled,SenderIPAddresses), " +
      "is of type On-premises, and lists this server's public IPv4 address (Settings → Connectors shows it)."
    );
  }
  if (/5\.7\.(60[6-9]|6[0-4]\d)|banned sending IP|blocked using/i.test(text)) {
    return (
      "Microsoft 365 is refusing this server's IP address as a sender. Delist it at https://sender.office.com, " +
      "and make sure the address is in the \"Signer receive\" inbound connector."
    );
  }
  if (GOOGLE_RELAY.test(target.host) && (/5\.7\.[01]/.test(text) || f.responseCode === 550)) {
    return (
      "Google's SMTP relay refused this server. In the Google Admin console, open Apps → Google Workspace → Gmail → Routing → SMTP relay service " +
      "and add this server's public IPv4 address to the allowed senders, with \"Only addresses in my domains\"."
    );
  }
  if (f.code === "EAUTH" || /authentication|5\.7\.(8|57)\b/i.test(text)) {
    return "The relay rejected the UPSTREAM_USER / UPSTREAM_PASS credentials. Check them in /etc/signer/signer.env, or remove them if the relay identifies Signer by IP address.";
  }
  if (/self[- ]signed|certificate|altnames|CERT_|unable to verify/i.test(text)) {
    return (
      `TLS certificate check against ${target.host} failed. If you set UPSTREAM_HOST to an IP address or another name, ` +
      "use the host name on the certificate (UPSTREAM_TLS_SERVERNAME), rather than turning verification off."
    );
  }
  if (/ECONNREFUSED/.test(text)) {
    return `${where} refused the connection. Check UPSTREAM_HOST and UPSTREAM_PORT, and that nothing on this server (ufw, a firewall) blocks outbound port ${target.port}.`;
  }
  if (f.code === "ETIMEDOUT" || /ETIMEDOUT|timeout|EHOSTUNREACH|ENETUNREACH/i.test(text)) {
    return (
      `Could not reach ${where}; the connection timed out. Linode and most hosts block outbound ports 25, 465 and 587 on new accounts: ` +
      "open a support ticket asking them to lift the SMTP restriction. To confirm from the server: nc -vz -w 10 " +
      `${target.host} ${target.port}`
    );
  }
  if (f.code === "EDNS" || /ENOTFOUND|EAI_AGAIN/.test(text)) {
    return `${target.host} does not resolve. Check UPSTREAM_HOST, or the domain's return host in Settings → Domains.`;
  }
  if (/5\.1\.1|5\.4\.1|recipient.*(rejected|not found)|RecipientNotFound/i.test(text)) {
    return "The recipient address was rejected. If this is one of your own mailboxes, check it exists and its domain is an accepted domain in your tenant.";
  }
  if (f.responseCode && f.responseCode >= 400 && f.responseCode < 500) {
    return "A temporary refusal: Microsoft and Google keep the message queued and retry, so it may still arrive. Repeated deferrals point to throttling or a connector problem.";
  }
  if (MICROSOFT.test(target.host) && /5\.7\.1\b/.test(text)) {
    return "Microsoft 365 refused to relay this message. Check the \"Signer receive\" inbound connector is enabled and lists this server's public IPv4 address.";
  }
  return "";
}

/** A failure handing a message back, carrying where it was going so the log can say so. */
export class RelayError extends Error {
  readonly hint: string;
  readonly code?: string;
  readonly responseCode?: number;

  constructor(
    readonly target: Pick<RelayTarget, "host" | "port" | "route">,
    cause: unknown
  ) {
    const f = failureOf(cause);
    super(`${target.host}:${target.port} (${target.route.via === "mx" ? "the domain's MX" : target.route.via === "override" ? "set in Settings → Domains" : "UPSTREAM_HOST"}): ${f.message}`, {
      cause
    });
    this.name = "RelayError";
    this.code = f.code;
    this.responseCode = f.responseCode;
    this.hint = relayHint(cause, target);
  }
}

/** One line for the Activity log: what failed, then what to do. */
export function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof RelayError ? err.hint : "";
  return hint ? `${message} — ${hint}` : message;
}
