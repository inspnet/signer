import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDir } from "../config.js";
import { DIRECTORY_FIELDS, emptyUser, type DirectoryUser } from "../directory/fields.js";
import type { Design } from "../mail/design.js";
import { defaultProfessionalDesign } from "../mail/templates.js";

export type Role = "super_admin" | "owner" | "admin" | "editor" | "designer" | "user";

export type SignatureRecord = {
  id: string;
  folderId: string | null;
  name: string;
  enabled: number;
  priority: number;
  designJson: string;
  htmlOverride: string | null;
  brandKitId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RuleSet = {
  senders: SenderRule;
  senderExceptions: SenderRule;
  recipients: RecipientRule;
  dateTime: DateTimeRule | null;
  advanced: AdvancedRule;
};

export type SenderRule = {
  everyone?: boolean;
  emails?: string[];
  domains?: string[];
  groups?: string[];
};

export type RecipientRule = {
  any?: boolean;
  internal?: boolean;
  external?: boolean;
  emails?: string[];
  domains?: string[];
  exceptEmails?: string[];
  exceptDomains?: string[];
};

export type DateTimeRule = {
  start?: string | null;
  end?: string | null;
  days?: number[];
  startHour?: number | null;
  endHour?: number | null;
  timezone?: string;
};

export type AdvancedRule = {
  subjectContains?: string | null;
  bodyContains?: string | null;
  bodyDoesNotContain?: string | null;
  bodySearch: "latest" | "anywhere";
  skipIfReply?: boolean;
  ifNotApplied: "stop" | "continue";
};

export const defaultRules = (): RuleSet => ({
  senders: { everyone: true },
  senderExceptions: {},
  recipients: { any: true },
  dateTime: null,
  advanced: { bodySearch: "anywhere", ifNotApplied: "continue" }
});

export type DisclaimerRecord = {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  html: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignRecord = {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  imageUrl: string;
  href: string;
  alt: string;
  createdAt: string;
  updatedAt: string;
};

export type FolderRecord = {
  id: string;
  name: string;
  priority: number;
};

export type SessionUser = {
  email: string;
  name: string;
  picture?: string;
  provider: "entra" | "google" | "dev";
  role: Role;
};

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialised");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined as unknown as Database.Database;
  }
}

export function initDb(): Database.Database {
  ensureDataDir();
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  if (config.demoMode) seedDemo(db);
  ensureSuperAdminDirectoryUser();
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      given_name TEXT NOT NULL DEFAULT '',
      surname TEXT NOT NULL DEFAULT '',
      job_title TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      office TEXT NOT NULL DEFAULT '',
      street_address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      telephone TEXT NOT NULL DEFAULT '',
      mobile TEXT NOT NULL DEFAULT '',
      fax TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      pronouns TEXT NOT NULL DEFAULT '',
      working_hours TEXT NOT NULL DEFAULT '',
      photo_url TEXT NOT NULL DEFAULT '',
      linkedin TEXT NOT NULL DEFAULT '',
      x TEXT NOT NULL DEFAULT '',
      facebook TEXT NOT NULL DEFAULT '',
      instagram TEXT NOT NULL DEFAULT '',
      custom1 TEXT NOT NULL DEFAULT '',
      custom2 TEXT NOT NULL DEFAULT '',
      custom3 TEXT NOT NULL DEFAULT '',
      custom4 TEXT NOT NULL DEFAULT '',
      custom5 TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      directory_id TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      last_synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS admin_roles (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      granted_by TEXT NOT NULL DEFAULT '',
      granted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      rules_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signatures (
      id TEXT PRIMARY KEY,
      folder_id TEXT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      design_json TEXT NOT NULL,
      html_override TEXT,
      brand_kit_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signature_rules (
      signature_id TEXT PRIMARY KEY,
      rules_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS disclaimers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      html TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS disclaimer_rules (
      disclaimer_id TEXT PRIMARY KEY,
      rules_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      image_url TEXT NOT NULL DEFAULT '',
      href TEXT NOT NULL DEFAULT '',
      alt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_rules (
      campaign_id TEXT PRIMARY KEY,
      rules_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brand_kits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logo_url TEXT NOT NULL DEFAULT '',
      primary_color TEXT NOT NULL DEFAULT '#111827',
      font_family TEXT NOT NULL DEFAULT 'Calibri, Arial, sans-serif'
    );

    CREATE TABLE IF NOT EXISTS field_permissions (
      field_key TEXT PRIMARY KEY,
      user_editable INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL,
      recipients TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      signature_id TEXT,
      disclaimer_ids TEXT NOT NULL DEFAULT '[]',
      campaign_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      processing_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_mail_log_received ON mail_log(received_at);
    CREATE INDEX IF NOT EXISTS idx_users_domain ON users(domain);
  `);

  const existingFields = new Set(
    (d.prepare("SELECT field_key FROM field_permissions").all() as { field_key: string }[]).map((r) => r.field_key)
  );
  const insertField = d.prepare(
    "INSERT INTO field_permissions (field_key, user_editable) VALUES (?, ?)"
  );
  const defaultEditable = new Set(["pronouns", "mobile", "website", "workingHours"]);
  for (const field of DIRECTORY_FIELDS) {
    if (!existingFields.has(field.key)) {
      insertField.run(field.key, defaultEditable.has(field.key) ? 1 : 0);
    }
  }
}

function ensureSuperAdminDirectoryUser(): void {
  if (!config.superAdminEmail) return;
  if (getUserByEmail(config.superAdminEmail)) return;
  const template = emptyUser(config.superAdminEmail);
  template.id = "u-superadmin";
  template.displayName = "Super Admin";
  template.source = "manual";
  upsertDirectoryUser(template, false);
}

function seedDemo(d: Database.Database): void {
  const count = (d.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  if (count > 0) return;
  const now = new Date().toISOString();
  const users: Array<Partial<DirectoryUser> & { id: string; email: string }> = [
    {
      id: "u-scott",
      email: "scott@inspired.co",
      displayName: "Scott Williamson",
      givenName: "Scott",
      surname: "Williamson",
      jobTitle: "Marketing Director",
      department: "Marketing",
      company: "Inspired Networks",
      telephone: "604.288.7000 x119",
      mobile: "604.555.0199",
      pronouns: "he/him",
      website: "www.inspired.co",
      custom1: "IT Support: it@inspired.co / 604.288.7000 x1",
      custom2: "Web Support: web@inspired.co / 604.288.7000 x2",
      source: "demo",
      domain: "inspired.co"
    },
    {
      id: "u-alex",
      email: "alex@inspired.co",
      displayName: "Alex Bennett",
      givenName: "Alex",
      surname: "Bennett",
      jobTitle: "Marketing Director",
      department: "Marketing",
      company: "Inspired Networks",
      telephone: "+44 (0) 123 456 7890",
      mobile: "+44 7700 900123",
      website: "www.inspired.co",
      source: "demo",
      domain: "inspired.co"
    }
  ];
  const insert = d.prepare(`
    INSERT INTO users (id, email, display_name, given_name, surname, job_title, department, company, telephone, mobile, pronouns, website, custom1, custom2, source, domain, enabled)
    VALUES (@id, @email, @displayName, @givenName, @surname, @jobTitle, @department, @company, @telephone, @mobile, @pronouns, @website, @custom1, @custom2, @source, @domain, 1)
  `);
  for (const u of users) {
    insert.run({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      givenName: u.givenName,
      surname: u.surname,
      jobTitle: u.jobTitle,
      department: u.department,
      company: u.company,
      telephone: u.telephone || "",
      mobile: u.mobile || "",
      pronouns: u.pronouns || "",
      website: u.website || "",
      custom1: u.custom1 || "",
      custom2: u.custom2 || "",
      source: u.source,
      domain: u.domain
    });
  }
  d.prepare("INSERT INTO groups (id, name, email, source) VALUES (?, ?, ?, ?)").run(
    "g-marketing",
    "Marketing",
    "marketing@inspired.co",
    "demo"
  );
  d.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run("g-marketing", "u-scott");
  d.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run("g-marketing", "u-alex");

  const sigId = "sig-inspired-general";
  d.prepare(
    `INSERT INTO signatures (id, folder_id, name, enabled, priority, design_json, html_override, created_at, updated_at)
     VALUES (?, NULL, ?, 1, 0, ?, NULL, ?, ?)`
  ).run(sigId, "Inspired General", JSON.stringify(defaultProfessionalDesign()), now, now);
  d.prepare("INSERT INTO signature_rules (signature_id, rules_json) VALUES (?, ?)").run(
    sigId,
    JSON.stringify(defaultRules())
  );

  const discId = "disc-confidential";
  d.prepare(
    `INSERT INTO disclaimers (id, name, enabled, priority, html, created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?, ?)`
  ).run(
    discId,
    "Confidentiality notice",
    `<p style="font-family:Calibri,Arial,sans-serif;font-size:10px;color:#4b5563;margin:12px 0 0 0;">This email and any attachments are confidential and intended solely for the addressee. If you are not the intended recipient, please delete this message and notify the sender. Unauthorised use, disclosure or copying is prohibited.</p>`,
    now,
    now
  );
  d.prepare("INSERT INTO disclaimer_rules (disclaimer_id, rules_json) VALUES (?, ?)").run(
    discId,
    JSON.stringify({ ...defaultRules(), recipients: { external: true } })
  );

  d.prepare(
    `INSERT INTO campaigns (id, name, enabled, priority, image_url, href, alt, created_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)`
  ).run(
    "camp-webinar",
    "Spring webinar banner",
    "",
    "https://example.com/webinar",
    "Join our webinar",
    now,
    now
  );
  d.prepare("INSERT INTO campaign_rules (campaign_id, rules_json) VALUES (?, ?)").run(
    "camp-webinar",
    JSON.stringify(defaultRules())
  );
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function audit(actor: string, action: string, entity = "", detail = ""): void {
  getDb()
    .prepare("INSERT INTO audit_log (at, actor, action, entity, detail) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), actor, action, entity, detail);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const USER_COLUMNS = `id, email, display_name as displayName, given_name as givenName, surname,
  job_title as jobTitle, department, company, office, street_address as streetAddress,
  city, state, postal_code as postalCode, country, telephone, mobile, fax, website,
  pronouns, working_hours as workingHours, photo_url as photoUrl, linkedin, x, facebook,
  instagram, custom1, custom2, custom3, custom4, custom5, source, directory_id as directoryId,
  domain, enabled, overrides_json as overridesJson`;

function hydrateUser(row: Record<string, unknown> | undefined): DirectoryUser | null {
  if (!row) return null;
  const overrides = parseJson<Record<string, string>>(String(row.overridesJson || "{}"), {});
  const base = emptyUser(String(row.email));
  const merged: DirectoryUser = {
    ...base,
    id: String(row.id),
    displayName: String(row.displayName || ""),
    givenName: String(row.givenName || ""),
    surname: String(row.surname || ""),
    jobTitle: String(row.jobTitle || ""),
    department: String(row.department || ""),
    company: String(row.company || ""),
    office: String(row.office || ""),
    streetAddress: String(row.streetAddress || ""),
    city: String(row.city || ""),
    state: String(row.state || ""),
    postalCode: String(row.postalCode || ""),
    country: String(row.country || ""),
    telephone: String(row.telephone || ""),
    mobile: String(row.mobile || ""),
    fax: String(row.fax || ""),
    website: String(row.website || ""),
    pronouns: String(row.pronouns || ""),
    workingHours: String(row.workingHours || ""),
    photoUrl: String(row.photoUrl || ""),
    linkedin: String(row.linkedin || ""),
    x: String(row.x || ""),
    facebook: String(row.facebook || ""),
    instagram: String(row.instagram || ""),
    custom1: String(row.custom1 || ""),
    custom2: String(row.custom2 || ""),
    custom3: String(row.custom3 || ""),
    custom4: String(row.custom4 || ""),
    custom5: String(row.custom5 || ""),
    source: row.source as DirectoryUser["source"],
    directoryId: String(row.directoryId || ""),
    domain: String(row.domain || ""),
    enabled: Number(row.enabled ?? 1),
    groupIds: []
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v != null && v !== "" && k in merged) {
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
  }
  const groups = getDb()
    .prepare("SELECT group_id FROM group_members WHERE user_id = ?")
    .all(merged.id) as { group_id: string }[];
  merged.groupIds = groups.map((g) => g.group_id);
  return merged;
}

export function getUserByEmail(email: string): DirectoryUser | null {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(?)`)
    .get(email) as Record<string, unknown> | undefined;
  return hydrateUser(row);
}

export function listUsers(): DirectoryUser[] {
  const rows = getDb().prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY display_name`).all() as Record<
    string,
    unknown
  >[];
  return rows.map((r) => hydrateUser(r)!);
}

export function upsertDirectoryUser(user: DirectoryUser, preserveOverrides = true): void {
  const existing = getDb().prepare("SELECT overrides_json FROM users WHERE id = ?").get(user.id) as
    | { overrides_json: string }
    | undefined;
  const overrides = preserveOverrides && existing ? existing.overrides_json : "{}";
  getDb()
    .prepare(
      `INSERT INTO users (
        id, email, display_name, given_name, surname, job_title, department, company, office,
        street_address, city, state, postal_code, country, telephone, mobile, fax, website,
        pronouns, working_hours, photo_url, linkedin, x, facebook, instagram, custom1, custom2,
        custom3, custom4, custom5, source, directory_id, domain, enabled, overrides_json, last_synced_at
      ) VALUES (
        @id, @email, @displayName, @givenName, @surname, @jobTitle, @department, @company, @office,
        @streetAddress, @city, @state, @postalCode, @country, @telephone, @mobile, @fax, @website,
        @pronouns, @workingHours, @photoUrl, @linkedin, @x, @facebook, @instagram, @custom1, @custom2,
        @custom3, @custom4, @custom5, @source, @directoryId, @domain, @enabled, @overrides, @synced
      ) ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, display_name=excluded.display_name, given_name=excluded.given_name,
        surname=excluded.surname, job_title=excluded.job_title, department=excluded.department,
        company=excluded.company, office=excluded.office, street_address=excluded.street_address,
        city=excluded.city, state=excluded.state, postal_code=excluded.postal_code, country=excluded.country,
        telephone=excluded.telephone, mobile=excluded.mobile, fax=excluded.fax, website=excluded.website,
        photo_url=excluded.photo_url, source=excluded.source, directory_id=excluded.directory_id,
        domain=excluded.domain, enabled=excluded.enabled, last_synced_at=excluded.last_synced_at
      `
    )
    .run({
      ...user,
      overrides,
      synced: new Date().toISOString()
    });
}

export function setUserOverrides(email: string, overrides: Record<string, string>): void {
  const user = getUserByEmail(email);
  if (!user) throw new Error("User not found");
  const row = getDb().prepare("SELECT overrides_json FROM users WHERE id = ?").get(user.id) as {
    overrides_json: string;
  };
  const current = parseJson<Record<string, string>>(row.overrides_json, {});
  const merged = { ...current, ...overrides };
  getDb().prepare("UPDATE users SET overrides_json = ? WHERE id = ?").run(JSON.stringify(merged), user.id);
}

export function listFieldPermissions(): { fieldKey: string; userEditable: boolean }[] {
  return (
    getDb().prepare("SELECT field_key as fieldKey, user_editable as userEditable FROM field_permissions").all() as {
      fieldKey: string;
      userEditable: number;
    }[]
  ).map((r) => ({ fieldKey: r.fieldKey, userEditable: Boolean(r.userEditable) }));
}

export function setFieldPermissions(keys: string[]): void {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare("UPDATE field_permissions SET user_editable = 0").run();
    const upd = d.prepare("UPDATE field_permissions SET user_editable = 1 WHERE field_key = ?");
    for (const key of keys) upd.run(key);
  });
  tx();
}

export function resolveRole(email: string): Role {
  const lower = email.toLowerCase();
  if (config.superAdminEmail && lower === config.superAdminEmail) return "super_admin";
  const row = getDb().prepare("SELECT role FROM admin_roles WHERE lower(email) = ?").get(lower) as
    | { role: Role }
    | undefined;
  return row?.role ?? "user";
}

export function setAdminRole(email: string, role: Role, grantedBy: string): void {
  getDb()
    .prepare(
      `INSERT INTO admin_roles (email, role, granted_by, granted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by, granted_at=excluded.granted_at`
    )
    .run(email.toLowerCase(), role, grantedBy, new Date().toISOString());
}

export function listAdminRoles(): { email: string; role: Role }[] {
  return getDb().prepare("SELECT email, role FROM admin_roles ORDER BY email").all() as {
    email: string;
    role: Role;
  }[];
}

export function listGroups(): { id: string; name: string; email: string; source: string }[] {
  return getDb().prepare("SELECT id, name, email, source FROM groups ORDER BY name").all() as {
    id: string;
    name: string;
    email: string;
    source: string;
  }[];
}

export function replaceGroups(
  groups: { id: string; name: string; email: string; source: string }[],
  memberships: { groupId: string; userId: string }[]
): void {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM group_members").run();
    d.prepare("DELETE FROM groups").run();
    const g = d.prepare("INSERT INTO groups (id, name, email, source) VALUES (?, ?, ?, ?)");
    for (const group of groups) g.run(group.id, group.name, group.email, group.source);
    const m = d.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)");
    for (const mem of memberships) m.run(mem.groupId, mem.userId);
  });
  tx();
}

export function listSignatures(): SignatureRecord[] {
  return getDb()
    .prepare(
      `SELECT id, folder_id as folderId, name, enabled, priority, design_json as designJson,
              html_override as htmlOverride, brand_kit_id as brandKitId, created_at as createdAt, updated_at as updatedAt
       FROM signatures ORDER BY priority ASC, name ASC`
    )
    .all() as SignatureRecord[];
}

export function getSignature(id: string): (SignatureRecord & { rules: RuleSet }) | null {
  const sig = getDb()
    .prepare(
      `SELECT id, folder_id as folderId, name, enabled, priority, design_json as designJson,
              html_override as htmlOverride, brand_kit_id as brandKitId, created_at as createdAt, updated_at as updatedAt
       FROM signatures WHERE id = ?`
    )
    .get(id) as SignatureRecord | undefined;
  if (!sig) return null;
  const rulesRow = getDb().prepare("SELECT rules_json FROM signature_rules WHERE signature_id = ?").get(id) as
    | { rules_json: string }
    | undefined;
  return { ...sig, rules: rulesRow ? parseJson(rulesRow.rules_json, defaultRules()) : defaultRules() };
}

export function saveSignature(input: {
  id?: string;
  name: string;
  folderId?: string | null;
  enabled?: boolean;
  design?: Design;
  htmlOverride?: string | null;
}): SignatureRecord {
  const now = new Date().toISOString();
  const id = input.id || newId("sig");
  const existing = input.id ? getSignature(id) : null;
  const designJson = JSON.stringify(input.design ?? (existing ? parseJson(existing.designJson, defaultProfessionalDesign()) : defaultProfessionalDesign()));
  if (existing) {
    getDb()
      .prepare(
        `UPDATE signatures SET name=?, folder_id=?, enabled=?, design_json=?, html_override=?, updated_at=? WHERE id=?`
      )
      .run(
        input.name,
        input.folderId ?? existing.folderId,
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        designJson,
        input.htmlOverride === undefined ? existing.htmlOverride : input.htmlOverride,
        now,
        id
      );
  } else {
    const max = (getDb().prepare("SELECT COALESCE(MAX(priority), -1) as m FROM signatures").get() as { m: number }).m;
    getDb()
      .prepare(
        `INSERT INTO signatures (id, folder_id, name, enabled, priority, design_json, html_override, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.folderId ?? null, input.name, input.enabled === false ? 0 : 1, max + 1, designJson, input.htmlOverride ?? null, now, now);
    getDb().prepare("INSERT INTO signature_rules (signature_id, rules_json) VALUES (?, ?)").run(id, JSON.stringify(defaultRules()));
  }
  return getSignature(id)!;
}

export function saveSignatureRules(id: string, rules: RuleSet): void {
  getDb()
    .prepare(
      `INSERT INTO signature_rules (signature_id, rules_json) VALUES (?, ?)
       ON CONFLICT(signature_id) DO UPDATE SET rules_json=excluded.rules_json`
    )
    .run(id, JSON.stringify(rules));
}

export function deleteSignature(id: string): void {
  getDb().prepare("DELETE FROM signature_rules WHERE signature_id = ?").run(id);
  getDb().prepare("DELETE FROM signatures WHERE id = ?").run(id);
}

export function reorderSignatures(ids: string[]): void {
  const upd = getDb().prepare("UPDATE signatures SET priority = ? WHERE id = ?");
  const tx = getDb().transaction(() => {
    ids.forEach((id, i) => upd.run(i, id));
  });
  tx();
}

export function listDisclaimers(): (DisclaimerRecord & { rules: RuleSet })[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, enabled, priority, html, created_at as createdAt, updated_at as updatedAt FROM disclaimers ORDER BY priority, name`
    )
    .all() as DisclaimerRecord[];
  return rows.map((r) => {
    const rulesRow = getDb().prepare("SELECT rules_json FROM disclaimer_rules WHERE disclaimer_id = ?").get(r.id) as
      | { rules_json: string }
      | undefined;
    return { ...r, rules: rulesRow ? parseJson(rulesRow.rules_json, defaultRules()) : defaultRules() };
  });
}

export function saveDisclaimer(input: {
  id?: string;
  name: string;
  html: string;
  enabled?: boolean;
  rules?: RuleSet;
}): DisclaimerRecord & { rules: RuleSet } {
  const now = new Date().toISOString();
  const id = input.id || newId("disc");
  const existing = listDisclaimers().find((d) => d.id === id);
  if (existing) {
    getDb()
      .prepare("UPDATE disclaimers SET name=?, html=?, enabled=?, updated_at=? WHERE id=?")
      .run(input.name, input.html, input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0, now, id);
  } else {
    const max = (getDb().prepare("SELECT COALESCE(MAX(priority), -1) as m FROM disclaimers").get() as { m: number }).m;
    getDb()
      .prepare(
        `INSERT INTO disclaimers (id, name, enabled, priority, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.enabled === false ? 0 : 1, max + 1, input.html, now, now);
  }
  if (input.rules) {
    getDb()
      .prepare(
        `INSERT INTO disclaimer_rules (disclaimer_id, rules_json) VALUES (?, ?)
         ON CONFLICT(disclaimer_id) DO UPDATE SET rules_json=excluded.rules_json`
      )
      .run(id, JSON.stringify(input.rules));
  } else if (!existing) {
    getDb().prepare("INSERT INTO disclaimer_rules (disclaimer_id, rules_json) VALUES (?, ?)").run(id, JSON.stringify(defaultRules()));
  }
  return listDisclaimers().find((d) => d.id === id)!;
}

export function deleteDisclaimer(id: string): void {
  getDb().prepare("DELETE FROM disclaimer_rules WHERE disclaimer_id = ?").run(id);
  getDb().prepare("DELETE FROM disclaimers WHERE id = ?").run(id);
}

export function listCampaigns(): (CampaignRecord & { rules: RuleSet })[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, enabled, priority, image_url as imageUrl, href, alt, created_at as createdAt, updated_at as updatedAt
       FROM campaigns ORDER BY priority, name`
    )
    .all() as CampaignRecord[];
  return rows.map((r) => {
    const rulesRow = getDb().prepare("SELECT rules_json FROM campaign_rules WHERE campaign_id = ?").get(r.id) as
      | { rules_json: string }
      | undefined;
    return { ...r, rules: rulesRow ? parseJson(rulesRow.rules_json, defaultRules()) : defaultRules() };
  });
}

export function saveCampaign(input: {
  id?: string;
  name: string;
  imageUrl: string;
  href?: string;
  alt?: string;
  enabled?: boolean;
  rules?: RuleSet;
}): CampaignRecord & { rules: RuleSet } {
  const now = new Date().toISOString();
  const id = input.id || newId("camp");
  const existing = listCampaigns().find((c) => c.id === id);
  if (existing) {
    getDb()
      .prepare("UPDATE campaigns SET name=?, image_url=?, href=?, alt=?, enabled=?, updated_at=? WHERE id=?")
      .run(
        input.name,
        input.imageUrl,
        input.href ?? existing.href,
        input.alt ?? existing.alt,
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        now,
        id
      );
  } else {
    const max = (getDb().prepare("SELECT COALESCE(MAX(priority), -1) as m FROM campaigns").get() as { m: number }).m;
    getDb()
      .prepare(
        `INSERT INTO campaigns (id, name, enabled, priority, image_url, href, alt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.enabled === false ? 0 : 1,
        max + 1,
        input.imageUrl,
        input.href ?? "",
        input.alt ?? "",
        now,
        now
      );
    getDb().prepare("INSERT INTO campaign_rules (campaign_id, rules_json) VALUES (?, ?)").run(id, JSON.stringify(input.rules ?? defaultRules()));
  }
  if (input.rules) {
    getDb()
      .prepare(
        `INSERT INTO campaign_rules (campaign_id, rules_json) VALUES (?, ?)
         ON CONFLICT(campaign_id) DO UPDATE SET rules_json=excluded.rules_json`
      )
      .run(id, JSON.stringify(input.rules));
  }
  return listCampaigns().find((c) => c.id === id)!;
}

export function deleteCampaign(id: string): void {
  getDb().prepare("DELETE FROM campaign_rules WHERE campaign_id = ?").run(id);
  getDb().prepare("DELETE FROM campaigns WHERE id = ?").run(id);
}

export function listFolders(): FolderRecord[] {
  return getDb().prepare("SELECT id, name, priority FROM folders ORDER BY priority, name").all() as FolderRecord[];
}

export function saveFolder(name: string, id?: string): FolderRecord {
  const folderId = id || newId("fld");
  if (id) {
    getDb().prepare("UPDATE folders SET name=? WHERE id=?").run(name, folderId);
  } else {
    const max = (getDb().prepare("SELECT COALESCE(MAX(priority), -1) as m FROM folders").get() as { m: number }).m;
    getDb()
      .prepare("INSERT INTO folders (id, name, priority, rules_json) VALUES (?, ?, ?, ?)")
      .run(folderId, name, max + 1, JSON.stringify(defaultRules()));
  }
  return listFolders().find((f) => f.id === folderId)!;
}

export function getSetting(key: string, fallback = ""): string {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value);
}

export function logMail(entry: {
  messageId: string;
  sender: string;
  recipients: string[];
  subject: string;
  signatureId: string | null;
  disclaimerIds: string[];
  campaignIds: string[];
  status: string;
  detail?: string;
  processingMs: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO mail_log (received_at, message_id, sender, recipients, subject, signature_id, disclaimer_ids, campaign_ids, status, detail, processing_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      new Date().toISOString(),
      entry.messageId,
      entry.sender,
      JSON.stringify(entry.recipients),
      entry.subject,
      entry.signatureId,
      JSON.stringify(entry.disclaimerIds),
      JSON.stringify(entry.campaignIds),
      entry.status,
      entry.detail ?? "",
      entry.processingMs
    );
}

export function mailStats(): {
  processed24h: number;
  signed24h: number;
  failed24h: number;
  recent: Array<{
    receivedAt: string;
    sender: string;
    subject: string;
    status: string;
    signatureId: string | null;
    processingMs: number;
  }>;
} {
  const processed24h = (
    getDb().prepare("SELECT COUNT(*) as c FROM mail_log WHERE received_at >= datetime('now', '-1 day')").get() as {
      c: number;
    }
  ).c;
  const signed24h = (
    getDb()
      .prepare(
        "SELECT COUNT(*) as c FROM mail_log WHERE received_at >= datetime('now', '-1 day') AND status = 'signed'"
      )
      .get() as { c: number }
  ).c;
  const failed24h = (
    getDb()
      .prepare(
        "SELECT COUNT(*) as c FROM mail_log WHERE received_at >= datetime('now', '-1 day') AND status = 'error'"
      )
      .get() as { c: number }
  ).c;
  const recent = getDb()
    .prepare(
      `SELECT received_at as receivedAt, sender, subject, status, signature_id as signatureId, processing_ms as processingMs
       FROM mail_log ORDER BY id DESC LIMIT 25`
    )
    .all() as Array<{
    receivedAt: string;
    sender: string;
    subject: string;
    status: string;
    signatureId: string | null;
    processingMs: number;
  }>;
  return { processed24h, signed24h, failed24h, recent };
}

export function saveUpload(filename: string, buffer: Buffer): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stored = `${Date.now()}_${safe}`;
  const dest = path.join(config.dataDir, "uploads", stored);
  fs.writeFileSync(dest, buffer);
  return `/uploads/${stored}`;
}

export { parseJson };
