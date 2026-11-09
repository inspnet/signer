import { config } from "../config.js";
import { getSetting, setSetting } from "../db/index.js";

/**
 * The Microsoft 365 tenant ID that marks mail as the organisation's own (see
 * fromOwnTenant in accept.ts). Exchange stamps it on every message as a GUID.
 *
 * In order: the ID an admin set under Settings → Domains; ENTRA_TENANT_ID when
 * it is already a GUID; or, when ENTRA_TENANT_ID is a domain such as
 * contoso.onmicrosoft.com (sign-in accepts either), the ID Microsoft gives for
 * that domain, looked up at startup and remembered.
 */

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SET_KEY = "mail_tenant_id";
const LOOKUP_KEY = "mail_tenant_lookup";

export type MailTenant = {
  id: string;
  /** settings: set in the portal. entra: ENTRA_TENANT_ID. lookup: found from ENTRA_TENANT_ID's domain. */
  source: "settings" | "entra" | "lookup" | "none";
  entraTenantId: string;
};

type Fetcher = typeof fetch;

function remembered(): { from: string; id: string } | null {
  try {
    const v = JSON.parse(getSetting(LOOKUP_KEY, "null")) as { from?: string; id?: string } | null;
    return v?.from && v.id && GUID.test(v.id) ? { from: v.from, id: v.id } : null;
  } catch {
    return null;
  }
}

export function mailTenant(): MailTenant {
  const entra = config.entra.tenantId.trim().toLowerCase();
  const base = { entraTenantId: config.entra.tenantId.trim() };
  const set = getSetting(SET_KEY, "").trim().toLowerCase();
  if (GUID.test(set)) return { ...base, id: set, source: "settings" };
  if (GUID.test(entra)) return { ...base, id: entra, source: "entra" };
  const found = remembered();
  if (entra && found?.from === entra) return { ...base, id: found.id, source: "lookup" };
  return { ...base, id: "", source: "none" };
}

/** Microsoft's sign-in metadata names the tenant behind any of its domains. */
export async function lookupTenantId(domain: string, fetcher: Fetcher = fetch): Promise<string> {
  const name = domain.trim().toLowerCase();
  if (!DOMAIN.test(name)) throw new Error("Enter the tenant ID, or one of the tenant's domains.");
  let issuer = "";
  try {
    const res = await fetcher(`https://login.microsoftonline.com/${name}/v2.0/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (res.ok) issuer = String(((await res.json()) as { issuer?: unknown }).issuer ?? "");
  } catch (err) {
    throw new Error(`Could not ask Microsoft about ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const id = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i.exec(issuer)?.[1]?.toLowerCase();
  if (!id || !GUID.test(id)) throw new Error(`Microsoft 365 does not know ${name} as a tenant's domain.`);
  return id;
}

/** At startup. Never throws: without it, mail with an empty sender still has to pass DMARC. */
export async function resolveEntraTenant(fetcher: Fetcher = fetch): Promise<void> {
  const entra = config.entra.tenantId.trim().toLowerCase();
  if (!entra || GUID.test(entra) || remembered()?.from === entra) return;
  try {
    setSetting(LOOKUP_KEY, JSON.stringify({ from: entra, id: await lookupTenantId(entra, fetcher) }));
  } catch (err) {
    console.warn(`[signer] Could not find the tenant ID for ENTRA_TENANT_ID=${entra}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Set from the portal: a tenant ID, or a domain to look it up from. Empty goes back to ENTRA_TENANT_ID. */
export async function saveMailTenant(value: string, fetcher: Fetcher = fetch): Promise<MailTenant> {
  const v = value.trim().toLowerCase();
  setSetting(SET_KEY, !v || GUID.test(v) ? v : await lookupTenantId(v, fetcher));
  return mailTenant();
}
