import { config, entraConfigured } from "../config.js";
import { getDb, replaceGroups, upsertDirectoryUser } from "../db/index.js";
import { emptyUser, type DirectoryUser } from "./fields.js";

type SyncResult = { users: number; groups: number; source: string; error?: string };

async function entraToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.entra.directoryClientId,
    client_secret: config.entra.directoryClientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const res = await fetch(`https://login.microsoftonline.com/${config.entra.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error(`Entra token failed: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function graphGet<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph ${url} failed: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function syncEntra(): Promise<SyncResult> {
  if (!entraConfigured()) return { users: 0, groups: 0, source: "entra", error: "Entra is not configured" };
  const token = await entraToken();
  const select =
    "id,mail,userPrincipalName,displayName,givenName,surname,jobTitle,department,companyName,officeLocation,streetAddress,city,state,postalCode,country,businessPhones,mobilePhone,faxNumber,accountEnabled";
  type GraphUser = {
    id: string;
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
    givenName?: string;
    surname?: string;
    jobTitle?: string;
    department?: string;
    companyName?: string;
    officeLocation?: string;
    streetAddress?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    businessPhones?: string[];
    mobilePhone?: string;
    faxNumber?: string;
    accountEnabled?: boolean;
  };
  const users: DirectoryUser[] = [];
  let next: string | undefined = `https://graph.microsoft.com/v1.0/users?$select=${select}&$top=999`;
  while (next) {
    const page: { value: GraphUser[]; "@odata.nextLink"?: string } = await graphGet(token, next);
    for (const u of page.value) {
      const email = (u.mail || u.userPrincipalName || "").toLowerCase();
      if (!email || !email.includes("@")) continue;
      const row = emptyUser(email);
      row.id = `entra:${u.id}`;
      row.directoryId = u.id;
      row.source = "entra";
      row.displayName = u.displayName || email;
      row.givenName = u.givenName || "";
      row.surname = u.surname || "";
      row.jobTitle = u.jobTitle || "";
      row.department = u.department || "";
      row.company = u.companyName || "";
      row.office = u.officeLocation || "";
      row.streetAddress = u.streetAddress || "";
      row.city = u.city || "";
      row.state = u.state || "";
      row.postalCode = u.postalCode || "";
      row.country = u.country || "";
      row.telephone = u.businessPhones?.[0] || "";
      row.mobile = u.mobilePhone || "";
      row.fax = u.faxNumber || "";
      row.enabled = u.accountEnabled === false ? 0 : 1;
      users.push(row);
      upsertDirectoryUser(row);
    }
    next = page["@odata.nextLink"];
  }

  type GraphGroup = { id: string; displayName?: string; mail?: string };
  const groups: { id: string; name: string; email: string; source: string }[] = [];
  const memberships: { groupId: string; userId: string }[] = [];
  let gnext: string | undefined =
    "https://graph.microsoft.com/v1.0/groups?$select=id,displayName,mail&$top=999";
  while (gnext) {
    const page: { value: GraphGroup[]; "@odata.nextLink"?: string } = await graphGet(token, gnext);
    for (const g of page.value) {
      const gid = `entra:${g.id}`;
      groups.push({ id: gid, name: g.displayName || g.mail || g.id, email: g.mail || "", source: "entra" });
      // Graph pages group members (100 at a time by default). Without following
      // nextLink, every group larger than one page loses the rest of its members
      // and sender-group rules stop matching for them.
      let mnext: string | undefined = `https://graph.microsoft.com/v1.0/groups/${g.id}/members?$select=id&$top=999`;
      while (mnext) {
        const members: { value: { id: string }[]; "@odata.nextLink"?: string } = await graphGet(token, mnext);
        for (const m of members.value) memberships.push({ groupId: gid, userId: `entra:${m.id}` });
        mnext = members["@odata.nextLink"];
      }
    }
    gnext = page["@odata.nextLink"];
  }
  replaceGroups(groups, memberships);
  return { users: users.length, groups: groups.length, source: "entra" };
}

async function googleAccessToken(): Promise<string> {
  if (!config.google.serviceAccountJson || !config.google.adminEmail) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_ADMIN_EMAIL are required for directory sync");
  }
  const sa = JSON.parse(config.google.serviceAccountJson) as {
    client_email: string;
    private_key: string;
  };
  const { SignJWT, importPKCS8 } = await import("jose");
  const key = await importPKCS8(sa.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    scope: "https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly"
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(config.google.adminEmail)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
  });
  if (!res.ok) throw new Error(`Google token failed: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function syncGoogle(): Promise<SyncResult> {
  const token = await googleAccessToken();
  type GUser = {
    id: string;
    primaryEmail?: string;
    name?: { fullName?: string; givenName?: string; familyName?: string };
    organizations?: Array<{ title?: string; department?: string; name?: string }>;
    phones?: Array<{ type?: string; value?: string }>;
    addresses?: Array<{
      streetAddress?: string;
      locality?: string;
      region?: string;
      postalCode?: string;
      country?: string;
    }>;
    suspended?: boolean;
  };
  const users: DirectoryUser[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://admin.googleapis.com/admin/directory/v1/users");
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google users failed: ${await res.text()}`);
    const json = (await res.json()) as { users?: GUser[]; nextPageToken?: string };
    for (const u of json.users || []) {
      const email = (u.primaryEmail || "").toLowerCase();
      if (!email) continue;
      const org = u.organizations?.[0];
      const workPhone = u.phones?.find((p) => p.type === "work")?.value || u.phones?.[0]?.value || "";
      const mobile = u.phones?.find((p) => p.type === "mobile")?.value || "";
      const addr = u.addresses?.[0];
      const row = emptyUser(email);
      row.id = `google:${u.id}`;
      row.directoryId = u.id;
      row.source = "google";
      row.displayName = u.name?.fullName || email;
      row.givenName = u.name?.givenName || "";
      row.surname = u.name?.familyName || "";
      row.jobTitle = org?.title || "";
      row.department = org?.department || "";
      row.company = org?.name || "";
      row.telephone = workPhone;
      row.mobile = mobile;
      row.streetAddress = addr?.streetAddress || "";
      row.city = addr?.locality || "";
      row.state = addr?.region || "";
      row.postalCode = addr?.postalCode || "";
      row.country = addr?.country || "";
      row.enabled = u.suspended ? 0 : 1;
      users.push(row);
      upsertDirectoryUser(row);
    }
    pageToken = json.nextPageToken || "";
  } while (pageToken);

  type GGroup = { id: string; email?: string; name?: string };
  const groups: { id: string; name: string; email: string; source: string }[] = [];
  const memberships: { groupId: string; userId: string }[] = [];
  pageToken = "";
  do {
    const url = new URL("https://admin.googleapis.com/admin/directory/v1/groups");
    url.searchParams.set("customer", "my_customer");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google groups failed: ${await res.text()}`);
    const json = (await res.json()) as { groups?: GGroup[]; nextPageToken?: string };
    for (const g of json.groups || []) {
      const gid = `google:${g.id}`;
      groups.push({ id: gid, name: g.name || g.email || g.id, email: g.email || "", source: "google" });
      const memRes = await fetch(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(g.email || g.id)}/members`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (memRes.ok) {
        const memJson = (await memRes.json()) as { members?: Array<{ id: string; email?: string; type?: string }> };
        for (const m of memJson.members || []) {
          if (m.type === "USER") memberships.push({ groupId: gid, userId: `google:${m.id}` });
        }
      }
    }
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  replaceGroups(groups, memberships);
  return { users: users.length, groups: groups.length, source: "google" };
}

export async function syncDirectory(): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  if (entraConfigured()) {
    try {
      results.push(await syncEntra());
    } catch (err) {
      results.push({ users: 0, groups: 0, source: "entra", error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (config.google.serviceAccountJson) {
    try {
      results.push(await syncGoogle());
    } catch (err) {
      results.push({ users: 0, groups: 0, source: "google", error: err instanceof Error ? err.message : String(err) });
    }
  }
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("last_directory_sync", new Date().toISOString());
  return results;
}
