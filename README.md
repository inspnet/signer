# Signer

Self-hosted **server-side** email signatures and legal disclaimers for Microsoft 365 and Google Workspace.

Signatures are applied in the mail flow **after** the user clicks Send — not by pushing HTML into the user's mailbox with Graph or the Gmail API, which iOS Mail and other clients can ignore or overwrite.

Mail is processed on **your own server** (a Linode, set up by one script) and returned to Microsoft 365 or Google. It does not pass through a vendor SaaS, and message content is never stored. See [PRIVACY.md](PRIVACY.md) for exactly what is kept and for how long.

## Why connectors instead of mailbox APIs

| Approach | Consistent on iOS Mail? | User can remove it? | Where mail goes |
| --- | --- | --- | --- |
| Push signature via Microsoft Graph / Gmail API (e.g. client-side tools) | No | Yes | Stays in tenant, but not enforced |
| Exchange transport disclaimer text | Partially | No | Stays in Microsoft 365, very limited design |
| **This product: SMTP gateway + connectors** | Yes | No | Your own server, then back to M365/Google |

Mail path: mailbox → send connector → Signer → receive connector → original recipients. A processed-mail header (`X-Signer-MessageProcessed: true`, configurable) stops connector loops.

## Architecture

```
Outlook / Gmail / iOS Mail
        │
        ▼
Microsoft 365 or Google Workspace
        │  transport rule / content compliance
        │  (except already-processed header)
        ▼
Signer SMTP (your Linode)
  • look up sender in Entra / Google directory cache
  • first matching signature (priority order)
  • matching campaigns + disclaimers
  • insert HTML/text before reply quotes
        │
        ▼
Back to Microsoft 365 MX or Google SMTP relay
        │
        ▼
Recipient
```

The HTTPS portal (admin designer, rules, tester, user details editor) is served by the same process.

## Where the signature is inserted

On replies and forwards, Signer inserts the signature **immediately under the latest reply** and **before the quoted thread**. It does not append at the end of the conversation, which would stack a new copy on every reply.

Detection is client-markup, not a mailbox API. Each client wraps the previous messages in a quote block; we scan for those markers and take the **earliest match in the body**. Using the first pattern in a fixed list is not enough: a Gmail quote can sit above an Outlook `From:` header deeper in the thread, and a miss used to fall through to `</body>`.

| Client | How we find the latest reply |
| --- | --- |
| Gmail / Google Workspace | `gmail_quote`, `gmail_quote_container`, `gmail_attr`; `On … wrote:` |
| Outlook / Exchange / Microsoft 365 | `#appendonsend`, `#divRplyFwdMsg`, `OutlookMessageHeader`, `-----Original Message-----`, From/Sent headers |
| Apple Mail / iOS | `<blockquote type="cite">`, `Begin forwarded message:` |
| Thunderbird | `moz-cite-prefix` |
| Yahoo / Proton Mail | `yahoo_quoted`, `protonmail_quote` |
| Outlook rewriting Gmail HTML | same class names with the `x_` prefix Exchange adds |

New messages (no quote markup) still get the signature at the end of the body. Bottom-posted mail — quoted history first, new text after it — is detected by a quote block at the start with real reply text after it, and the signature is placed after that reply.

---

## Deploy

Signer runs on **one small always-on Linux server**. Inbound SMTP does not fit serverless platforms: they cannot accept SMTP, idle to zero, or time out long mail connections. The supported deployment is a **Linode** (Akamai Cloud) running **Ubuntu 24.04**, set up by one script: `deploy/install.sh`.

Why Linode: the server has to accept SMTP from Microsoft or Google and also **send** SMTP back to them. Several large clouds block outbound port 25 outright. Linode blocks it on new accounts too, but lifts the block when you ask support.

The script installs and configures:

- **Signer** in `/opt/signer`, built with Node.js 22 and run by systemd as `signer.service` under its own `signer` user. It binds ports 25 and 587 through a single Linux capability, so it never runs as root, and systemd keeps it read-only outside its data directory.
- **Nginx** in front of the portal on 80/443, with a **Let's Encrypt** certificate that renews itself. Each renewal is also copied to Signer for SMTP STARTTLS.
- **Configuration** in `/etc/signer/signer.env` (secrets readable only by root and `signer`), with a generated session secret.
- **Data** (SQLite database, uploads, IP range cache) in `/var/lib/signer`, with a nightly backup kept for 14 days.
- **The firewall** (ufw): 22, 80, 443, 25 and 587 open, everything else closed.
- **Log retention**: the system journal, which holds Signer's request log, keeps 14 days ([PRIVACY.md](PRIVACY.md)).
- Automatic Ubuntu security updates, and swap on small servers so builds don't run out of memory.

Running the same script again **updates** Signer to the latest code and keeps your configuration.

### Before you start

1. **A Linode account.**
2. **A DNS name** for the instance, e.g. `signer.example.com`, where you can add A/AAAA records.
3. **The super admin's email** (`SUPER_ADMIN_EMAIL`). That person must be able to sign in with Entra ID or Google.
4. **For Microsoft 365:** the tenant's MX host (Microsoft 365 admin → Settings → Domains → the domain → MX record, e.g. `contoso-com.mail.protection.outlook.com`).
5. **Admin access** to Exchange Online or Google Workspace, and the ability to create an Entra app registration or Google OAuth client for sign-in ([Identity](#identity-entra-or-google)). You can add these after installing.

Do **not** set `DEMO_MODE=true` or `AUTH_ALLOW_DEV_LOGIN=true` on a server that receives real mail.

### Ports

| Direction | What it is | On Linode |
| --- | --- | --- |
| **Inbound** Microsoft 365 → Signer | Exchange Online always delivers to a smart host on **25** | Opened by the script. Not restricted by Linode. |
| **Inbound** Google → Signer | Content compliance "change route" uses the port you choose (25 or 587) | Both opened by the script. |
| **Inbound** browsers → portal | 80 / 443 | Opened by the script. |
| **Outbound** Signer → Microsoft 365 | `<tenant>.mail.protection.outlook.com:25` | **Blocked on new Linode accounts** until support lifts it ([step 4](#4-ask-linode-to-lift-the-smtp-restriction)). |
| **Outbound** Signer → Google | `smtp-relay.gmail.com:587` | **Also blocked** on new accounts: Linode restricts 25, 465 and 587 together. |

Until outbound SMTP is open, Signer cannot hand mail back. It then refuses each message with a temporary error (451), so it waits in Microsoft's or Google's queue and is retried, but it is delayed and eventually bounces if the block stays. **Do not route real mail through Signer until the script reports outbound SMTP as `open`.**

---

### 1. Create the Linode

Linode Cloud Manager → **Create Linode**:

| Setting | Value |
| --- | --- |
| Image | **Ubuntu 24.04 LTS** |
| Region | Closest to the client's Microsoft 365 or Workspace data location |
| Plan | **Linode 2 GB** (shared CPU). A 1 GB Nanode can work: the script adds swap so the build has room |
| Root password / SSH key | An SSH key is better |
| Backups | Turn on if you want off-server copies (recommended) |

Note the **public IPv4 and IPv6** addresses once it boots.

### 2. DNS

At your DNS provider:

```
signer.example.com.   A      <Linode IPv4>
signer.example.com.   AAAA   <Linode IPv6>
```

Let `dig +short signer.example.com` return the address before you run the script, so it can get the certificate on the first run. If DNS isn't ready yet, the script skips the certificate and tells you to run it again later.

### 3. Reverse DNS

Cloud Manager → the Linode → **Network** → each public IP → **Edit RDNS** → `signer.example.com`. Do this for the IPv4 and the IPv6 address. It needs the A/AAAA records from step 2 to exist first.

Linode will not lift the SMTP restriction without matching forward and reverse DNS, and receiving mail servers trust a host more when its name and address agree.

### 4. Ask Linode to lift the SMTP restriction

Linode blocks **outbound** TCP 25, 465 and 587 on Linodes in newer accounts. Open a ticket in Cloud Manager → **Help & Support** → **Open new ticket**, and say:

- which Linode it is (label and IPv4)
- that forward and reverse DNS are set to `signer.example.com`
- what it is for: a signature gateway that relays the organisation's own mail back to Microsoft 365 / Google Workspace, with no bulk or marketing mail
- that you follow CAN-SPAM, which Linode asks you to confirm

Carry on while you wait. The script reports whether outbound SMTP is open, so run it again once support replies.

### 5. Run the install script

SSH in as root and run:

```bash
curl -fsSL https://raw.githubusercontent.com/inspnet/signer/main/deploy/install.sh -o install.sh
sudo bash install.sh
```

It asks for:

| Question | Example |
| --- | --- |
| Hostname | `signer.example.com` |
| Super admin's email | `it-admin@clientdomain.com` (also the Let's Encrypt contact) |
| Mail provider | `microsoft` or `google` |
| Microsoft: tenant MX host | `clientdomain-com.mail.protection.outlook.com` |
| Google: SMTP relay host | `smtp-relay.gmail.com` (the default) |
| Entra tenant ID, client ID and secret, or Google OAuth client ID and secret | Press Enter to skip and add them later |

Everything else is set for you: the provider's published IP ranges as the SMTP allowlist, the right return port, loopback-only HTTP behind Nginx, the TLS paths, demo mode off. A first run takes a few minutes, most of it building the portal.

It finishes with a summary: the portal URL, the public IPs (you need the IPv4 for the mail-flow connectors), whether outbound SMTP is open, and a numbered list of whatever is still left to do.

To answer the questions up front, for example from a Linode StackScript, set `SIGNER_DOMAIN`, `SIGNER_ADMIN_EMAIL`, `SIGNER_PROVIDER` and `SIGNER_UPSTREAM_HOST` before running it.

### 6. Finish the configuration

Edit `/etc/signer/signer.env` for anything you skipped, then `systemctl restart signer`:

- **Sign-in:** `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`, or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` ([Identity](#identity-entra-or-google)).
- **Google directory sync:** `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole key file on one line) and `GOOGLE_ADMIN_EMAIL`.
- **Google SMTP relay with authentication:** `UPSTREAM_USER` / `UPSTREAM_PASS`.

Every setting is documented in the file itself; it starts as a copy of `.env.example`.

### 7. Verify

From your own machine:

```bash
curl -sS https://signer.example.com/api/health
# {"ok":true,"product":"signer"}

# SMTP answers and offers STARTTLS with the right certificate (Microsoft 365 requires it):
openssl s_client -starttls smtp -connect signer.example.com:25 -servername signer.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -enddate
```

The SMTP check only works from an address in the allowlist. From anywhere else Signer answers `554 Relay access denied`, which also shows the allowlist is working.

On the server:

```bash
systemctl status signer
journalctl -u signer -n 50          # look for [signer] WARNING lines and "SMTP allowlist: N ranges"
systemctl list-timers signer-backup.timer certbot.timer
```

Then sign in at `https://signer.example.com` as the super admin, synchronise the directory (**Mail flow → Directory**), and build a signature before connecting mail flow.

---

### Identity (Entra or Google)

`SUPER_ADMIN_EMAIL` is the break-glass owner. That mailbox must sign in through Entra or Google, so at least one provider must be configured.

#### Microsoft Entra ID

1. [Entra admin center](https://entra.microsoft.com) → **App registrations** → New registration.
2. Name: `Signer`. Supported account types: **Accounts in this organizational directory only**.
3. Redirect URI (Web): `https://signer.example.com/api/auth/entra/callback`.
4. Certificates & secrets → new **client secret**. Put the tenant ID, application (client) ID and secret value in `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`.
5. API permissions (delegated): `openid`, `profile`, `email`. Grant admin consent.
6. **Directory sync** (names, titles, groups): add **application** permissions `User.Read.All`, `Group.Read.All`, `GroupMember.Read.All` and grant admin consent. Use the same app, or a second one via `ENTRA_DIRECTORY_CLIENT_ID` / `ENTRA_DIRECTORY_CLIENT_SECRET`.
7. Put them in `/etc/signer/signer.env` and run `systemctl restart signer`. Sign in as `SUPER_ADMIN_EMAIL`, then **Mail flow → Directory → Synchronise**.

#### Google Workspace

1. [Google Cloud console](https://console.cloud.google.com/apis/credentials), in any project (it only holds the OAuth client; nothing is hosted there) → **OAuth consent screen** → Internal.
2. **Credentials** → OAuth client ID → Web application. Authorized redirect URI: `https://signer.example.com/api/auth/google/callback`. Fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. Directory sync: create a **service account**, download its JSON key, and put the **entire JSON** on one line in `GOOGLE_SERVICE_ACCOUNT_JSON`. Enable the [Admin SDK API](https://console.cloud.google.com/apis/library/admin.googleapis.com).
4. Workspace Admin → Security → Access and data control → API controls → **Domain-wide delegation**: add the service account's client ID with these scopes:
   - `https://www.googleapis.com/auth/admin.directory.user.readonly`
   - `https://www.googleapis.com/auth/admin.directory.group.readonly`
5. `GOOGLE_ADMIN_EMAIL` must be a super admin (or delegated admin) that the service account impersonates.
6. Restart Signer, sign in as `SUPER_ADMIN_EMAIL`, then synchronise the directory from the portal.

---

### Connect Microsoft 365

**Mail flow → Connectors** in the portal shows these commands with your hostname and header filled in. Run them in Exchange Online PowerShell (`Connect-ExchangeOnline`):

```powershell
$smartHost = "signer.example.com"            # SMTP_HOSTNAME
$signerIp  = "<server public IPv4>"          # printed by the install script
$header    = "X-Signer-MessageProcessed"     # PROCESSED_HEADER

# Microsoft 365 → Signer. Exchange Online delivers to smart hosts on port 25 and
# checks that Signer's certificate is valid for $smartHost.
New-OutboundConnector -Name "Signer send" -ConnectorType Partner -UseMXRecord $false `
  -SmartHosts $smartHost -TlsSettings DomainValidation -TlsDomain $smartHost `
  -IsTransportRuleScoped $true -CloudServicesMailEnabled $true -Enabled $true

# Signer → Microsoft 365. "From your organization's email server", identified by
# this server's IP: only this connector type lets Exchange relay the signed
# message on to external recipients.
New-InboundConnector -Name "Signer receive" -ConnectorType OnPremises -SenderDomains * `
  -SenderIPAddresses $signerIp -RequireTls $true -CloudServicesMailEnabled $true -Enabled $true

# Send in-organisation mail to Signer unless it has already been processed.
New-TransportRule -Name "Identify messages to send to Signer" `
  -FromScope InOrganization `
  -ExceptIfHeaderContainsMessageHeader $header `
  -ExceptIfHeaderContainsWords "true" `
  -RouteMessageOutboundConnector "Signer send"
```

Notes:

- **The return connector must be `OnPremises`.** With a `Partner` inbound connector, Exchange accepts the signed message but refuses to relay it to external recipients (`550 5.7.64 TenantAttribution; Relay Access Denied`).
- **Some tenants create `OnPremises` connectors disabled.** Microsoft does this for tenants created since 2023 on Business Basic, Business Standard or Exchange Online Essentials. If `New-InboundConnector` warns *"created in a disabled state. Contact Support to enable it"*, open a Microsoft 365 support request. Explain that a self-hosted signature gateway returns the organisation's own outbound mail through it, then wait for Microsoft to enable it before creating the transport rule.
- **Do not add `-RestrictDomainsToIPAddresses` or `-RestrictDomainsToCertificate`.** With `-SenderDomains *`, either one tells Exchange to reject every message to the tenant that does not come from Signer, which includes all normal inbound mail.
- `-CloudServicesMailEnabled` keeps Exchange's internal headers on the round trip, so the returned message is still treated as sent by the organisation, and internal mail stays internal. It is the same setting commercial signature services use.
- The transport rule only diverts in-organisation senders whose mail lacks the processed header, which is what prevents loops.
- **Create the transport rule last**, after the health check, STARTTLS check and outbound SMTP all pass. Until the rule exists, no mail goes through Signer.
- Test with one mailbox first: add `-From user@clientdomain.com` to the transport rule, send to an external address, and check **Activity** in the portal and `journalctl -u signer`. Then remove the condition.

### Connect Google Workspace

In [admin.google.com](https://admin.google.com) → Apps → Google Workspace → Gmail:

1. **Hosts**: add `signer.example.com`, port **25** (or 587), and require TLS.
2. **SMTP relay service**: allow Signer to hand mail back. Allowed senders **Only addresses in my domains**, require TLS, and IP allow list containing the server's **public IPv4** (the install script prints it). Signer connects over IPv4 when it can.
3. **Compliance → Content compliance** (Outbound and Internal - sending): advanced content match on **Full headers**, `X-Signer-MessageProcessed` **does not contain** `true` → **Change route** to the Signer host, require secure transport.

**SPF and DKIM need no changes** for either provider. Signed mail goes back through Microsoft 365 or Google and reaches recipients from their servers, and they DKIM-sign it on the way out. Signer's own IP never appears as the sender to the outside world.

---

### Operations

**Updating.** `sudo bash /opt/signer/deploy/install.sh`. It pulls the latest `main`, rebuilds, restarts Signer and reports health. Your configuration is kept. Local changes to files in `/opt/signer` are discarded, so keep configuration in `/etc/signer/signer.env`. Restarting drops SMTP connections in progress; Microsoft and Google retry them.

**Configuration changes.** Edit `/etc/signer/signer.env`, then `systemctl restart signer`.

**Logs.** `journalctl -u signer -f`. The journal keeps 14 days, and Nginx's access log is off, so client IP addresses are not kept longer than [PRIVACY.md](PRIVACY.md) states.

**Certificates.** `certbot.timer` renews the Let's Encrypt certificate. The deploy hook `/etc/letsencrypt/renewal-hooks/deploy/signer` copies each new certificate to `/etc/signer/tls`, reloads Nginx and restarts Signer, so SMTP STARTTLS never serves an expired certificate. `certbot renew --dry-run` tests renewal.

**Backups.** `signer-backup.timer` takes a consistent SQLite snapshot and archives the uploads every night into `/var/lib/signer/backups`, keeping 14 days. Run one now with `sudo -u signer /usr/local/sbin/signer-backup`. These copies are on the same disk, so also enable **Linode Backups**. To restore: `systemctl stop signer`, `gunzip` the chosen `signer-*.db.gz` over `/var/lib/signer/signer.db`, untar the matching `uploads-*.tgz` into `/var/lib/signer`, `chown -R signer:signer /var/lib/signer`, then `systemctl start signer`.

**Health**

| Check | Command / place |
| --- | --- |
| Portal | `curl -sS https://signer.example.com/api/health` |
| Service | `systemctl status signer`, `journalctl -u signer -n 100` |
| SMTP + TLS | `openssl s_client -starttls smtp -connect signer.example.com:25 </dev/null` (from an allowed address) |
| Outbound SMTP | Re-run the install script; it tests `UPSTREAM_HOST:UPSTREAM_PORT` |
| Allowlist | `GET /api/settings` → `smtpAllowlist` |
| Loop header | Message trace in Microsoft 365 / Gmail shows `X-Signer-MessageProcessed: true` after a successful pass |
| Unsigned mail | `FAILURE_MODE=fail-open` delivers without a signature if processing throws; `fail-closed` returns SMTP 4xx so the tenant retries. Mail Signer cannot hand back is always deferred with 451, in either mode |

#### Troubleshooting

- **The script says Signer did not start** → it prints the last log lines; `journalctl -u signer -n 100` shows more. Fatal configuration errors are printed as `[signer] FATAL:`: a missing `SESSION_SECRET`, a `TLS_CERT_PATH` that cannot be read, a numeric `TRUST_PROXY`, or an `SMTP_ALLOWED_CIDRS` provider that cannot be resolved with nothing cached (see [Provider IP ranges](#provider-ip-ranges)).
- **No certificate** → the hostname did not resolve to this server when the script ran, or port 80 was unreachable. Fix DNS and re-run the script.
- **`SMTP port 25 unavailable (EACCES)`** → Signer was started outside `signer.service`, so it lacks the capability to bind low ports. Start it with `systemctl` only.
- **`SMTP port 25 unavailable (EADDRINUSE)`** → another mail server holds the port. `ss -ltnp 'sport = :25'`, stop it, re-run the script.
- **Microsoft 365 queues mail with a TLS error (`4.4.317`)** → STARTTLS is not offered or the certificate does not match `signer.example.com`. Check `TLS_CERT_PATH`, `SMTP_HOSTNAME`, and the `openssl s_client` output above.
- **`550 5.7.64 TenantAttribution; Relay Access Denied`** → the return connector is not an `OnPremises` connector, is disabled, or does not list this server's IPv4. See [Connect Microsoft 365](#connect-microsoft-365).
- **Mail is delayed or bounces after passing through Signer** → outbound SMTP is still blocked (re-run the script to check) or `UPSTREAM_*` is wrong. Signer defers mail it cannot hand back, so the provider's queue holds it until the block is lifted or the provider gives up.
- **Relay fails with a certificate error** → upstream TLS is verified by default. Against a real `mail.protection.outlook.com` or `smtp-relay.gmail.com` host, this means the hostname is wrong. Only set `UPSTREAM_TLS_REJECT_UNAUTHORIZED=false` for a lab host with a self-signed certificate: it lets anyone on the network path read and alter the mail.
- **Exchange or Gmail cannot connect at all** → if `SMTP_ALLOWED_CIDRS` is set, the connecting host is outside it. `GET /api/settings` shows what the allowlist resolved to. If a Linode Cloud Firewall is attached, it must allow 25 and 587 as well.
- **OIDC redirect mismatch** → `PUBLIC_URL` and the Entra/Google redirect URI must match exactly (`https://host`, no trailing slash in `PUBLIC_URL`).
- **Super admin cannot sign in** → the mailbox must match `SUPER_ADMIN_EMAIL` (case-insensitive).
- **Connector loop** → the transport rule or content compliance rule must skip mail whose processed header is `true`.
- **Empty signature fields** → run directory sync. Users only exist in the cache after an Entra/Google sync (or the demo seed).
- **Logo upload rejected with 415** → only PNG, JPEG, GIF and WEBP are accepted, judged by file contents, not extension. SVG is refused deliberately: email clients do not render it (see [Portal hardening](#portal-hardening)).
- **Sign-in returns 429** → the per-IP limit on sign-in routes. If everyone hits it together, the proxy's address is being counted instead of the client's: check that `TRUST_PROXY=loopback` and that Nginx still sets `X-Forwarded-For` (`/etc/nginx/sites-available/signer`, rewritten by each run of the script).
- **A schedule fires at the wrong time** → set the timezone on the rule. Without one it follows the server's zone, which is UTC on a Linode (see [Schedules and timezones](#schedules-and-timezones)).

### Docker alternative

`Dockerfile` and `docker-compose.yml` run the same thing in a container on any Linux host where outbound SMTP is allowed. The portal is published on `127.0.0.1:3000` for a reverse proxy on the host (`deploy/Caddyfile` for Caddy). SMTP is published on 587, plus 25 if you uncomment it. Data lives in the `signer-data` volume. You still need steps 2–4 above, plus a `.env` with `TLS_CERT_PATH` / `TLS_KEY_PATH` pointing at a certificate mounted into the container.

```bash
cp .env.example .env    # fill in PUBLIC_URL, SUPER_ADMIN_EMAIL, SESSION_SECRET, SMTP_*, UPSTREAM_*, sign-in
docker compose up -d --build
docker compose logs -f --tail=80
```

---

## Product surface

- **Signatures** — create, folders, evaluation order, block designer, HTML fields from the directory
- **Rules** — senders, exceptions, groups/domains, internal vs external recipients, date/time with a per-rule timezone, reply/thread advanced rules
- **Disclaimers** — separate legal notices (e.g. external-only confidentiality)
- **Campaigns** — banner images with the same rule engine
- **Rule tester** — dry-run with per-rule pass/fail (does not send mail)
- **User details** — employees edit only admin-unlocked fields
- **RBAC** — owner / admin / editor / designer / user. Admins manage roles, but only `SUPER_ADMIN_EMAIL` can grant `owner`
- **Uploads** — PNG, JPEG, GIF and WEBP artwork, validated by file contents rather than extension
- **Analytics** — counts and a 30-day activity log of senders and recipients; message content is never stored ([PRIVACY.md](PRIVACY.md))

## Local development

```bash
cp .env.example .env
# DEMO_MODE=true
# AUTH_ALLOW_DEV_LOGIN=true
# SUPER_ADMIN_EMAIL=it-admin@example.com
# SMTP_PORT=2525
npm install
cd web && npm install && cd ..
npm test
npm run dev
```

Portal: http://localhost:5173 (API proxied to :3000).

Single image (lab):

```bash
docker build -t signer:local .
docker run --rm -p 3000:3000 -p 587:587 -p 2525:2525 \
  --env-file .env -v signer-data:/data signer:local
```

## Configuration reference

See `.env.example` for the full list with comments. The keys that matter most:

| Key | Default | Notes |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | Must match the OIDC redirect URI exactly, no trailing slash |
| `DATA_DIR` | `./data` | Database, uploads and IP range cache. Keep it outside the checkout (`/var/lib/signer` from the install script) |
| `HTTP_HOST` / `HTTP_PORT` | `0.0.0.0` / `3000` | `127.0.0.1` when a proxy on the same machine fronts the portal (the install script sets this) |
| `TRUST_PROXY` | `loopback` | Peers allowed to set `X-Forwarded-For`. Names (`loopback`, `uniquelocal`) or addresses; not a hop count |
| `SUPER_ADMIN_EMAIL` | — | Break-glass owner; the only account that can grant the `owner` role |
| `SESSION_SECRET` | — | **Required.** The server exits without it unless `DEMO_MODE=true` |
| `SMTP_ALLOWED_CIDRS` | empty | CIDRs, or `microsoft` / `google`. Empty accepts mail from anyone |
| `SMTP_RANGE_REFRESH_MINUTES` | `720` | How often provider ranges are re-resolved; `0` disables |
| `SMTP_HOSTNAME` | `signer.local` | Name in the SMTP banner; must match the TLS certificate |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | — | Certificate for SMTP STARTTLS. Required for Microsoft 365. If set, both must be readable or startup fails |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` | — / `25` | Where signed mail is handed back |
| `UPSTREAM_TLS_REJECT_UNAUTHORIZED` | `true` | Verify the upstream certificate. Only turn off for a lab host with a self-signed cert |
| `PROCESSED_HEADER` | `X-Signer-MessageProcessed` | Must match the connector rule that skips already-processed mail |
| `FAILURE_MODE` | `fail-open` | `fail-open` delivers unsigned if processing throws; `fail-closed` defers with 4xx. Either way, mail that cannot be handed back is deferred, never dropped |
| `MAIL_LOG_RETENTION_DAYS` | `30` | Days the activity log (senders, recipients, outcome) is kept; `0` keeps it forever. Stated in [PRIVACY.md](PRIVACY.md) |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | Days the admin audit trail is kept; `0` keeps it forever |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MINUTES` | `20` / `5` | Sign-in attempts per client IP per window |
| `OIDC_DISCOVERY_CACHE_MINUTES` | `60` | How long a provider's discovery document is reused; `0` disables |
| `DEMO_MODE` | `false` | Seeds sample data and allows dev login. Never enable on an instance handling real mail |

### Startup checks

The server validates its configuration before it listens:

- **`SESSION_SECRET` is required.** Without it the process exits, because session
  cookies would otherwise be signed with a key an attacker could guess. In
  `DEMO_MODE` a random per-process key is used instead, so sessions end at
  restart.
- **A configured certificate must exist.** If `TLS_CERT_PATH` or `TLS_KEY_PATH`
  is set, both must be set and readable. Before this check, a missing file
  quietly turned STARTTLS off, and Microsoft 365 then stopped delivering to the
  gateway with no error in Signer's own log.
- **`TRUST_PROXY` must name the proxy.** A hop count such as `1` is rejected,
  because Fastify ignores hop counts and would trust nobody.
- Warnings (printed, not fatal) cover an empty `SMTP_ALLOWED_CIDRS`, SMTP
  without a certificate, an unset `SMTP_HOSTNAME`, `TRUST_PROXY=true`, disabled
  upstream TLS verification, `DEMO_MODE`, a missing `UPSTREAM_HOST`, a missing
  `SUPER_ADMIN_EMAIL`, and having no login provider configured.

Read the deploy log after the first start — every one of these is something that
will bite later.

## Provider IP ranges

`SMTP_ALLOWED_CIDRS` accepts explicit CIDRs, the names `microsoft` and `google`,
or any mix of the two. The names resolve from the SPF records the providers
publish — `spf.protection.outlook.com` and `_spf.google.com` — which list exactly
the hosts their mail servers send from. Aliases are accepted (`m365`,
`office365`, `o365`, `exchange`, `outlook`; `workspace`, `gmail`).

SPF is used in preference to Microsoft's `endpoints.office.com` web service
because it needs only DNS rather than outbound HTTPS, it is one mechanism for
both providers, and it lists sending hosts rather than every address the service
uses.

**These ranges cover the provider's whole platform, not your tenant.** Allowing
`microsoft` means any Microsoft 365 tenant could reach the gateway, not only
yours. That keeps the open internet out, which is the point of the allowlist, but
it is not tenant isolation — require TLS on the connector as well.

How it behaves:

- Resolved at startup and re-resolved every `SMTP_RANGE_REFRESH_MINUTES`
  (default 720, i.e. twice a day; `0` disables the refresh).
- The answer is cached to `<DATA_DIR>/ip-ranges.cache.json`. If DNS is down at
  startup, the cached copy is used and a warning is logged.
- If a name cannot be resolved **and** nothing is cached, the server refuses to
  start. An unresolved allowlist would otherwise be an empty one, and an empty
  allowlist accepts mail from anyone — failing to start is the safer outcome.
- A failed refresh keeps the ranges already in force rather than replacing them
  with a partial answer.
- Entries that are neither a provider name nor a valid CIDR are ignored with a
  warning, not treated as a match.

`GET /api/settings` reports what the allowlist actually resolved to
(`smtpAllowlist`), so you can confirm the expansion without reading the log.

## Portal hardening

**Uploads.** Signature artwork is served from the same origin as the portal, so
a file a browser treats as a document is stored XSS against every admin who
opens it. Uploads are therefore identified by their magic bytes, not by the
filename or the browser-supplied content type, and only PNG, JPEG, GIF and WEBP
are accepted. The stored extension comes from the detected format, so a file
cannot be served as something it is not.

SVG is rejected outright. That costs nothing — Gmail, Outlook and Apple Mail do
not render SVG in `<img>` — and it removes the only image format that can carry
script.

Everything under `/uploads/` is served with `X-Content-Type-Options: nosniff` and
a `default-src 'none'; ... sandbox` CSP, and anything that is not a recognised
raster image is sent as `Content-Disposition: attachment`. That last part covers
files uploaded before this validation existed, which are still on disk.

**Sign-in rate limiting.** The routes that start or complete a login are capped
per client IP (`AUTH_RATE_LIMIT_MAX` per `AUTH_RATE_LIMIT_WINDOW_MINUTES`,
default 20 per 5 minutes). `/api/auth/me` and `/api/auth/providers` are left
uncapped because the portal polls them. Behind a proxy the client address
comes from `X-Forwarded-For`, but only when the connection comes from a peer
named in `TRUST_PROXY` (default `loopback`). Trusting the header from anyone,
which this server did until now, let a client send its own `X-Forwarded-For`
and get a fresh rate-limit bucket on every request.

OIDC discovery documents are cached for `OIDC_DISCOVERY_CACHE_MINUTES` (default
60). Without that, every hit on an unauthenticated sign-in route made this server
issue an outbound request to the identity provider.

## Schedules and timezones

A signature limited to a schedule is evaluated against the wall clock in the
timezone chosen on the rule, not the server's. A server almost always runs
UTC, so a 09:00–17:00 rule set by a London office would otherwise drift by an
hour for half the year and be plain wrong elsewhere.

- Days of the week and working hours are read in the rule's timezone.
- Start and end values from the portal's date pickers are wall-clock times in
  that timezone. A value carrying an explicit offset (`Z` or `+01:00`) is treated
  as an absolute instant instead.
- A date-only end is inclusive: "ends 2026-01-15" runs through the end of the
  15th.
- An unrecognised timezone falls back to the server's and says so in the rule
  tester, rather than dropping the schedule.

## What the gateway does and does not rewrite

Applying a signature means rebuilding the message from its text and HTML bodies
plus its attachments, so a few classes of mail are relayed **untouched** rather
than risk destroying them:

- `text/calendar` parts — meeting invites
- `multipart/signed` and `multipart/encrypted` — S/MIME and PGP
- `application/pkcs7-mime`, `application/pgp-encrypted`
- `multipart/report` — delivery status and bounce notifications
- any message where no signature, disclaimer or campaign matches

These still get the loop-prevention header so the connector does not send them
back, but the body is passed through byte for byte. **Meeting invites therefore
do not carry a signature.**

For messages that are rewritten, the original headers are carried over verbatim
with two deliberate exceptions: the headers that describe the body
(`Content-Type`, `Content-Transfer-Encoding`, `MIME-Version`) are regenerated,
and `DKIM-Signature` is dropped because the body changed and the old signature no
longer verifies. Microsoft 365 and Google re-sign the message when it returns
through their connectors, which is why the return path must go back through them.
