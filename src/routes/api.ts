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
  setFieldPermissions,
  setSetting,
  setUserOverrides,
  defaultRules,
  type Role,
  type RuleSet,
  audit
} from "../db/index.js";
import { DIRECTORY_FIELDS } from "../directory/fields.js";
import { syncDirectory } from "../directory/sync.js";
import { getRangeStatus } from "../smtp/ipranges.js";
import { signatureHtml, testSignature } from "../mail/process.js";
import { defaultProfessionalDesign } from "../mail/templates.js";
import type { Design } from "../mail/design.js";

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

  app.put("/api/admins", async (req, reply) => {
    const user = requireRole(["admin"], req, reply);
    if (!user) return;
    const body = req.body as { email?: string; role?: Role };
    if (!body.email || !body.role) return reply.code(400).send({ error: "email and role required" });
    if (body.role === "super_admin") return reply.code(400).send({ error: "super_admin is controlled by SUPER_ADMIN_EMAIL" });
    if (!ASSIGNABLE_ROLES.includes(body.role)) {
      return reply.code(400).send({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` });
    }
    // Owner outranks admin, and requireRole grants owners everything. Only a
    // super admin may create one, otherwise any admin could promote themselves.
    if (body.role === "owner" && user.role !== "super_admin") {
      return reply.code(403).send({ error: "Only the super admin can grant the owner role" });
    }
    setAdminRole(body.email, body.role, user.email);
    audit(user.email, "set_role", body.email, body.role);
    return { ok: true };
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
    if (!requireRole(["admin"], req, reply)) return;
    const host = config.smtp.hostname;
    const header = config.processedHeader;
    const publicHost = new URL(config.publicUrl).host;
    return {
      microsoft: {
        sendConnector: {
          name: "Signer send — route outbound for signatures",
          from: "Office 365",
          to: "Partner organization",
          smartHost: `${host}:587`,
          tls: "Required",
          usage: "Use only when a transport rule redirects messages to this connector"
        },
        receiveConnector: {
          name: "Signer receive — accept signed mail",
          from: "Partner organization",
          to: "Office 365",
          certDomain: host,
          tls: "Required"
        },
        transportRule: {
          name: "Identify messages to send to Signer",
          exceptIfHeader: header,
          exceptIfValue: "true",
          action: "Redirect the message to the Signer send connector",
          scope: "Sender is inside the organization"
        },
        powershell: [
          `$smartHost = "${host}"`,
          `$header = "${header}"`,
          `New-OutboundConnector -Name "Signer send" -ConnectorType Partner -UseMXRecord $false -SmartHosts $smartHost -TlsSettings EncryptionOnly -Enabled $true -RouteAllMessagesViaOnPremises $false -IsTransportRuleScoped $true`,
          `New-InboundConnector -Name "Signer receive" -ConnectorType Partner -SenderDomains * -RequireTls $true -RestrictDomainsToCertificate $true -TlsSenderCertificateName $smartHost`,
          `New-TransportRule -Name "Identify messages to send to Signer" -FromScope InOrganization -ExceptIfHeaderContainsMessageHeader $header -ExceptIfHeaderContainsWords "true" -RouteMessageOutboundConnector "Signer send"`
        ].join("\n")
      },
      google: {
        hostRoute: { name: "Signer", host, port: 25 },
        smtpRelay: {
          name: "Allow Signer to return mail",
          allowedSenders: "Only addresses in my domains",
          auth: "Require TLS",
          note: "Add this instance's public IP to the SMTP relay allow list."
        },
        contentCompliance: {
          name: "Send to Signer",
          affect: "Outbound and Internal - Sending",
          expression: `Advanced content match → Full headers → ${header} → Not contains → true`,
          action: "Change route → Signer; Require secure transport (TLS)"
        }
      },
      spf: `include the sending IP of ${publicHost} (or this host) in each domain's SPF record so signed mail authenticates after it returns through Microsoft/Google.`,
      notes: [
        "Mail is processed on this instance and returned to Microsoft 365 or Google — it is not sent to a third-party SaaS.",
        "Users cannot remove the signature: it is applied after Send on the server, for every client including iOS Mail.",
        "Azure often blocks outbound TCP 25. Prefer inbound 587 from Exchange connectors, and request an SMTP exemption or use MX:25 if your subscription allows it.",
        "Set UPSTREAM_HOST to your tenant's mail.protection.outlook.com hostname (Microsoft) or smtp-relay.gmail.com (Google)."
      ]
    };
  });

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
    const url = saveUpload(file.filename, buffer);
    return { url };
  });

}
