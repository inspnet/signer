import type { DirectoryUser } from "../directory/fields.js";
import type { AdvancedRule, DateTimeRule, RecipientRule, RuleSet, SenderRule } from "../db/index.js";

export type RuleContext = {
  sender: DirectoryUser;
  senderEmail: string;
  recipientEmails: string[];
  internalDomains: string[];
  subject: string;
  bodyText: string;
  latestBodyText: string;
  isReply: boolean;
  now?: Date;
};

export type RuleCheck = {
  name: string;
  applicable: boolean;
  passed: boolean;
  detail: string;
};

export type Evaluation = {
  applied: boolean;
  checks: RuleCheck[];
  stopProcessing: boolean;
};

function norm(email: string): string {
  return email.trim().toLowerCase();
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function wildcardMatch(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("@")) return wildcardMatch(`*${p}`, value);
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function matchesSender(rule: SenderRule | undefined, ctx: RuleContext): { passed: boolean; detail: string; applicable: boolean } {
  if (!rule || (!rule.everyone && !rule.emails?.length && !rule.domains?.length && !rule.groups?.length)) {
    return { passed: true, detail: "No sender restriction", applicable: false };
  }
  if (rule.everyone) return { passed: true, detail: "Everyone", applicable: true };
  const email = norm(ctx.senderEmail);
  if (rule.emails?.some((e) => wildcardMatch(e, email))) {
    return { passed: true, detail: "Sender email matched", applicable: true };
  }
  if (rule.domains?.some((d) => wildcardMatch(d.replace(/^@/, ""), domainOf(email)) || wildcardMatch(`*@${d.replace(/^@/, "")}`, email))) {
    return { passed: true, detail: "Sender domain matched", applicable: true };
  }
  if (rule.groups?.some((g) => ctx.sender.groupIds.includes(g))) {
    return { passed: true, detail: "Sender group matched", applicable: true };
  }
  return { passed: false, detail: "Sender did not match", applicable: true };
}

function matchesRecipients(rule: RecipientRule | undefined, ctx: RuleContext): { passed: boolean; detail: string; applicable: boolean } {
  if (!rule || (rule.any && !rule.internal && !rule.external && !rule.emails?.length && !rule.domains?.length)) {
    return { passed: true, detail: "Any recipient", applicable: false };
  }
  const recipients = ctx.recipientEmails.map(norm).filter(Boolean);
  if (!recipients.length) return { passed: false, detail: "No recipients", applicable: true };

  const isInternal = (email: string) => ctx.internalDomains.includes(domainOf(email));

  if (rule.exceptEmails?.some((p) => recipients.some((r) => wildcardMatch(p, r)))) {
    return { passed: false, detail: "Recipient exclusion (address) matched", applicable: true };
  }
  if (rule.exceptDomains?.some((d) => recipients.some((r) => wildcardMatch(d.replace(/^@/, ""), domainOf(r))))) {
    return { passed: false, detail: "Recipient exclusion (domain) matched", applicable: true };
  }

  const checks: boolean[] = [];
  if (rule.any) checks.push(true);
  if (rule.internal) checks.push(recipients.every(isInternal));
  if (rule.external) checks.push(recipients.some((r) => !isInternal(r)));
  if (rule.emails?.length) checks.push(recipients.some((r) => rule.emails!.some((p) => wildcardMatch(p, r))));
  if (rule.domains?.length) {
    checks.push(recipients.some((r) => rule.domains!.some((d) => wildcardMatch(d.replace(/^@/, ""), domainOf(r)))));
  }

  if (!checks.length) return { passed: true, detail: "Any recipient", applicable: false };
  const passed = checks.some(Boolean);
  return { passed, detail: passed ? "Recipient conditions met" : "Recipient conditions not met", applicable: true };
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

type ZonedClock = { day: number; hour: number; minute: number; wallClock: string };

/**
 * Read the wall clock in a given IANA zone.
 *
 * A schedule means what the clock on the wall says where the business is, not
 * where the server happens to run. Without this, a 09:00-17:00 rule set in
 * Europe/London silently follows the host's zone — and a container almost
 * always runs UTC.
 */
export function zonedClock(now: Date, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number.parseInt(value("hour"), 10);
  const minute = Number.parseInt(value("minute"), 10);
  return {
    day: WEEKDAY_INDEX[value("weekday")] ?? 0,
    hour,
    minute,
    // Sortable local wall-clock stamp, same shape a datetime-local input emits.
    wallClock: `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`
  };
}

/**
 * Compare a configured boundary against the current time.
 *
 * The portal's datetime-local inputs emit "2026-01-15T09:30" with no zone, so
 * those are wall-clock values in the rule's timezone and are compared as text.
 * A value carrying an explicit zone (trailing Z or +/-hh:mm) is an absolute
 * instant and is compared as one.
 *
 * A date-only boundary names a whole day, so an end date is inclusive: "ends
 * 2026-01-15" means through the end of the 15th, not midnight as it begins.
 */
function compareBoundary(boundary: string, now: Date, clock: ZonedClock, edge: "start" | "end"): number {
  const trimmed = boundary.trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const instant = new Date(trimmed).getTime();
    if (Number.isNaN(instant)) return 0;
    return now.getTime() - instant;
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const normalized = dateOnly ? `${trimmed}T${edge === "end" ? "23:59" : "00:00"}` : trimmed;
  const left = clock.wallClock;
  const right = normalized.slice(0, left.length).padEnd(left.length, "0");
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesDateTime(rule: DateTimeRule | null | undefined, now: Date): { passed: boolean; detail: string; applicable: boolean } {
  if (!rule) return { passed: true, detail: "Always active", applicable: false };

  const requested = rule.timezone?.trim();
  const zone = requested && isValidTimezone(requested) ? requested : serverTimezone();
  const zoneNote = requested && zone !== requested ? ` (unknown timezone "${requested}", used ${zone})` : "";
  const clock = zonedClock(now, zone);

  if (rule.start && compareBoundary(rule.start, now, clock, "start") < 0) {
    return { passed: false, detail: `Before start date${zoneNote}`, applicable: true };
  }
  if (rule.end && compareBoundary(rule.end, now, clock, "end") > 0) {
    return { passed: false, detail: `After end date${zoneNote}`, applicable: true };
  }
  if (rule.days?.length && !rule.days.includes(clock.day)) {
    return { passed: false, detail: `Day of week not in schedule${zoneNote}`, applicable: true };
  }
  if (rule.startHour != null && clock.hour < rule.startHour) {
    return { passed: false, detail: `Before start hour${zoneNote}`, applicable: true };
  }
  if (rule.endHour != null && clock.hour >= rule.endHour) {
    return { passed: false, detail: `After end hour${zoneNote}`, applicable: true };
  }
  return { passed: true, detail: `Within date/time window (${zone})`, applicable: true };
}

function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function contains(haystack: string, needle: string | null | undefined): boolean {
  if (!needle?.trim()) return false;
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

function matchesAdvanced(rule: AdvancedRule | undefined, ctx: RuleContext): { passed: boolean; detail: string; applicable: boolean; stop: boolean } {
  if (!rule) return { passed: true, detail: "No advanced rules", applicable: false, stop: false };
  const body = rule.bodySearch === "latest" ? ctx.latestBodyText : ctx.bodyText;
  if (rule.skipIfReply && ctx.isReply) {
    return {
      passed: false,
      detail: "Skipped because message is a reply/forward",
      applicable: true,
      stop: rule.ifNotApplied === "stop"
    };
  }
  if (rule.subjectContains && !contains(ctx.subject, rule.subjectContains)) {
    return { passed: false, detail: "Subject does not contain required text", applicable: true, stop: rule.ifNotApplied === "stop" };
  }
  if (rule.bodyContains && !contains(body, rule.bodyContains)) {
    return { passed: false, detail: "Body does not contain required text", applicable: true, stop: rule.ifNotApplied === "stop" };
  }
  if (rule.bodyDoesNotContain && contains(body, rule.bodyDoesNotContain)) {
    return {
      passed: false,
      detail: "Body contains exclusion text (already signed or excluded)",
      applicable: true,
      stop: rule.ifNotApplied === "stop"
    };
  }
  const applicable = Boolean(
    rule.skipIfReply || rule.subjectContains || rule.bodyContains || rule.bodyDoesNotContain
  );
  return { passed: true, detail: applicable ? "Advanced rules passed" : "No advanced rules", applicable, stop: false };
}

export function evaluateRules(rules: RuleSet, ctx: RuleContext): Evaluation {
  const now = ctx.now ?? new Date();
  const sender = matchesSender(rules.senders, ctx);
  const exceptions = matchesSender(rules.senderExceptions, ctx);
  const exceptionHit = exceptions.applicable && exceptions.passed;
  const recipients = matchesRecipients(rules.recipients, ctx);
  const dateTime = matchesDateTime(rules.dateTime, now);
  const advanced = matchesAdvanced(rules.advanced, ctx);

  const checks: RuleCheck[] = [
    { name: "Senders", applicable: sender.applicable, passed: sender.passed, detail: sender.detail },
    {
      name: "Sender exceptions",
      applicable: exceptions.applicable,
      passed: !exceptionHit,
      detail: exceptionHit ? "Sender is excluded" : exceptions.applicable ? "Sender not excluded" : "No exceptions"
    },
    { name: "Recipients", applicable: recipients.applicable, passed: recipients.passed, detail: recipients.detail },
    { name: "Date/Time", applicable: dateTime.applicable, passed: dateTime.passed, detail: dateTime.detail },
    { name: "Advanced", applicable: advanced.applicable, passed: advanced.passed, detail: advanced.detail }
  ];

  const applied = sender.passed && !exceptionHit && recipients.passed && dateTime.passed && advanced.passed;
  return {
    applied,
    checks,
    stopProcessing: !applied && advanced.stop
  };
}

export function isInternalAddress(email: string, internalDomains: string[]): boolean {
  return internalDomains.includes(domainOf(email));
}
