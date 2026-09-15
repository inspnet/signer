export type Role = "super_admin" | "owner" | "admin" | "editor" | "designer" | "user";

export type DirectoryPerson = {
  id: string;
  email: string;
  displayName: string;
  jobTitle: string;
  department: string;
  telephone: string;
  mobile: string;
  website: string;
  pronouns: string;
  domain: string;
  groupIds: string[];
  [key: string]: string | string[] | number | undefined;
};

export type SessionUser = {
  email: string;
  name: string;
  picture?: string;
  provider: string;
  role: Role;
};

export type RuleSet = {
  senders: { everyone?: boolean; emails?: string[]; domains?: string[]; groups?: string[] };
  senderExceptions: { everyone?: boolean; emails?: string[]; domains?: string[]; groups?: string[] };
  recipients: {
    any?: boolean;
    internal?: boolean;
    external?: boolean;
    emails?: string[];
    domains?: string[];
    exceptEmails?: string[];
    exceptDomains?: string[];
  };
  dateTime: {
    start?: string | null;
    end?: string | null;
    days?: number[];
    startHour?: number | null;
    endHour?: number | null;
  } | null;
  advanced: {
    subjectContains?: string | null;
    bodyContains?: string | null;
    bodyDoesNotContain?: string | null;
    bodySearch: "latest" | "anywhere";
    skipIfReply?: boolean;
    ifNotApplied: "stop" | "continue";
  };
};

export type TextStyle = {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  lineHeight?: string;
};

export type Block =
  | { id: string; type: "text"; content: string; style?: TextStyle }
  | { id: string; type: "field"; field: string; prefix?: string; suffix?: string; style?: TextStyle; link?: "email" | "phone" | "url" | "none" }
  | { id: string; type: "image"; src: string; width?: number; alt?: string; href?: string }
  | { id: string; type: "social"; networks: Array<{ name: "linkedin" | "x" | "facebook" | "instagram" | "website"; urlField?: string; url?: string }>; iconSize?: number }
  | { id: string; type: "divider"; color?: string; height?: number }
  | { id: string; type: "spacer"; height?: number }
  | { id: string; type: "banner"; src: string; href?: string; alt?: string; width?: number }
  | { id: string; type: "row"; columns: Array<{ width: string; blocks: Block[] }> };

export type Design = { width: number; background?: string; blocks: Block[] };

export type Signature = {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  folderId: string | null;
  design: Design;
  htmlOverride: string | null;
  rules: RuleSet;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  bootstrap: () =>
    request<{
      user: SessionUser | null;
      providers: { entra: boolean; google: boolean; dev: boolean };
      demoMode: boolean;
      processedHeader: string;
      publicUrl: string;
      smtpHostname: string;
    }>("/api/bootstrap"),
  me: () => request<{ user: SessionUser | null }>("/api/auth/me"),
  devLogin: () => request<{ ok: boolean }>("/api/auth/dev-login", { method: "POST", body: "{}" }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  home: () =>
    request<{
      stats: { processed24h: number; signed24h: number; failed24h: number; recent: Array<{ receivedAt: string; sender: string; subject: string; status: string; processingMs: number }> };
      signatures: number;
      disclaimers: number;
      users: number;
      lastSync: string;
    }>("/api/home"),
  signatures: () => request<Signature[]>("/api/signatures"),
  signature: (id: string) => request<Signature>(`/api/signatures/${id}`),
  createSignature: (name: string) => request<Signature>("/api/signatures", { method: "POST", body: JSON.stringify({ name }) }),
  saveSignature: (id: string, body: { name?: string; design?: Design; rules?: RuleSet; enabled?: boolean; htmlOverride?: string | null; folderId?: string | null }) =>
    request<Signature>(`/api/signatures/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSignature: (id: string) => request(`/api/signatures/${id}`, { method: "DELETE" }),
  reorder: (ids: string[]) => request("/api/signatures/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  preview: (id: string, email: string) => request<{ html: string; user: { displayName: string; email: string } }>(`/api/signatures/${id}/preview?email=${encodeURIComponent(email)}`),
  disclaimers: () => request<Array<{ id: string; name: string; enabled: number; html: string; rules: RuleSet }>>("/api/disclaimers"),
  saveDisclaimer: (body: object) => request("/api/disclaimers", { method: "POST", body: JSON.stringify(body) }),
  deleteDisclaimer: (id: string) => request(`/api/disclaimers/${id}`, { method: "DELETE" }),
  campaigns: () => request<Array<{ id: string; name: string; enabled: number; imageUrl: string; href: string; alt: string; rules: RuleSet }>>("/api/campaigns"),
  saveCampaign: (body: object) => request("/api/campaigns", { method: "POST", body: JSON.stringify(body) }),
  deleteCampaign: (id: string) => request(`/api/campaigns/${id}`, { method: "DELETE" }),
  folders: () => request<Array<{ id: string; name: string }>>("/api/folders"),
  createFolder: (name: string) => request("/api/folders", { method: "POST", body: JSON.stringify({ name }) }),
  tester: (body: { from: string; to: string; subject?: string; body?: string }) => request("/api/tester", { method: "POST", body: JSON.stringify(body) }),
  users: () => request<DirectoryPerson[]>("/api/users"),
  groups: () => request<Array<{ id: string; name: string; email: string }>>("/api/groups"),
  sync: () => request("/api/directory/sync", { method: "POST", body: "{}" }),
  fields: () => request<Array<{ key: string; label: string; section: string; directory: boolean; userEditable: boolean }>>("/api/fields"),
  saveFields: (editable: string[]) => request("/api/fields", { method: "PUT", body: JSON.stringify({ editable }) }),
  myDetails: () =>
    request<{
      user: Record<string, string> | null;
      fields: Array<{ key: string; label: string; section: string; userEditable: boolean }>;
    }>("/api/me/details"),
  saveMyDetails: (body: Record<string, string>) => request("/api/me/details", { method: "PUT", body: JSON.stringify(body) }),
  admins: () => request<{ superAdmin: string; roles: Array<{ email: string; role: string }> }>("/api/admins"),
  saveAdmin: (email: string, role: string) => request("/api/admins", { method: "PUT", body: JSON.stringify({ email, role }) }),
  settings: () => request<Record<string, unknown>>("/api/settings"),
  saveSettings: (body: object) => request("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  mailFlow: () => request<Record<string, unknown>>("/api/mail-flow"),
  analytics: () => request<{ processed24h: number; signed24h: number; failed24h: number; recent: Array<{ receivedAt: string; sender: string; subject: string; status: string; processingMs: number }> }>("/api/analytics")
};
