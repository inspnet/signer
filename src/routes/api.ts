import type { FastifyInstance } from "fastify";
import { config, entraConfigured, googleLoginConfigured } from "../config.js";
import { requireRole, requireUser } from "../auth/index.js";
import {
  deleteCampaign,
  deleteDisclaimer,
  deleteSignature,
  getSetting,
  getSignature,
  getUserByEmail,
  listAdminRoles,
  listCampaigns,
  listDisclaimers,
  listFieldPermissions,
  listFolders,
  listGroups,
  listSignatures,
  listUsers,
  mailStats,
  parseJson,
  reorderSignatures,
  saveCampaign,
  saveDisclaimer,
  saveFolder,
  saveSignature,
  saveSignatureRules,
  saveUpload,
  setAdminRole,
  removeAdminRole,
  resolveRole,
  setFieldPermissions,
  setSetting,
  setUserOverrides,
  UnsupportedUploadError,
  defaultRules,
  addDomain,
  DomainError,
  listDomains,
  removeDomain,
  setPrimaryDomain,
  setDomainReturnHost,
  domainNames,
  getDb,
  type Role,
  type RuleSet,
  audit
} from "../db/index.js";
import { DIRECTORY_FIELDS } from "../directory/fields.js";
import { syncDirectory } from "../directory/sync.js";
import { getRangeStatus } from "../smtp/ipranges.js";
import { composeTestMessage, signatureHtml, testSignature } from "../mail/process.js";
import { relayUpstream } from "../smtp/server.js";
import { perDomainMx, returnRouteFor } from "../smtp/route.js";
import { detectPublicIPv4 } from "../system/publicip.js";
import { diagnoseRelay } from "../smtp/diagnose.js";
import { describeFailure } from "../smtp/explain.js";
import {
  checkSentItems,
  pendingSentItems,
  recentSentItemsResults,
  saveSentItemsSettings,
  sentItemsSettings
} from "../mail/sentitems.js";
import { alertSettings, alertsConfigured, lastAlert, saveAlertSettings, sendTestAlert } from "../alerts/index.js";
import {
  checkForUpdates,
  currentVersion,
  requestUpdate,
  UpdateUnavailableError,
  updaterAvailable,
  updateStatus
} from "../system/update.js";
import { defaultProfessionalDesign } from "../mail/templates.js";
import type { Design } from "../mail/design.js";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Roles an admin may hand out through /api/admins. */
const ASSIGNABLE_ROLES: Role[] = ["owner", "admin", "editor", "designer", "user"];

/**
 * What the SMTP allowlist actually resolved to, so an admin can confirm the
 * provider tokens expanded rather than guessing from the deploy log.
 */
function smtpAllowlistStatus(): {
  configured: string[];
  rangeCount: number;
  resolvedFrom: string[];
  usingCache: string[];
  ignored: string[];
  openToAll: boolean;
} {
  const status = getRangeStatus();
  return {
    configured: config.smtp.allowedCidrs,
    rangeCount: status?.cidrs.length ?? 0,
    resolvedFrom: status?.live ?? [],
    usingCache: status?.stale ?? [],
    ignored: status?.invalid ?? [],
    openToAll: !(status?.cidrs.length ?? 0)
  };
}

export function registerApi(app: FastifyInstance): void {
  app.get("/api/health", async () => ({ ok: true, product: "signer" }));

  app.get("/api/bootstrap", async (req) => ({
    user: req.user,
    providers: {
      entra: entraConfigured(),
      google: googleLoginConfigured(),
      dev: config.allowDevLogin && config.demoMode
    },
    demoMode: config.demoMode,
    processedHeader: config.processedHeader,
    publicUrl: config.publicUrl,
    smtpHostname: config.smtp.hostname
  }));

  app.get("/api/home", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const stats = mailStats();
    return {
      stats,
      signatures: listSignatures().length,
      disclaimers: listDisclaimers().length,
      users: listUsers().length,
      lastSync: getSetting("last_directory_sync", "")
    };
  });

  app.get("/api/signatures", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return listSignatures().map((s) => ({
      ...s,
      design: parseJson<Design>(s.designJson, defaultProfessionalDesign()),
      rules: getSignature(s.id)?.rules ?? defaultRules()
    }));
  });

  app.get("/api/signatures/:id", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const sig = getSignature((req.params as { id: string }).id);
    if (!sig) return reply.code(404).send({ error: "Not found" });
    return { ...sig, design: parseJson<Design>(sig.designJson, defaultProfessionalDesign()) };
  });

  app.post("/api/signatures", async (req, reply) => {
    const user = requireRole(["admin", "editor", "designer"], req, reply);
    if (!user) return;
    const body = req.body as { name?: string };
    const saved = saveSignature({ name: body.name || "Untitled signature", design: defaultProfessionalDesign() });
    audit(user.email, "create_signature", saved.id, saved.name);
    return getSignature(saved.id);
  });

  app.put("/api/signatures/:id", async (req, reply) => {
    const user = requireRole(["admin", "editor", "designer"], req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const body = req.body as {
      name?: string;
      enabled?: boolean;
      folderId?: string | null;
      design?: Design;
      htmlOverride?: string | null;
      rules?: RuleSet;
    };
    const existing = getSignature(id);
    if (!existing) return reply.code(404).send({ error: "Not found" });
    saveSignature({
      id,
      name: body.name ?? existing.name,
      enabled: body.enabled,
      folderId: body.folderId,
      design: body.design,
      htmlOverride: body.htmlOverride
    });
    if (body.rules) saveSignatureRules(id, body.rules);
    audit(user.email, "update_signature", id);
    return getSignature(id);
  });

  app.delete("/api/signatures/:id", async (req, reply) => {
    const user = requireRole(["admin", "editor"], req, reply);
    if (!user) return;
    deleteSignature((req.params as { id: string }).id);
    audit(user.email, "delete_signature", (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/api/signatures/reorder", async (req, reply) => {
    const user = requireRole(["admin", "editor"], req, reply);
    if (!user) return;
    const body = req.body as { ids: string[] };
    reorderSignatures(body.ids || []);
    audit(user.email, "reorder_signatures");
    return { ok: true };
  });

  app.get("/api/signatures/:id/preview", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const sig = getSignature((req.params as { id: string }).id);
    if (!sig) return reply.code(404).send({ error: "Not found" });
    const email = String((req.query as { email?: string }).email || req.user!.email);
    const user = getUserByEmail(email) ?? getUserByEmail(req.user!.email);
    if (!user) return reply.code(404).send({ error: "User not found" });
    return { html: signatureHtml(sig, user), user };
  });

  app.get("/api/disclaimers", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return listDisclaimers();
  });

  app.post("/api/disclaimers", async (req, reply) => {
    const user = requireRole(["admin", "editor", "designer"], req, reply);
    if (!user) return;
    const body = req.body as { name?: string; html?: string; enabled?: boolean; rules?: RuleSet; id?: string };
    const saved = saveDisclaimer({
      id: body.id,
      name: body.name || "Untitled disclaimer",
      html: body.html || "<p></p>",
      enabled: body.enabled,
      rules: body.rules
    });
    audit(user.email, "save_disclaimer", saved.id);
    return saved;
  });

  app.delete("/api/disclaimers/:id", async (req, reply) => {
    const user = requireRole(["admin", "editor"], req, reply);
    if (!user) return;
    deleteDisclaimer((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/api/campaigns", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return listCampaigns();
  });

  app.post("/api/campaigns", async (req, reply) => {
    const user = requireRole(["admin", "editor", "designer"], req, reply);
    if (!user) return;
    const body = req.body as {
      id?: string;
      name?: string;
      imageUrl?: string;
      href?: string;
      alt?: string;
      enabled?: boolean;
      rules?: RuleSet;
    };
    return saveCampaign({
      id: body.id,
      name: body.name || "Untitled campaign",
      imageUrl: body.imageUrl || "",
      href: body.href,
      alt: body.alt,
      enabled: body.enabled,
      rules: body.rules
    });
  });

  app.delete("/api/campaigns/:id", async (req, reply) => {
    const user = requireRole(["admin", "editor"], req, reply);
    if (!user) return;
    deleteCampaign((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/api/folders", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return listFolders();
  });

  app.post("/api/folders", async (req, reply) => {
    const user = requireRole(["admin", "editor"], req, reply);
    if (!user) return;
    const body = req.body as { name?: string };
    return saveFolder(body.name || "New folder");
  });

  app.post("/api/tester", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const body = req.body as { from?: string; to?: string; subject?: string; body?: string };
    if (!body.from || !body.to) return reply.code(400).send({ error: "from and to are required" });
    return testSignature({ from: body.from, to: body.to, subject: body.subject, body: body.body });
  });

  // Send the tester's result as a real email, to the person running the test
  // only: anything wider would let the portal send mail as any colleague.
  app.post(
    "/api/tester/send",
    { config: { rateLimit: { max: 10, timeWindow: 10 * 60 * 1000 } } },
    async (req, reply) => {
      const user = requireRole(["admin", "editor", "designer"], req, reply);
      if (!user) return;
      const body = (req.body ?? {}) as { from?: string; to?: string; subject?: string; body?: string };
      const from = String(body.from ?? "").trim().toLowerCase();
      const to = String(body.to ?? "").trim().toLowerCase();
      if (!EMAIL.test(from) || !EMAIL.test(to)) return reply.code(400).send({ error: "From and To must be email addresses." });
      const listed = domainNames();
      if (listed.length && !listed.includes(from.split("@")[1]!)) {
        return reply.code(400).send({ error: "Send tests from an address on one of your domains (Settings → Domains)." });
      }
      if (!config.upstream.host) {
        return reply.code(409).send({ error: "UPSTREAM_HOST is not set, so there is nowhere to send the test." });
      }
      const { raw, result } = await composeTestMessage({
        from,
        testedTo: to,
        deliverTo: user.email,
        subject: body.subject,
        body: body.body
      });
      try {
        await relayUpstream(raw, from, [user.email]);
      } catch (err) {
        return reply.code(502).send({
          error: `Could not hand the test back: ${describeFailure(err)}`
        });
      }
      audit(user.email, "send_test", from, `as received by ${to}`);
      return { ok: true, sentTo: user.email, signature: result.signature?.name ?? null };
    }
  );

  // Admins look people up and fill in the fields the directory does not supply.
  app.put("/api/directory/users/:email", async (req, reply) => {
    const admin = requireRole(["admin"], req, reply);
    if (!admin) return;
    const { email } = req.params as { email: string };
    if (!getUserByEmail(email)) return reply.code(404).send({ error: "No such person in the directory cache." });
    const editable = new Set<string>(DIRECTORY_FIELDS.filter((f) => !f.directory).map((f) => f.key));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const refused = Object.keys(body).filter((key) => !editable.has(key));
    if (refused.length) {
      return reply.code(400).send({
        error: `${refused.join(", ")} come${refused.length === 1 ? "s" : ""} from Entra or Google; change ${refused.length === 1 ? "it" : "them"} there.`
      });
    }
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) overrides[key] = String(value ?? "").slice(0, 255);
    setUserOverrides(email, overrides);
    audit(admin.email, "update_user_details", email.toLowerCase(), Object.keys(overrides).join(","));
    return getUserByEmail(email);
  });

  app.get("/api/users", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return listUsers();
  });

  app.get("/api/groups", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return listGroups();
  });

  app.post("/api/directory/sync", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const result = await syncDirectory();
    audit(user.email, "directory_sync", "", JSON.stringify(result));
    return result;
  });

  app.get("/api/fields", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const perms = listFieldPermissions();
    return DIRECTORY_FIELDS.map((f) => ({
      ...f,
      userEditable: perms.find((p) => p.fieldKey === f.key)?.userEditable ?? false
    }));
  });

  app.put("/api/fields", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const body = req.body as { editable: string[] };
    setFieldPermissions(body.editable || []);
    audit(user.email, "update_field_permissions");
    return listFieldPermissions();
  });

  app.get("/api/me/details", async (req, reply) => {
    const session = requireUser(req, reply);
    if (!session) return;
    const user = getUserByEmail(session.email);
    const perms = listFieldPermissions();
    return {
      user,
      fields: DIRECTORY_FIELDS.map((f) => ({
        ...f,
        userEditable: perms.find((p) => p.fieldKey === f.key)?.userEditable ?? false
      }))
    };
  });

  app.put("/api/me/details", async (req, reply) => {
    const session = requireUser(req, reply);
    if (!session) return;
    const allowed = new Set(listFieldPermissions().filter((p) => p.userEditable).map((p) => p.fieldKey));
    const body = req.body as Record<string, string>;
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowed.has(key) && typeof value === "string") overrides[key] = value.slice(0, 255);
    }
    setUserOverrides(session.email, overrides);
    audit(session.email, "update_my_details");
    return getUserByEmail(session.email);
  });

  app.get("/api/admins", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    return {
      superAdmin: config.superAdminEmail,
      roles: listAdminRoles()
    };
  });

  /**
   * Who may change an existing role. Nobody changes their own (an admin
   * cannot lock themselves out or out-rank the others), the super admin is
   * set by SUPER_ADMIN_EMAIL, and owners outrank admins, so only the super
   * admin may grant, change or remove the owner role.
   */
  const roleChangeRefused = (actor: { email: string; role: Role }, email: string, from: Role, to: Role | null): string | null => {
    if (email === actor.email.toLowerCase()) return "You cannot change your own role. Ask another admin.";
    if (config.superAdminEmail && email === config.superAdminEmail) return "The super admin is set by SUPER_ADMIN_EMAIL on the server.";
    if ((from === "owner" || to === "owner") && actor.role !== "super_admin") return "Only the super admin can grant, change or remove the owner role.";
    return null;
  };

  app.put("/api/admins", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const body = req.body as { email?: string; role?: Role };
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email || !body.role) return reply.code(400).send({ error: "email and role required" });
    if (!EMAIL.test(email)) return reply.code(400).send({ error: "That is not an email address." });
    if (body.role === "super_admin") return reply.code(400).send({ error: "super_admin is controlled by SUPER_ADMIN_EMAIL" });
    if (!ASSIGNABLE_ROLES.includes(body.role)) {
      return reply.code(400).send({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` });
    }
    const refused = roleChangeRefused(user, email, resolveRole(email), body.role);
    if (refused) return reply.code(403).send({ error: refused });
    setAdminRole(email, body.role, user.email);
    audit(user.email, "set_role", email, body.role);
    return { ok: true };
  });

  app.delete("/api/admins/:email", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const email = (req.params as { email: string }).email.trim().toLowerCase();
    const refused = roleChangeRefused(user, email, resolveRole(email), null);
    if (refused) return reply.code(403).send({ error: refused });
    if (!removeAdminRole(email)) return reply.code(404).send({ error: `${email} has no role to remove.` });
    audit(user.email, "remove_role", email);
    return { ok: true };
  });

  // Domains this tenant sends from: who gets signed, and who counts as internal.
  app.get("/api/domains", async (req, reply) => {
    if (!requireRole(["admin"], req, reply)) return;
    const domains = listDomains();
    const listed = new Set(domains.map((d) => d.name));
    // Offer the domains the directory actually uses, so the list is easy to complete.
    const suggestions = (
      getDb()
        .prepare(
          "SELECT domain, COUNT(*) AS people FROM users WHERE domain != '' AND enabled = 1 AND source IN ('entra', 'google') GROUP BY domain ORDER BY people DESC"
        )
        .all() as { domain: string; people: number }[]
    ).filter((s) => !listed.has(s.domain));
    // Where each domain's signed mail goes back to, and why.
    const routes = await Promise.all(domains.map((d) => returnRouteFor(`postmaster@${d.name}`)));
    return {
      domains: domains.map((d, i) => ({ ...d, route: routes[i] })),
      suggestions,
      perDomainMx: perDomainMx(),
      upstreamHost: config.upstream.host
    };
  });

  // Names only, for the rule editors: anyone who edits signatures or disclaimers can target a domain.
  app.get("/api/domains/names", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return listDomains()
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
      .map((d) => d.name);
  });

  app.post("/api/domains", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { name?: string };
    try {
      const domain = addDomain(String(body.name ?? ""), user.email);
      audit(user.email, "add_domain", domain.name);
      return domain;
    } catch (err) {
      if (err instanceof DomainError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete("/api/domains/:name", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const { name } = req.params as { name: string };
    try {
      removeDomain(name);
      audit(user.email, "remove_domain", name);
      return { ok: true };
    } catch (err) {
      if (err instanceof DomainError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.put("/api/domains/:name/return-host", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const { name } = req.params as { name: string };
    const host = String(((req.body ?? {}) as { host?: string }).host ?? "");
    try {
      setDomainReturnHost(name, host);
      audit(user.email, "set_domain_return_host", name, host || "(automatic)");
      return { ok: true, route: await returnRouteFor(`postmaster@${name}`) };
    } catch (err) {
      if (err instanceof DomainError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.put("/api/domains/:name/primary", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const { name } = req.params as { name: string };
    try {
      setPrimaryDomain(name);
      audit(user.email, "set_primary_domain", name);
      return { ok: true };
    } catch (err) {
      if (err instanceof DomainError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Updates: check the git remote, and ask the root-owned updater to install.
  app.get("/api/system/updates", async (req, reply) => {
    if (!requireRole(["admin"], req, reply)) return;
    const current = await currentVersion().catch(() => null);
    return { available: updaterAvailable(), current, status: updateStatus() };
  });

  app.post("/api/system/updates/check", async (req, reply) => {
    if (!requireRole(["admin"], req, reply)) return;
    try {
      return await checkForUpdates({ force: true });
    } catch (err) {
      return reply.code(502).send({ error: `Could not check for updates: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get("/api/system/updates/status", async (req, reply) => {
    if (!requireRole(["admin"], req, reply)) return;
    return updateStatus();
  });

  // Installing restarts mail processing, so it takes an owner.
  app.post("/api/system/updates/install", async (req, reply) => {
    const user = requireRole(["owner"], req, reply);
    if (!user) return;
    try {
      requestUpdate(user.email);
      audit(user.email, "request_update");
      return { ok: true };
    } catch (err) {
      if (err instanceof UpdateUnavailableError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get("/api/settings", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    return {
      organizationName: getSetting("organization_name", "Signer"),
      processedHeader: config.processedHeader,
      smtpHostname: config.smtp.hostname,
      publicUrl: config.publicUrl,
      upstreamHost: config.upstream.host,
      upstreamPort: config.upstream.port,
      entraConfigured: entraConfigured(),
      googleConfigured: googleLoginConfigured(),
      failureMode: config.failureMode,
      smtpAllowlist: smtpAllowlistStatus()
    };
  });

  app.put("/api/settings", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const body = req.body as { organizationName?: string };
    if (body.organizationName) setSetting("organization_name", body.organizationName);
    return { ok: true };
  });

  app.get("/api/mail-flow", async (req, reply) => {
    const admin = requireRole(["admin"], req, reply);
    if (!admin) return;
    const host = config.smtp.hostname;
    const header = config.processedHeader;
    const publicHost = new URL(config.publicUrl).host;
    const ip = await detectPublicIPv4();
    const signerIp = ip.address ?? "<this server's public IPv4>";
    const rule = "Identify messages to send to Signer";
    const ps = {
      smartHost: `$smartHost = "${host}"`,
      signerIp: `$signerIp  = "${signerIp}"`,
      header: `$header    = "${header}"`,
      outbound: `New-OutboundConnector -Name "Signer send" -ConnectorType OnPremises -UseMXRecord $false -SmartHosts $smartHost -TlsSettings DomainValidation -TlsDomain $smartHost -IsTransportRuleScoped $true -CloudServicesMailEnabled $true -Enabled $true`,
      inbound: `New-InboundConnector -Name "Signer receive" -ConnectorType OnPremises -SenderDomains * -SenderIPAddresses $signerIp -RequireTls $true -CloudServicesMailEnabled $true -Enabled $true`,
      rule: `New-TransportRule -Name "${rule}" -FromScope InOrganization -ExceptIfHeaderContainsMessageHeader $header -ExceptIfHeaderContainsWords "true" -RouteMessageOutboundConnector "Signer send" -Enabled $false`,
      pilot: [`Set-TransportRule -Identity "${rule}" -From "pilot.user@yourdomain.com"`, `Enable-TransportRule -Identity "${rule}"`],
      live: `Set-TransportRule -Identity "${rule}" -From $null`,
      rollback: `Disable-TransportRule -Identity "${rule}" -Confirm:$false`
    };
    const isGoogle = /(^|\.)gmail\.com$|google/i.test(config.upstream.host);
    return {
      publicIp: ip,
      provider: isGoogle ? "google" : "microsoft",
      smtp: { host, port: 25 },
      returnPath: perDomainMx()
        ? "Each domain's own MX"
        : config.upstream.host || "UPSTREAM_HOST is not set",
      microsoft: {
        sendConnector: {
          name: "Signer send",
          from: "Office 365",
          to: "Your organization's email server",
          // Exchange Online always delivers to a smart host on port 25.
          smartHost: host,
          tls: `Required; certificate validated against ${host}`,
          usage: "Use only when a transport rule redirects messages to this connector"
        },
        receiveConnector: {
          name: "Signer receive",
          // Only an on-premises connector lets Exchange Online relay the signed
          // message on to external recipients; a partner connector rejects it
          // with 550 5.7.64 TenantAttribution.
          from: "Your organization's email server",
          to: "Office 365",
          identifiedBy: "This server's public IPv4 address",
          tls: "Required"
        },
        transportRule: {
          name: "Identify messages to send to Signer",
          exceptIfHeader: header,
          exceptIfValue: "true",
          action: "Redirect the message to the Signer send connector",
          scope: "Sender is inside the organization",
          // Created disabled: pilot it on one mailbox before every sender goes through Signer.
          enabled: false
        },
        // Each step's block runs on its own, so it sets the variables it uses.
        steps: [
          {
            title: "Connect to Exchange Online",
            detail: "In PowerShell 7, signed in as an Exchange administrator. Install the module once.",
            commands: ["Install-Module ExchangeOnlineManagement -Scope CurrentUser", `Connect-ExchangeOnline -UserPrincipalName ${admin.email}`]
          },
          {
            title: "Outbound connector: Microsoft 365 → Signer",
            detail: `Delivers to ${host} on port 25 and checks its certificate. Only used when the transport rule sends mail to it.`,
            commands: [ps.smartHost, ps.outbound]
          },
          {
            title: "Inbound connector: Signer → Microsoft 365",
            detail: `Recognises this server by ${signerIp}, so Exchange relays signed mail on to outside recipients. If PowerShell warns that it was created disabled, Microsoft support has to enable it.`,
            commands: [ps.signerIp, ps.inbound]
          },
          {
            title: "Transport rule, created off",
            detail: "Sends mail from people in your organisation to Signer, unless it has already been signed. Nothing changes until you turn it on.",
            commands: [ps.header, ps.rule]
          },
          {
            title: "Pilot on one mailbox",
            detail: "Run the return-path test first. Then turn the rule on for one person and check that their mail arrives signed.",
            commands: ps.pilot
          },
          { title: "Go live", detail: "Remove the pilot condition so every sender goes through Signer.", commands: [ps.live] },
          { title: "Roll back, if you need to", detail: "Mail stops going through Signer straight away.", commands: [ps.rollback] }
        ],
        // The whole script in one block, for copying in one go.
        powershell: [
          ps.smartHost,
          ps.signerIp,
          ps.header,
          ``,
          ps.outbound,
          ``,
          ps.inbound,
          ``,
          `# Created disabled, so no mail goes through Signer yet.`,
          ps.rule,
          ``,
          `# Pilot: turn it on for one mailbox only.`,
          ...ps.pilot,
          ``,
          `# Go live: remove the pilot condition so it applies to every sender.`,
          ps.live,
          ``,
          `# Roll back at any time: mail stops going through Signer straight away.`,
          ps.rollback
        ].join("\n")
      },
      google: {
        hostRoute: { name: "Signer", host, port: 25 },
        smtpRelay: {
          name: "Allow Signer to return mail",
          allowedSenders: "Only addresses in my domains",
          auth: "Require TLS",
          note: ip.address
            ? `Add ${ip.address} (this server's public IPv4) to the SMTP relay allow list.`
            : "Add this server's public IPv4 address to the SMTP relay allow list."
        },
        contentCompliance: {
          name: "Send to Signer",
          affect: "Outbound and Internal - Sending",
          expression: `Advanced content match → Full headers → ${header} → Not contains → true`,
          action: "Change route → Signer; Require secure transport (TLS)"
        }
      },
      spf: `No SPF change is needed for ${publicHost}: signed mail goes back through Microsoft 365 or Google and reaches recipients from their servers, so your existing SPF and DKIM records still apply.`,
      notes: [
        "Mail is processed on this server and returned to Microsoft 365 or Google — it is not sent to a third-party SaaS.",
        "Users cannot remove the signature: it is applied after Send on the server, for every client including iOS Mail.",
        "This server must be able to connect out on port 25 (Microsoft 365) or 587 (Google). Many hosting providers, Linode included, block those ports on new accounts until you ask support to lift the restriction.",
        "Signed mail returns to each sending domain's own mail.protection.outlook.com endpoint (its MX) for Microsoft 365, or through smtp-relay.gmail.com for Google. Settings → Domains shows the route for each domain; UPSTREAM_HOST is the fallback."
      ]
    };
  });

  // Talks SMTP to the host signed mail goes back to, stopping before DATA.
  app.post(
    "/api/diagnostics/relay",
    { config: { rateLimit: { max: 20, timeWindow: 10 * 60 * 1000 } } },
    async (req, reply) => {
      const admin = requireRole(["admin"], req, reply);
      if (!admin) return;
      const body = (req.body ?? {}) as { domain?: string; externalRecipient?: string };
      const domains = listDomains();
      const listed = domains.map((d) => d.name);
      const domain = String(body.domain || domains.find((d) => d.primary)?.name || listed[0] || "").trim().toLowerCase();
      if (!domain) return reply.code(400).send({ error: "Add a domain under Settings → Domains first." });
      if (!listed.includes(domain)) return reply.code(400).send({ error: `${domain} is not on the domain list.` });
      const external = String(body.externalRecipient ?? "").trim().toLowerCase();
      if (external && !EMAIL.test(external)) return reply.code(400).send({ error: "The outside address must be an email address." });
      if (external && listed.includes(external.split("@")[1]!)) {
        return reply.code(400).send({
          error: "Use an address outside your organisation: relaying to an outside address is what shows the \"Signer receive\" connector works."
        });
      }
      const adminDomain = admin.email.split("@")[1] ?? "";
      const result = await diagnoseRelay({
        domain,
        sender: adminDomain === domain ? admin.email : undefined,
        internalRecipient: listed.includes(adminDomain) ? admin.email : undefined,
        externalRecipient: external || undefined
      });
      audit(admin.email, "relay_diagnostic", domain, result.ok ? "passed" : (result.steps.find((s) => s.status === "fail")?.step ?? "failed"));
      return result;
    }
  );

  // Alerts for deferred or unsigned mail, sent through Mailgun's HTTP API.
  const alertView = () => {
    const { apiKey, ...rest } = alertSettings();
    return { ...rest, apiKeySet: Boolean(apiKey), configured: alertsConfigured(), last: lastAlert() };
  };

  app.get("/api/alerts", async (req, reply) => {
    if (!requireRole(["admin"], req, reply)) return;
    return alertView();
  });

  app.put("/api/alerts", async (req, reply) => {
    const admin = requireRole(["admin"], req, reply);
    if (!admin) return;
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      domain?: string;
      region?: string;
      apiKey?: string;
      from?: string;
      recipients?: string[] | string;
      intervalMinutes?: number;
    };
    const current = alertSettings();
    const domain = String(body.domain ?? current.domain).trim().toLowerCase();
    if (domain && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      return reply.code(400).send({ error: "The Mailgun domain must be a domain name, such as mg.example.com." });
    }
    const list = Array.isArray(body.recipients) ? body.recipients : String(body.recipients ?? current.recipients.join(",")).split(/[\s,;]+/);
    const recipients = [...new Set(list.map((r) => String(r).trim().toLowerCase()).filter(Boolean))];
    const bad = recipients.filter((r) => !EMAIL.test(r));
    if (bad.length) return reply.code(400).send({ error: `Not an email address: ${bad.join(", ")}` });
    if (recipients.length > 20) return reply.code(400).send({ error: "At most 20 alert recipients." });
    const from = String(body.from ?? current.from).trim();
    if (from && !/<[^@\s<>]+@[^@\s<>]+>$|^[^@\s<>]+@[^@\s<>]+$/.test(from)) {
      return reply.code(400).send({ error: "From must be an address, or a name and <address>." });
    }
    const interval = Number(body.intervalMinutes ?? current.intervalMinutes);
    if (!Number.isInteger(interval) || interval < 5 || interval > 1440) {
      return reply.code(400).send({ error: "The alert interval must be between 5 and 1440 minutes." });
    }
    // The key is never sent back to the browser; leaving the field empty keeps it.
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey;
    const next = {
      enabled: body.enabled ?? current.enabled,
      domain,
      region: body.region === "eu" ? ("eu" as const) : body.region === "us" ? ("us" as const) : current.region,
      apiKey,
      from,
      recipients,
      intervalMinutes: interval
    };
    if (next.enabled && !alertsConfigured(next)) {
      return reply.code(400).send({ error: "Alerts need a Mailgun domain, an API key and at least one recipient." });
    }
    saveAlertSettings(next);
    audit(admin.email, "update_alerts", domain, next.enabled ? "on" : "off");
    return alertView();
  });

  app.post(
    "/api/alerts/test",
    { config: { rateLimit: { max: 10, timeWindow: 10 * 60 * 1000 } } },
    async (req, reply) => {
      const admin = requireRole(["admin"], req, reply);
      if (!admin) return;
      if (!alertsConfigured()) return reply.code(400).send({ error: "Save a Mailgun domain, an API key and a recipient first." });
      const result = await sendTestAlert();
      audit(admin.email, "test_alert", "", result.ok ? "sent" : "failed");
      if (!result.ok) return reply.code(502).send({ error: result.detail });
      return result;
    }
  );

  // Swapping the unsigned copy in Sent Items for the signed one (Microsoft 365).
  const sentItemsView = () => ({
    ...sentItemsSettings(),
    available: entraConfigured(),
    clientId: config.entra.clientId,
    pending: pendingSentItems(),
    results: recentSentItemsResults(),
    groups: listGroups().map((g) => ({ id: g.id, name: g.name }))
  });

  app.get("/api/sent-items", async (req, reply) => {
    if (!requireRole(["admin"], req, reply)) return;
    return sentItemsView();
  });

  app.put("/api/sent-items", async (req, reply) => {
    const admin = requireRole(["admin"], req, reply);
    if (!admin) return;
    const body = (req.body ?? {}) as { enabled?: boolean; groupIds?: unknown };
    const known = new Set(listGroups().map((g) => g.id));
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(String).filter((g) => known.has(g)) : sentItemsSettings().groupIds;
    const enabled = body.enabled ?? sentItemsSettings().enabled;
    if (enabled && !entraConfigured()) {
      return reply.code(400).send({ error: "Sent Items update needs Microsoft 365 sign-in (ENTRA_*) configured on this server." });
    }
    saveSentItemsSettings({ enabled, groupIds });
    audit(admin.email, "update_sent_items", "", `${enabled ? "on" : "off"}; ${groupIds.length ? `${groupIds.length} groups` : "everyone"}`);
    return sentItemsView();
  });

  app.post(
    "/api/sent-items/check",
    { config: { rateLimit: { max: 10, timeWindow: 10 * 60 * 1000 } } },
    async (req, reply) => {
      const admin = requireRole(["admin"], req, reply);
      if (!admin) return;
      const result = await checkSentItems(admin.email);
      audit(admin.email, "check_sent_items", "", result.ok ? "passed" : "failed");
      return result;
    }
  );

  app.get("/api/analytics", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return mailStats();
  });

  app.post("/api/uploads", async (req, reply) => {
    const user = requireRole(["admin", "editor", "designer"], req, reply);
    if (!user) return;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file" });
    const buffer = await file.toBuffer();
    try {
      const url = saveUpload(file.filename, buffer);
      audit(user.email, "upload", url);
      return { url };
    } catch (err) {
      if (err instanceof UnsupportedUploadError) return reply.code(415).send({ error: err.message });
      throw err;
    }
  });

}
