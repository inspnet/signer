import { config } from "../config.js";
import { getSetting, setSetting } from "../db/index.js";
import { sendMailgun } from "./mailgun.js";

/**
 * Emails administrators when messages are deferred (not handed back, so the
 * provider is holding them) or go out unsigned. Configured under
 * Settings → Alerts and sent through Mailgun's HTTP API, never through
 * Signer's own SMTP path, which is usually what is broken.
 *
 * The first problem is reported straight away. Further problems within the
 * alert interval are collected into the next alert, so a stuck relay sends one
 * email per interval rather than one per message. When mail is flowing again
 * after an alert, one recovery email follows.
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
const PROBLEM = new Set(["deferred", "error"]);
const HEALTHY = new Set(["signed", "passed-through", "loop-prevented"]);
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
let lastSentAt = 0;
/** An alert went out and mail has not been seen flowing since. */
let alerted = false;

/** For tests. */
export function resetAlertState(): void {
  pending = [];
  if (timer) clearTimeout(timer);
  timer = null;
  lastSentAt = 0;
  alerted = false;
}

/** Called for every Activity log entry. Never throws: alerting must not affect mail. */
export function noteMailOutcome(status: string, detail: string, sender: string): void {
  try {
    const settings = alertSettings();
    if (!settings.enabled || !alertsConfigured(settings)) return;
    if (PROBLEM.has(status)) {
      pending.push({
        at: new Date().toISOString(),
        status: status as Problem["status"],
        senderDomain: sender.split("@")[1]?.toLowerCase() || "(no sender)",
        detail: redact(detail || "No detail recorded").slice(0, 600)
      });
      if (pending.length > MAX_PENDING) pending.shift();
      schedule(settings);
    } else if (HEALTHY.has(status) && alerted && !pending.length && !timer) {
      alerted = false;
      void deliver(settings, "recovery", recoveryMessage(status));
    }
  } catch (err) {
    console.error("[signer] Alerting failed", err);
  }
}

function schedule(settings: AlertSettings): void {
  if (timer) return;
  const wait = Math.max(0, lastSentAt + settings.intervalMinutes * 60_000 - Date.now());
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, wait);
  timer.unref?.();
}

async function flush(): Promise<void> {
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const settings = alertSettings();
  if (!settings.enabled || !alertsConfigured(settings)) return;
  lastSentAt = Date.now();
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
      "Alerts like this one are sent when messages are deferred or delivered without a signature.",
      settings.enabled ? "Alerts are on." : "Alerts are off: turn them on under Settings → Alerts.",
      "",
      `Settings: ${link("/settings")}`
    ].join("\n")
  });
}

function link(path: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}${path}`;
}

function problemMessage(batch: Problem[], settings: AlertSettings): { subject: string; text: string } {
  const deferred = batch.filter((p) => p.status === "deferred").length;
  const unsigned = batch.length - deferred;
  const parts = [deferred && `${deferred} deferred`, unsigned && `${unsigned} unsigned`].filter(Boolean).join(", ");
  const subject = `Signer: ${batch.length} message${batch.length === 1 ? "" : "s"} with problems (${parts}) on ${config.smtp.hostname}`;

  const reasons = new Map<string, { count: number; domains: Set<string>; status: Problem["status"] }>();
  for (const p of batch) {
    const entry = reasons.get(p.detail) ?? { count: 0, domains: new Set<string>(), status: p.status };
    entry.count += 1;
    entry.domains.add(p.senderDomain);
    reasons.set(p.detail, entry);
  }
  const lines = [...reasons.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([detail, r]) => `- ${r.count}× ${r.status === "deferred" ? "Deferred" : "Unsigned"} (from ${[...r.domains].join(", ")}): ${detail}`);

  const text = [
    `Signer on ${config.smtp.hostname} had problems with ${batch.length} message${batch.length === 1 ? "" : "s"} between ${batch[0]!.at} and ${batch.at(-1)!.at} (UTC).`,
    "",
    deferred
      ? `Deferred: ${deferred}. Not delivered yet: Signer could not hand them back, so Microsoft 365 / Google keep them queued and retry.`
      : "",
    unsigned ? `Unsigned: ${unsigned}. Delivered without a signature.` : "",
    "",
    "Reasons:",
    ...lines,
    reasons.size > 10 ? `- …and ${reasons.size - 10} more in Activity.` : "",
    "",
    `Activity: ${link("/analytics")}`,
    deferred ? `Test the return path: ${link("/settings#return-path")}` : "",
    "",
    `You get at most one alert every ${settings.intervalMinutes} minutes; problems in between go into the next one. Another email follows when mail is flowing again.`
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
