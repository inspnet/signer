# Signer

Self-hosted **server-side** email signatures and legal disclaimers for Microsoft 365 and Google Workspace.

Signatures are applied in the mail flow **after** the user clicks Send — not by pushing HTML into the user's mailbox with Graph or the Gmail API, which iOS Mail and other clients can ignore or overwrite.

Mail is processed on **your own server** (deployed on Linode with Laravel Forge) and returned to Microsoft 365 or Google. It does not pass through a vendor SaaS.

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

Signer runs on **one small always-on Linux server**. Inbound SMTP does not fit serverless platforms: they cannot accept SMTP, idle to zero, or time out long mail connections. The supported deployment is a **Linode** (Akamai Cloud) server provisioned and deployed with **[Laravel Forge](https://forge.laravel.com)**, using the recipe in `deploy/forge/`.

Why Linode: the server has to accept SMTP from Microsoft or Google and also **send** SMTP back to them. Several large clouds block outbound port 25 outright. Linode blocks it on new accounts too, but lifts the block when you ask support.

When you are done you will have:

- **The portal** at `https://signer.example.com`, served by Forge's Nginx with a Let's Encrypt certificate and proxied to Signer on `127.0.0.1:3000`.
- **The SMTP gateway** on **25** and **587**, with STARTTLS using the same certificate.
- **Signer under systemd** (`signer.service`), running as the `forge` user. It can bind ports 25 and 587 through a single Linux capability, so it never runs as root.
- **Data** (SQLite database, uploads, IP range cache) in `/home/forge/signer-data`, outside the git checkout, with a nightly backup kept for 14 days.
- **Signed mail handed back** to your Microsoft 365 tenant or Google Workspace. No third-party SaaS sees it.

### Files in `deploy/forge/`

| File | Where it goes in Forge | What it does |
| --- | --- | --- |
| `recipe.sh` | **Recipes**, run as `root` | Sets up the server: Node 22, `signer.service`, certificate sync, backups, sudo permission for deploys, ufw ports 25/587, and an outbound SMTP check |
| `deploy.sh` | Site → **Deploy script** | `git pull`, `npm ci`, build, restart, then fails the deploy if `/api/health` does not answer |
| `nginx.conf` | Site → **Edit Nginx configuration** | Replaces the PHP `location` blocks with a proxy to Signer |

The recipe is safe to run again. Run it again after you change the domain, and after Linode lifts the SMTP block, to recheck outbound mail.

### Before you start

1. **A Linode account** connected to Forge as a server provider (a Linode personal access token that can create Linodes).
2. **A DNS name** for the instance, e.g. `signer.example.com`. You need to be able to add A/AAAA records for it.
3. **Admin access** to Microsoft 365 (Exchange Online) **or** Google Workspace, depending on where the client's mail lives. Also the ability to create an app registration (Entra) or OAuth client (Google) for sign-in.
4. **The break-glass owner's mailbox** (`SUPER_ADMIN_EMAIL`). That person must be able to sign in with Entra ID or Google.
5. **A session secret**: `openssl rand -base64 48`.
6. **Forge access to the repository** (`inspnet/signer`) through its GitHub integration.

Do **not** set `DEMO_MODE=true` or `AUTH_ALLOW_DEV_LOGIN=true` on a server that receives real mail.

### Ports

| Direction | What it is | On Linode + Forge |
| --- | --- | --- |
| **Inbound** Microsoft 365 → Signer | Exchange Online always delivers to a smart host on **25** | The recipe opens 25 in ufw. Not restricted by Linode. |
| **Inbound** Google → Signer | Content compliance "change route" uses the port you choose (25 or 587) | The recipe opens 25 and 587 in ufw. |
| **Inbound** browsers → portal | 80 / 443 | Forge opens these when it provisions the server. |
| **Outbound** Signer → Microsoft 365 | `<tenant>.mail.protection.outlook.com:25` | **Blocked on new Linode accounts** until support lifts it ([step 4](#4-ask-linode-to-lift-the-smtp-restriction)). |
| **Outbound** Signer → Google | `smtp-relay.gmail.com:587` | **Also blocked** on new accounts: Linode restricts 25, 465 and 587 together. |

Until outbound SMTP is open, Signer accepts mail but cannot hand it back. With `FAILURE_MODE=fail-open` it will then try to relay the message unsigned, and that fails the same way. **Do not route real mail through Signer until the recipe reports outbound SMTP as `open`.**

---

### 1. Create the server in Forge

Forge → **Create server** → provider **Akamai (Linode)**:

| Setting | Value |
| --- | --- |
| Server type | **Web server** (Nginx; no database needed, because Signer uses SQLite) |
| Region | The Linode region closest to the client's Microsoft 365 or Workspace data location |
| Plan | **Linode 2 GB** (shared CPU). With 1 GB the `npm run build` step in each deploy risks running out of memory |
| OS | Ubuntu 24.04 LTS (Forge's default) |

Save the sudo password Forge shows you. When provisioning finishes, note the server's **public IPv4 and IPv6** addresses from Forge or Linode Cloud Manager.

### 2. DNS

At your DNS provider:

```
signer.example.com.   A      <server IPv4>
signer.example.com.   AAAA   <server IPv6>
```

Wait until `dig +short signer.example.com` returns the address before continuing. Let's Encrypt and Linode's reverse DNS both check it.

### 3. Reverse DNS

Linode Cloud Manager → **Linodes** → the server → **Network** → each public IP → **Edit RDNS** → `signer.example.com`. Do this for the IPv4 and the IPv6 address.

Linode will not lift the SMTP restriction without matching forward and reverse DNS, and receiving mail servers trust a host more when its name and address agree.

### 4. Ask Linode to lift the SMTP restriction

Linode blocks **outbound** TCP 25, 465 and 587 on Linodes in newer accounts. Open a ticket in Cloud Manager → **Help & Support** → **Open new ticket**, and say:

- which Linode it is (label and IPv4)
- that forward and reverse DNS are set to `signer.example.com`
- what it is for: a signature gateway that relays the organisation's own mail back to Microsoft 365 / Google Workspace, with no bulk or marketing mail
- that you follow CAN-SPAM, which Linode asks you to confirm

Carry on with the next steps while you wait. The recipe reports whether outbound SMTP is open, and you can run it again once support replies.

### 5. Create the site

Forge → the server → **New site**:

- **Domain**: `signer.example.com`
- **Project type**: the plain/static HTML option. Nothing PHP-specific is needed. Leave the web directory at its default; Nginx proxies everything to Signer.
- Leave "Install Composer dependencies" and database creation unchecked.

Then on the site:

1. **Git repository**: GitHub, `inspnet/signer`, branch `main`. Do not deploy yet.
2. **Deploy script**: replace it with `deploy/forge/deploy.sh`, and change the `cd` path to `/home/forge/signer.example.com`. Turn on **Quick deploy** if pushes to `main` should go straight out. Plain in-place deployments are simplest. If the site was created with zero-downtime deployments, follow the comment at the top of `deploy.sh`.
3. **Nginx**: *Edit Nginx configuration* and follow the comment in `deploy/forge/nginx.conf`. Replace the `location / { ... }` block with the two blocks from that file, and delete the `location ~ \.php$ { ... }` block.
4. **SSL**: Let's Encrypt for `signer.example.com`. Forge renews it automatically, and the recipe passes each renewal through to SMTP.

### 6. Environment

Site → **Environment**. Forge writes this to the site's `.env`. Start from `.env.example` and set at least the values below. The recipe prints the server-specific ones again when it finishes.

Common to every deployment:

```bash
PUBLIC_URL=https://signer.example.com
SUPER_ADMIN_EMAIL=it-admin@clientdomain.com
SESSION_SECRET=<openssl rand -base64 48>

# Layout created by the Forge recipe
DATA_DIR=/home/forge/signer-data
HTTP_HOST=127.0.0.1
HTTP_PORT=3000
TRUST_PROXY=loopback

# SMTP
SMTP_HOSTNAME=signer.example.com
SMTP_PORT=25
SMTP_SUBMISSION_PORT=587
SMTP_ALT_PORT=0
TLS_CERT_PATH=/home/forge/signer-tls/fullchain.pem
TLS_KEY_PATH=/home/forge/signer-tls/privkey.pem

FAILURE_MODE=fail-open
DEMO_MODE=false
AUTH_ALLOW_DEV_LOGIN=false
```

**Microsoft 365** clients add:

```bash
# Only accept connections from the ranges Microsoft publishes for Exchange Online.
SMTP_ALLOWED_CIDRS=microsoft
# Hand signed mail back to the tenant's MX host (Microsoft 365 admin → Settings →
# Domains → the domain → MX record).
UPSTREAM_HOST=clientdomain-com.mail.protection.outlook.com
UPSTREAM_PORT=25
UPSTREAM_SECURE=false

ENTRA_TENANT_ID=<directory (tenant) ID>
ENTRA_CLIENT_ID=<application (client) ID>
ENTRA_CLIENT_SECRET=<client secret value>
```

**Google Workspace** clients add:

```bash
SMTP_ALLOWED_CIDRS=google
UPSTREAM_HOST=smtp-relay.gmail.com
UPSTREAM_PORT=587
UPSTREAM_SECURE=false
# Only if the Workspace SMTP relay is set to require authentication:
# UPSTREAM_USER=
# UPSTREAM_PASS=

GOOGLE_CLIENT_ID=<OAuth client ID>
GOOGLE_CLIENT_SECRET=<OAuth client secret>
# Directory sync (needed for live names and titles):
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_ADMIN_EMAIL=admin@clientdomain.com
```

Keep `DATA_DIR` outside the checkout. A relative path such as `./data` puts the database inside the git working tree, or inside a release directory that a zero-downtime deploy throws away.

### 7. Run the recipe

Forge → **Recipes** → **New recipe**: name `Signer`, user **root**, script: the contents of `deploy/forge/recipe.sh`. Edit `SIGNER_DOMAIN` at the top (and `SIGNER_USER` if the site is isolated), then **Run** it on the server.

Forge shows the output when the recipe finishes (and can email it). Read it: it ends with the server's public IPs, the `.env` values it expects, and whether outbound SMTP to your `UPSTREAM_HOST` is `open` or `BLOCKED`.

The first time, the recipe usually reports *"Not started yet"*, because the code has not been deployed. That is expected.

### 8. Deploy

Site → **Deploy now**. The deploy script builds Signer, restarts `signer.service` and waits for `/api/health`. If Signer does not come up, the deploy fails and Forge notifies you; see [Troubleshooting](#troubleshooting).

With zero-downtime deployments, run the recipe once more after this first deploy so the service points at the site's `current` release.

### 9. Verify

From your own machine:

```bash
curl -sS https://signer.example.com/api/health
# {"ok":true,"product":"signer"}

# SMTP answers and offers STARTTLS with the right certificate (Microsoft 365 requires it):
openssl s_client -starttls smtp -connect signer.example.com:25 -servername signer.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -enddate
```

On the server (`ssh forge@<server IPv4>`):

```bash
systemctl status signer
journalctl -u signer -n 50          # look for the [signer] WARNING lines and "SMTP allowlist: N ranges"
systemctl list-timers 'signer-*'    # certificate sync and nightly backup
```

Then sign in at `https://signer.example.com` as `SUPER_ADMIN_EMAIL`, synchronise the directory (**Mail flow → Directory**), and build a signature before connecting mail flow.

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
7. Save the environment in Forge and redeploy, or run `sudo systemctl restart signer`. Sign in as `SUPER_ADMIN_EMAIL`, then **Mail flow → Directory → Synchronise**.

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
$signerIp  = "<server public IPv4>"          # printed by the recipe
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
2. **SMTP relay service**: allow Signer to hand mail back. Allowed senders **Only addresses in my domains**, require TLS, and IP allow list containing the server's **public IPv4** (the recipe prints it). Signer connects over IPv4 when it can.
3. **Compliance → Content compliance** (Outbound and Internal - sending): advanced content match on **Full headers**, `X-Signer-MessageProcessed` **does not contain** `true` → **Change route** to the Signer host, require secure transport.

**SPF and DKIM need no changes** for either provider. Signed mail goes back through Microsoft 365 or Google and reaches recipients from their servers, and they DKIM-sign it on the way out. Signer's own IP never appears as the sender to the outside world.

---

### Operations

**Deploying updates.** Push to `main` (with Quick deploy on) or press **Deploy now**. The deploy script rebuilds and restarts Signer, and fails loudly if it does not come back. Restarting drops SMTP connections in progress; Microsoft and Google retry them.

**Configuration changes.** Edit the site's Environment in Forge, then redeploy or run `sudo systemctl restart signer`. The recipe allows the `forge` user to run that without a password.

**Logs.** `journalctl -u signer -f`. The `forge` user can read them without sudo.

**Certificate renewals.** Forge renews the Let's Encrypt certificate for Nginx. `signer-cert-sync.timer` copies it to `/home/forge/signer-tls` once a day and restarts Signer when it changed, so SMTP STARTTLS never serves an expired certificate. To apply a renewal immediately: `sudo /usr/local/sbin/signer-sync-cert --restart-if-changed` (as root).

**Backups.** `signer-backup.timer` takes a consistent SQLite snapshot and archives the uploads every night into `/home/forge/signer-data/backups`, keeping 14 days. These copies are on the same disk, so also enable **Linode Backups** for the server, or copy that directory elsewhere. To restore: stop Signer (`sudo systemctl stop signer` as root), `gunzip` the chosen `signer-*.db.gz` over `/home/forge/signer-data/signer.db`, untar the matching `uploads-*.tgz` into `/home/forge/signer-data`, and start it again.

**Health**

| Check | Command / place |
| --- | --- |
| Portal | `curl -sS https://signer.example.com/api/health` |
| Service | `systemctl status signer`, `journalctl -u signer -n 100` |
| SMTP + TLS | `openssl s_client -starttls smtp -connect signer.example.com:25 </dev/null` |
| Outbound SMTP | Re-run the recipe; it tests `UPSTREAM_HOST:UPSTREAM_PORT` |
| Allowlist | `GET /api/settings` → `smtpAllowlist` |
| Loop header | Message trace in Microsoft 365 / Gmail shows `X-Signer-MessageProcessed: true` after a successful pass |
| Unsigned mail | `FAILURE_MODE=fail-open` delivers without a signature if processing throws; `fail-closed` returns SMTP 4xx so the tenant retries |

#### Troubleshooting

- **Deploy fails at the health check** → `journalctl -u signer -n 100`. Fatal configuration errors are printed as `[signer] FATAL:`: a missing `SESSION_SECRET`, a `TLS_CERT_PATH` that does not exist yet (issue the SSL certificate in Forge, then re-run the recipe), a numeric `TRUST_PROXY`, or an `SMTP_ALLOWED_CIDRS` provider that cannot be resolved with nothing cached (see [Provider IP ranges](#provider-ip-ranges)).
- **`SMTP port 25 unavailable (EACCES)`** → Signer was started outside `signer.service`, so it lacks the capability to bind low ports. Start it with `systemctl` only.
- **`SMTP port 25 unavailable (EADDRINUSE)`** → another mail server holds the port. `ss -ltnp 'sport = :25'`, stop it, re-run the recipe.
- **Microsoft 365 queues mail with a TLS error (`4.4.317`)** → STARTTLS is not offered or the certificate does not match `signer.example.com`. Check `TLS_CERT_PATH`, `SMTP_HOSTNAME`, and the `openssl s_client` output above.
- **`550 5.7.64 TenantAttribution; Relay Access Denied`** → the return connector is not an `OnPremises` connector, is disabled, or does not list this server's IPv4. See [Connect Microsoft 365](#connect-microsoft-365).
- **Mail accepted by Signer, never arrives** → outbound SMTP is still blocked (re-run the recipe to check) or `UPSTREAM_*` is wrong.
- **Relay fails with a certificate error** → upstream TLS is verified by default. Against a real `mail.protection.outlook.com` or `smtp-relay.gmail.com` host, this means the hostname is wrong. Only set `UPSTREAM_TLS_REJECT_UNAUTHORIZED=false` for a lab host with a self-signed certificate: it lets anyone on the network path read and alter the mail.
- **Exchange or Gmail cannot connect at all** → if `SMTP_ALLOWED_CIDRS` is set, the connecting host is outside it. `GET /api/settings` shows what the allowlist resolved to. If a Linode Cloud Firewall is attached, it must allow 25 and 587 as well.
- **OIDC redirect mismatch** → `PUBLIC_URL` and the Entra/Google redirect URI must match exactly (`https://host`, no trailing slash in `PUBLIC_URL`).
- **Super admin cannot sign in** → the mailbox must match `SUPER_ADMIN_EMAIL` (case-insensitive).
- **Connector loop** → the transport rule or content compliance rule must skip mail whose processed header is `true`.
- **Empty signature fields** → run directory sync. Users only exist in the cache after an Entra/Google sync (or the demo seed).
- **Logo upload rejected with 415** → only PNG, JPEG, GIF and WEBP are accepted, judged by file contents, not extension. SVG is refused deliberately: email clients do not render it (see [Portal hardening](#portal-hardening)).
- **Sign-in returns 429** → the per-IP limit on sign-in routes. If everyone hits it together, the proxy's address is being counted instead of the client's: check that `TRUST_PROXY` names the proxy (`loopback` on Forge) and that Nginx sets `X-Forwarded-For` as in `deploy/forge/nginx.conf`.
- **A schedule fires at the wrong time** → set the timezone on the rule. Without one it follows the server's zone, which is UTC on a Forge server (see [Schedules and timezones](#schedules-and-timezones)).

### Without Forge (Docker)

`Dockerfile` and `docker-compose.yml` run the same thing in a container on any Linux host where outbound SMTP is allowed. The portal is published on `127.0.0.1:3000` for a reverse proxy on the host (`deploy/Caddyfile` for Caddy). SMTP is published on 587, plus 25 if you uncomment it. Data lives in the `signer-data` volume. You still need everything from steps 2–4 and 6 above, with `TLS_CERT_PATH` / `TLS_KEY_PATH` pointing at a certificate mounted into the container.

```bash
cp .env.example .env    # fill in as in step 6, minus the Forge paths
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
- **Analytics** — counts and metadata; message bodies are not stored

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
| `DATA_DIR` | `./data` | Database, uploads and IP range cache. Keep it outside the checkout (`/home/forge/signer-data` on Forge) |
| `HTTP_HOST` / `HTTP_PORT` | `0.0.0.0` / `3000` | `127.0.0.1` when a proxy on the same machine fronts the portal (Forge) |
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
| `FAILURE_MODE` | `fail-open` | `fail-open` delivers unsigned if processing throws; `fail-closed` defers with 4xx |
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
