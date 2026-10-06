import { config } from "../config.js";
import { getSetting, setSetting } from "../db/index.js";
import { sendMailgun } from "./mailgun.js";

/**
 * Emails administrators when messages are not being handed back. Configured
 * under Settings → Alerts and sent through Mailgun's HTTP API, never through
 * Signer's own SMTP path, which is usually what is broken.
 *
 * A single refusal, or a burst of the same one, does not send mail. An alert
 * goes out only after messages have failed to send for the whole interval
 * (15 minutes unless changed) with nothing handed back in between. That outage
 * sends one email. When a message is delivered again, one recovery email
 * follows, and a later outage has to last the full interval before another alert.
 *
 * Alerts carry counts, reasons and sender domains. Email addresses in the
 * reasons are replaced with [address]; the full detail stays in Activity.
 */

export type AlertSettings = {
  enabled: boolean;
  domain: string;
  region: "us" | "eu";
  apiKey: string;
  from: string;
  recipients: string[];
  intervalMinutes: number;
};

export type AlertResult = { at: string; ok: boolean; kind: "problem" | "recovery" | "test"; detail: string };

type Problem = { at: string; status: "deferred" | "error"; senderDomain: string; detail: string };

const KEY = "alerts";
const LAST_KEY = "alerts_last";
/** Handed back, including unsigned: the message left, so mail is sending. */
const DELIVERED = new Set(["signed", "passed-through", "loop-prevented", "error"]);
const MAX_PENDING = 500;

export function alertSettings(): AlertSettings {
  let stored: Partial<AlertSettings> = {};
  try {
    stored = JSON.parse(getSetting(KEY, "{}")) as Partial<AlertSettings>;
  } catch {
    /* fall back to defaults */
  }
  return {
    enabled: Boolean(stored.enabled),
    domain: stored.domain ?? "",
    region: stored.region === "eu" ? "eu" : "us",
    apiKey: stored.apiKey ?? "",
    from: stored.from ?? "",
    recipients: stored.recipients?.length ? stored.recipients : config.superAdminEmail ? [config.superAdminEmail] : [],
    intervalMinutes: stored.intervalMinutes && stored.intervalMinutes >= 1 ? stored.intervalMinutes : 15
  };
}

export function saveAlertSettings(next: AlertSettings): void {
  setSetting(KEY, JSON.stringify(next));
}

export function lastAlert(): AlertResult | null {
  try {
    return JSON.parse(getSetting(LAST_KEY, "null")) as AlertResult | null;
  } catch {
    return null;
  }
}

/** Ready to send: enabled is a separate switch, so a test can run before it is on. */
export function alertsConfigured(s: AlertSettings = alertSettings()): boolean {
  return Boolean(s.domain && s.apiKey && s.recipients.length);
}

const fromAddress = (s: AlertSettings) => s.from || `Signer alerts <signer@${s.domain}>`;
const redact = (text: string) => text.replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,}/gi, "[address]");

let pending: Problem[] = [];
let timer: NodeJS.Timeout | null = null;
/** When this run of undelivered messages started. 0 while mail is flowing. */
let outageStartedAt = 0;
/** This outage already produced its one alert. */
let alerted = false;

/** For tests. */
export function resetAlertState(): void {
  pending = [];
  if (timer) clearTimeout(timer);
  timer = null;
  outageStartedAt = 0;
  alerted = false;
}

/** Called for every Activity log entry. Never throws: alerting must not affect mail. */
export function noteMailOutcome(status: string, detail: string, sender: string): void {
  try {
    const settings = alertSettings();
    if (!settings.enabled || !alertsConfigured(settings)) return;
    if (DELIVERED.has(status)) {
      clearWait();
      pending = [];
      if (alerted) {
        alerted = false;
        outageStartedAt = 0;
        void deliver(settings, "recovery", recoveryMessage(status));
      } else {
        outageStartedAt = 0;
      }
      return;
    }
    if (status !== "deferred" || alerted) return;
    if (!outageStartedAt) outageStartedAt = Date.now();
    pending.push({
      at: new Date().toISOString(),
      status: "deferred",
      senderDomain: sender.split("@")[1]?.toLowerCase() || "(no sender)",
      detail: redact(detail || "No detail recorded").slice(0, 600)
    });
    if (pending.length > MAX_PENDING) pending.shift();
    schedule(settings);
  } catch (err) {
    console.error("[signer] Alerting failed", err);
  }
}

function clearWait(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(settings: AlertSettings): void {
  if (timer || alerted || !outageStartedAt) return;
  const wait = Math.max(0, outageStartedAt + settings.intervalMinutes * 60_000 - Date.now());
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, wait);
  timer.unref?.();
}

async function flush(): Promise<void> {
  const settings = alertSettings();
  if (!settings.enabled || !alertsConfigured(settings) || !outageStartedAt || !pending.length) {
    pending = [];
    outageStartedAt = 0;
    return;
  }
  const due = outageStartedAt + settings.intervalMinutes * 60_000;
  if (Date.now() < due) {
    schedule(settings);
    return;
  }
  const batch = pending;
  pending = [];
  alerted = true;
  await deliver(settings, "problem", problemMessage(batch, settings));
}

async function deliver(settings: AlertSettings, kind: AlertResult["kind"], message: { subject: string; text: string }): Promise<AlertResult> {
  let result: AlertResult;
  try {
    await sendMailgun(settings, { from: fromAddress(settings), to: settings.recipients, ...message });
    result = { at: new Date().toISOString(), ok: true, kind, detail: `Sent "${message.subject}" to ${settings.recipients.join(", ")}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[signer] Could not send a ${kind} alert through Mailgun: ${detail}`);
    result = { at: new Date().toISOString(), ok: false, kind, detail };
  }
  try {
    setSetting(LAST_KEY, JSON.stringify(result));
  } catch {
    /* the result is a convenience for the Alerts tab */
  }
  return result;
}

export function sendTestAlert(): Promise<AlertResult> {
  const settings = alertSettings();
  return deliver(settings, "test", {
    subject: `Signer test alert (${config.smtp.hostname})`,
    text: [
      `This is a test from Signer on ${config.smtp.hostname}.`,
      "",
      "An alert like this one is sent only after messages have failed to send for the whole alert interval.",
      settings.enabled ? "Alerts are on." : "Alerts are off: turn them on under Settings → Alerts.",
      "",
      `Settings: ${link("/settings")}`
    ].join("\n")
  });
}

function link(path: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}${path}`;
}

/** Request ids and timestamps change on every retry of the same refusal. */
function reasonKey(detail: string): string {
  return detail
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z[0-9a-z]*/gi, "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function problemMessage(batch: Problem[], settings: AlertSettings): { subject: string; text: string } {
  const subject = `Signer: mail has not been sending for ${settings.intervalMinutes} minutes on ${config.smtp.hostname}`;

  const reasons = new Map<string, { count: number; domains: Set<string>; detail: string }>();
  for (const p of batch) {
    const key = reasonKey(p.detail);
    const entry = reasons.get(key) ?? { count: 0, domains: new Set<string>(), detail: p.detail };
    entry.count += 1;
    entry.domains.add(p.senderDomain);
    reasons.set(key, entry);
  }
  const lines = [...reasons.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((r) => `- ${r.count}× Deferred (from ${[...r.domains].join(", ")}): ${r.detail}`);

  const text = [
    `Signer on ${config.smtp.hostname} has not handed a message back since ${batch[0]!.at} (UTC).`,
    `${batch.length} message${batch.length === 1 ? "" : "s"} ${batch.length === 1 ? "is" : "are"} still queued at Microsoft 365 or Google, which will retry.`,
    "",
    "Reasons:",
    ...lines,
    reasons.size > 10 ? `- …and ${reasons.size - 10} more in Activity.` : "",
    "",
    `Activity: ${link("/analytics")}`,
    `Test the return path: ${link("/settings#return-path")}`,
    "",
    `This outage sends one email, after ${settings.intervalMinutes} minutes without a delivered message. Another email follows when a message is handed back.`
  ];
  return { subject, text: text.filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n") };
}

function recoveryMessage(status: string): { subject: string; text: string } {
  return {
    subject: `Signer: mail is flowing again on ${config.smtp.hostname}`,
    text: [
      `A message was just ${status === "signed" ? "signed and handed back" : "handed back"} successfully, and no problems are waiting to be reported.`,
      "",
      "Deferred messages are retried by Microsoft 365 / Google on their own schedule, so they should arrive shortly.",
      "",
      `Activity: ${link("/analytics")}`
    ].join("\n")
  };
}
