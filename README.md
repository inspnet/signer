# Signer

Self-hosted **server-side** email signatures and legal disclaimers for Microsoft 365 and Google Workspace.

Signatures are applied in the mail flow **after** the user clicks Send — not by pushing HTML into the user's mailbox with Graph or the Gmail API, which iOS Mail and other clients can ignore or overwrite.

Mail is processed on **your** Azure or Google Cloud host and returned to Microsoft 365 or Google. It does not pass through a vendor SaaS.

## Why connectors instead of mailbox APIs

| Approach | Consistent on iOS Mail? | User can remove it? | Where mail goes |
| --- | --- | --- | --- |
| Push signature via Microsoft Graph / Gmail API (e.g. client-side tools) | No | Yes | Stays in tenant, but not enforced |
| Exchange transport disclaimer text | Partially | No | Stays in Microsoft 365, very limited design |
| **This product: SMTP gateway + connectors** | Yes | No | Your VM/container in Azure or GCP, then back to M365/Google |

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
Signer SMTP (your Docker host)
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

The HTTPS portal (admin designer, rules, tester, user details editor) is the same container.

## Mail path, TLS, and who may connect

Confirmed path:

1. User sends from Outlook / Gmail / iOS (mail is still **inside** Microsoft 365 or Google Workspace).
2. A transport rule / content-compliance policy **diverts only in-org mail** to Signer over TLS.
3. Signer inserts the signature and stamps `X-Signer-MessageProcessed: true`.
4. Signer **returns the message to the same tenant** (Exchange inbound connector or Google SMTP relay) — it does not deliver to the public internet.
5. Microsoft / Google then send to the real recipients (and apply DKIM on that final hop).

Nothing in this product is an open SMTP relay.

### How inbound mail is authenticated (not the open internet)

Exchange Online **cannot SMTP-AUTH** to a smart host and does **not** present a customer-pinned client certificate on that hop. Google content-compliance routes are the same: TLS to a named host, not a username.

So tenant-only inbound is **layered**, not a single password:

| Layer | What it proves | Required |
| --- | --- | --- |
| Cloud firewall / NSG | SYN packets only from Microsoft or Google mail infrastructure | Yes. Never `0.0.0.0/0` on SMTP. Azure: source service tag `Office365`. Google: [mail server IP ranges](https://support.google.com/a/answer/60764). |
| `SMTP_ALLOWED_CIDRS` | Signer rejects `MAIL FROM` from any other IP even if the NSG is wrong | Yes in production |
| `SMTP_REQUIRE_TLS=true` + `TLS_CERT_PATH` | No plaintext SMTP. Session must STARTTLS | Yes in production |
| Outbound connector `TlsSettings DomainValidation` + `TlsDomain` | **Microsoft verifies Signer’s server certificate** (public CA, SAN = `SMTP_HOSTNAME`) | Yes for M365 |
| Inbound connector `RequireTls` + `RestrictDomainsToCertificate` + `TlsSenderCertificateName` | **Microsoft verifies Signer on the way back** (this *is* certificate auth) | Yes for M365 |
| Google SMTP relay allow-list + require TLS | Only this VM’s IP may inject mail back into Workspace | Yes for Google |

SMTP AUTH (`UPSTREAM_USER` / `UPSTREAM_PASS`) is optional extra on the **return** path to Google’s relay. It is not available for Exchange Online outbound connectors.

**Client certificates (mTLS) from Microsoft → Signer** are not a useful control here: Exchange Online will not send you a unique client cert you can pin. Domain validation of **your** certificate (both directions) is the Microsoft-documented pattern for an in-tenant signature add-on.

Signer refuses `MAIL FROM` unless STARTTLS already completed (`SMTP_REQUIRE_TLS`, on by default outside demo mode). Empty `SMTP_ALLOWED_CIDRS` in production logs a warning; treat that as misconfiguration.

### TLS vs port 25

All sessions must be TLS (STARTTLS). We do **not** run an unencrypted listener as the production path.

| Hop | Port | Encryption |
| --- | --- | --- |
| Google Workspace → Signer | **587** (you choose this on the host route) | STARTTLS, required |
| Signer → Google `smtp-relay.gmail.com` | **587** | STARTTLS, required |
| Exchange Online → Signer | **TCP 25 + STARTTLS** | Encrypted. Exchange Online outbound/smart-host connectors **cannot use 587** — that is a Microsoft MTA limitation, not a Signer setting. |
| Signer → `*.mail.protection.outlook.com` | **TCP 25 + STARTTLS** | Encrypted. Microsoft MX does not accept 587. Azure/GCP often block *outbound* 25; request an SMTP exemption for this VM. |

Production defaults: listen on **587 only** (`SMTP_PORT=0`). For Microsoft 365, also bind 25 (`SMTP_PORT=25` and uncomment `25:25` in Compose) **and** allow it solely from the `Office365` NSG tag / Exchange Online ranges. That is not “SMTP open to the internet.”

### Will DKIM survive?

**Yes, on the final send**, if you keep the path above.

- DKIM is a body hash. If Signer changed the HTML **after** a signature was already applied, that DKIM would fail.
- Diversion happens **before** the tenant’s internet send. After Signer returns the message, Exchange / Google DKIM-sign the **modified** body on the way to recipients.
- Use `CloudServicesMailEnabled $true` on both Microsoft connectors so internal headers stay trusted (Microsoft’s add-on-service pattern).
- Signer **strips** `DKIM-Signature`, ARC, and `Authentication-Results` from the diverted copy so a stale fail is not left on the rewritten MIME.

SPF/DMARC at the recipient see Microsoft or Google as the sending IP (the second hop), not Signer, which is what you want. Do not send from Signer straight to the public MX of the recipient.

---

## Deploy

Always-on **inbound SMTP** does not fit Cloud Run, Cloud Functions, or Azure Functions well. Those products either cannot accept SMTP, idle to zero, or time out long mail connections. The cheap, reliable shape is **one small always-on VM running Docker**.

| Cloud | Recommended SKU | Typical list price | Script |
| --- | --- | --- | --- |
| **Azure** | `Standard_B2ats_v2` (fallback `Standard_B2s`) Ubuntu 22.04 | about US$8–15/month | `deploy/azure/create-vm.sh` |
| **Google Cloud** | `e2-small` (lab: `e2-micro`) Ubuntu 22.04 | similar range | `deploy/gcp/create-vm.sh` |

You will end up with:

- **HTTPS portal** on `https://signer.example.com` (Caddy in front of container port 3000)
- **SMTP gateway** on **587** with required STARTTLS (and TCP 25 **only** from Exchange Online, STARTTLS, if you use Microsoft 365)
- **SQLite + uploads** on a Docker volume (`/data`)
- Mail returned to **your** Microsoft 365 tenant or Google Workspace, not a third-party SaaS

### Before you start

Have these ready:

1. A DNS name you control, for example `signer.example.com`.
2. Cloud CLI: [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) **or** [gcloud](https://cloud.google.com/sdk/docs/install), authenticated as someone who can create VMs and firewall rules.
3. The mailbox that will be break-glass owner (`SUPER_ADMIN_EMAIL`). That person must be able to sign in with Entra ID or Google.
4. Admin access to Microsoft 365 (Exchange Online) **or** Google Workspace Admin, depending on where mail lives.
5. A 32+ character session secret: `openssl rand -base64 48`.

Do **not** set `DEMO_MODE=true` or `AUTH_ALLOW_DEV_LOGIN=true` on a host that receives real mail.

The TLS / DKIM / IP-allowlist model is in [Mail path, TLS, and who may connect](#mail-path-tls-and-who-may-connect). Do not skip `SMTP_REQUIRE_TLS`, `TLS_CERT_*`, or `SMTP_ALLOWED_CIDRS` in production.

---

### Azure

These steps create a B-series Ubuntu VM, a static public IP, Docker Compose, TLS, and the env file. You can run the helper script for the VM, then continue from **Install Docker**.

#### 1. Create the VM

```bash
az login
az account set --subscription "<subscription-id>"

export RESOURCE_GROUP=signer-rg
export LOCATION=eastus          # pick a region close to your tenant
export VM_NAME=signer

# Optional helper (HTTPS 80/443, SMTP 587, TCP 25 only from Office365 service tag):
./deploy/azure/create-vm.sh
```

Manual equivalent if you skip the script:

```bash
az group create -n "$RESOURCE_GROUP" -l "$LOCATION"

az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
  --size Standard_B2ats_v2 \
  --public-ip-sku Standard \
  --nsg-rule SSH \
  --admin-username azureuser \
  --generate-ssh-keys

for port in 80 443 587; do
  az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
    --port "$port" --priority $((1100 + port / 10))
done
```

If `Standard_B2ats_v2` is unavailable in the region, use `--size Standard_B2s`.

#### 2. Make the public IP static and note it

```bash
IP_NAME=$(az vm list-ip-addresses -g "$RESOURCE_GROUP" -n "$VM_NAME" \
  --query "[0].virtualMachine.network.publicIpAddresses[0].name" -o tsv)

az network public-ip update -g "$RESOURCE_GROUP" -n "$IP_NAME" --allocation-method Static

az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv
```

Create a DNS **A record**: `signer.example.com` → that IPv4 address. Wait until it resolves before requesting TLS certificates.

#### 3. Tighten the network security group (required for SMTP)

Leave SSH (22) open to your admin IPs only. HTTPS 80/443 can stay world-open for the portal and Let’s Encrypt.

Do **not** use `az vm open-port --port 25` (that is `Internet`). For Exchange Online STARTTLS, allow TCP 25 **and** 587 only from the `Office365` service tag:

```bash
NSG=$(az network nsg list -g "$RESOURCE_GROUP" --query "[?contains(name, '$VM_NAME')].name | [0]" -o tsv)
az network nsg rule create -g "$RESOURCE_GROUP" --nsg-name "$NSG" \
  --name allow-exchange-online-smtp --priority 1103 --direction Inbound --access Allow \
  --protocol Tcp --source-address-prefixes Office365 --destination-port-ranges 25 587
```

Also set `SMTP_ALLOWED_CIDRS` to [Exchange Online IP ranges](https://learn.microsoft.com/microsoft-365/enterprise/urls-and-ip-address-ranges). Empty CIDRs means the process will accept any peer that reached the port.

#### 4. SSH in and install Docker

```bash
ssh azureuser@"$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv)"

sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker azureuser
```

Log out and back in so the `docker` group applies.

#### 5. Clone Signer and create `.env`

```bash
git clone https://github.com/inspnet/signer.git
cd signer
cp .env.example .env
nano .env
```

Minimum production values for Microsoft 365:

```bash
PUBLIC_URL=https://signer.example.com
SUPER_ADMIN_EMAIL=it-admin@yourtenant.com
SESSION_SECRET=<openssl rand -base64 48>
SMTP_HOSTNAME=signer.example.com
SMTP_PORT=25
SMTP_SUBMISSION_PORT=587
SMTP_REQUIRE_TLS=true
SMTP_ALLOWED_CIDRS=
TLS_CERT_PATH=/etc/caddy/signer.crt
TLS_KEY_PATH=/etc/caddy/signer.key
# Map 25:25 in docker-compose.yml. NSG source must be Office365, not Internet.

# Return to tenant MX (STARTTLS). Azure often blocks outbound 25 until you request an exemption:
UPSTREAM_HOST=yourtenant-com.mail.protection.outlook.com
UPSTREAM_PORT=25
UPSTREAM_SECURE=false
UPSTREAM_TLS_REJECT_UNAUTHORIZED=true
UPSTREAM_TLS_SERVERNAME=signer.example.com

ENTRA_TENANT_ID=<directory / tenant ID>
ENTRA_CLIENT_ID=<app registration id>
ENTRA_CLIENT_SECRET=<app secret>

DEMO_MODE=false
AUTH_ALLOW_DEV_LOGIN=false
FAILURE_MODE=fail-open
```

Find `UPSTREAM_HOST` in Microsoft 365 admin → Settings → Domains → the domain → **MX** record (`<token>.mail.protection.outlook.com`).

If Azure still blocks outbound 25 after you request an exemption, mail cannot return to MX until that is granted. Do not point `UPSTREAM_HOST` at a random open relay.

#### 6. Publish STARTTLS on TCP 25 for Exchange Online only

Microsoft’s MTA smart-hosts on **TCP 25 with STARTTLS** (not 587). In `docker-compose.yml` uncomment `- "25:25"`. Keep `SMTP_REQUIRE_TLS=true`. Do not allow Internet on that NSG rule.

Copy the Let’s Encrypt leaf+key (or a dedicated SMTP cert whose SAN is `SMTP_HOSTNAME`) to `TLS_CERT_PATH` / `TLS_KEY_PATH`. Caddy can obtain the cert; SMTP does not go through Caddy.

#### 7. TLS for the portal (Caddy on the host)

Install Caddy and use `deploy/Caddyfile`:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# edit the site name to signer.example.com
sudo systemctl enable --now caddy
```

Caddy listens on 80/443, obtains a Let’s Encrypt certificate, and reverse-proxies to `127.0.0.1:3000`. SMTP STARTTLS uses `TLS_CERT_PATH` / `TLS_KEY_PATH` (same hostname as `SMTP_HOSTNAME`). The inbound Exchange connector matches that name (`TlsSenderCertificateName`).

#### 8. Start the app

```bash
docker compose up -d --build
docker compose logs -f --tail=80
```

Confirm:

```bash
curl -sS https://signer.example.com/api/health
# {"ok":true,"product":"signer"}
```

Open `https://signer.example.com`, sign in as `SUPER_ADMIN_EMAIL` with Microsoft, then use **Mail flow** in the portal for tenant-specific PowerShell (the same commands are in [Connect Microsoft 365](#connect-microsoft-365) below).

#### 9. Azure SMTP exemption (usually required for M365 return path)

In Azure Portal: **Help + support** → New support request → issue type related to **SMTP / outbound port 25** for the VM’s subscription. Until that is approved, test the portal and inbound connectors, but outbound to `mail.protection.outlook.com:25` may sit in a timeout.

#### 10. Azure — what not to use for SMTP

- **Azure Functions / Container Apps / App Service**: no durable inbound SMTP on 25/587 in the cheap tier; scale-to-zero drops mail.
- **Azure Communication Services Email**: a different product; Signer is an SMTP gateway in front of *your* tenant.

---

### Google Cloud

Same shape: one Compute Engine VM, Docker, Caddy, SMTP. Cloud Run cannot accept inbound SMTP.

#### 1. Create the VM and firewall

```bash
gcloud auth login
gcloud config set project "<project-id>"

export PROJECT=$(gcloud config get-value project)
export ZONE=us-central1-a
export NAME=signer
export REGION=${ZONE%-*}

# Optional helper (firewall tags + e2-small + Docker startup script):
./deploy/gcp/create-vm.sh
```

Manual equivalent:

```bash
gcloud compute firewall-rules create signer-mail \
  --allow tcp:22,tcp:25,tcp:80,tcp:443,tcp:587,tcp:3000 \
  --target-tags=signer \
  --description="Signer portal and SMTP"

gcloud compute addresses create signer-ip --region="$REGION"

gcloud compute instances create "$NAME" \
  --zone "$ZONE" \
  --machine-type e2-small \
  --tags signer \
  --image-family ubuntu-2204-lts \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 20GB \
  --address signer-ip \
  --metadata=startup-script='#!/bin/bash
apt-get update
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
usermod -aG docker $(getent passwd 1000 | cut -d: -f1) || true
'
```

```bash
gcloud compute addresses describe signer-ip --region="$REGION" --format='get(address)'
```

Create DNS **A record**: `signer.example.com` → that address.

Harden the firewall: clone `signer-mail` into separate rules, source-restrict SSH to your IPs, and source-restrict 25/587 to [Google Workspace mail server IPs](https://support.google.com/a/answer/60764) (or your content-compliance path) rather than `0.0.0.0/0`.

#### 2. SSH, clone, configure

```bash
gcloud compute ssh "$NAME" --zone "$ZONE"
# if Docker was installed by startup-script, you may need: sudo usermod -aG docker $USER && exec sg docker newgrp docker

git clone https://github.com/inspnet/signer.git
cd signer
cp .env.example .env
nano .env
```

Minimum production values for Google Workspace:

```bash
PUBLIC_URL=https://signer.example.com
SUPER_ADMIN_EMAIL=it-admin@yourdomain.com
SESSION_SECRET=<openssl rand -base64 48>
SMTP_HOSTNAME=signer.example.com
SMTP_PORT=0
SMTP_SUBMISSION_PORT=587
SMTP_REQUIRE_TLS=true
TLS_CERT_PATH=/etc/caddy/signer.crt
TLS_KEY_PATH=/etc/caddy/signer.key

# Return path — TLS on 587, never outbound 25:
UPSTREAM_HOST=smtp-relay.gmail.com
UPSTREAM_PORT=587
UPSTREAM_SECURE=false
UPSTREAM_TLS_REJECT_UNAUTHORIZED=true
# If the Workspace SMTP relay requires AUTH (allowed sender list + credentials):
# UPSTREAM_USER=
# UPSTREAM_PASS=

GOOGLE_CLIENT_ID=<oauth client id>
GOOGLE_CLIENT_SECRET=<oauth client secret>
# Directory sync (optional but needed for live names/titles):
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_ADMIN_EMAIL=admin@yourdomain.com

DEMO_MODE=false
AUTH_ALLOW_DEV_LOGIN=false
```

Install Caddy as in Azure step 7 (same `deploy/Caddyfile`), then:

```bash
docker compose up -d --build
curl -sS https://signer.example.com/api/health
```

Google content compliance should target **port 587**. Do not publish host port 25 on GCP.

#### 3. GCP outbound SMTP

Google Cloud **blocks outbound TCP 25** by default on most projects. Sending back through `smtp-relay.gmail.com:587` avoids that. Do not expect `UPSTREAM_PORT=25` to Microsoft MX to work from GCE without a special arrangement.

#### 4. GCP — what not to use for SMTP

- **Cloud Run / Cloud Functions**: no inbound SMTP.
- **GKE** for this product is optional later; a single VM is cheaper and easier to NSG.

---

### Identity (Entra or Google)

`SUPER_ADMIN_EMAIL` is the break-glass owner. That mailbox must sign in via Entra or Google. At least one provider must be configured in production.

#### Microsoft Entra ID

1. [Entra admin](https://entra.microsoft.com) → **App registrations** → New registration.
2. Name: `Signer`. Supported account types: **Accounts in this organizational directory only** (or multitenant if you host several directories).
3. Redirect URI (Web): `https://signer.example.com/api/auth/entra/callback`.
4. Certificates & secrets → new **client secret**. Put tenant ID, application (client) ID, and secret in `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`.
5. API permissions (delegated): `openid`, `profile`, `email`. Grant admin consent.
6. **Directory sync** (names, titles, groups): add **application** permissions `User.Read.All`, `Group.Read.All`, `GroupMember.Read.All`, admin consent. You can use the same app or a second app via `ENTRA_DIRECTORY_CLIENT_ID` / `ENTRA_DIRECTORY_CLIENT_SECRET`.
7. Restart: `docker compose up -d`. Sign in at `PUBLIC_URL` as `SUPER_ADMIN_EMAIL`. Then **Mail flow → Directory → Synchronise**.

#### Google Workspace

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (can be the same GCP project as the VM, or another) → **OAuth consent screen** → Internal.
2. **Credentials** → OAuth client ID → Web application. Authorized redirect: `https://signer.example.com/api/auth/google/callback`. Fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. Directory sync: create a **service account**, download JSON, put the **entire JSON** on one line in `GOOGLE_SERVICE_ACCOUNT_JSON` (or escape newlines). Enable [Admin SDK](https://console.cloud.google.com/apis/library/admin.googleapis.com).
4. In Workspace Admin → Security → Access and data control → API controls → **Domain-wide delegation**, add the service account client ID with scopes:
   - `https://www.googleapis.com/auth/admin.directory.user.readonly`
   - `https://www.googleapis.com/auth/admin.directory.group.readonly`
5. `GOOGLE_ADMIN_EMAIL` must be a super admin (or a delegated admin) the service account impersonates.
6. Restart Compose, sign in as `SUPER_ADMIN_EMAIL`, then synchronise directory from the portal.

---

### Connect Microsoft 365

Sign in to Signer → **Mail flow** for values filled from your `.env`. In Exchange Online PowerShell (`Connect-ExchangeOnline`):

```powershell
$smartHost = "signer.example.com"   # SAN on Signer's public certificate
$header    = "X-Signer-MessageProcessed"

New-OutboundConnector -Name "Signer send" -ConnectorType OnPremises `
  -IsTransportRuleScoped $true -UseMxRecord $false -SmartHosts $smartHost `
  -TlsSettings DomainValidation -TlsDomain $smartHost -CloudServicesMailEnabled $true

New-InboundConnector -Name "Signer receive" -ConnectorType OnPremises -SenderDomains * `
  -RequireTls $true -RestrictDomainsToCertificate $true `
  -TlsSenderCertificateName $smartHost -CloudServicesMailEnabled $true

New-TransportRule -Name "Identify messages to send to Signer" `
  -FromScope InOrganization `
  -ExceptIfHeaderContainsMessageHeader $header `
  -ExceptIfHeaderContainsWords "true" `
  -RouteMessageOutboundConnector "Signer send" `
  -StopRuleProcessing $true
```

Notes:

- Only in-org senders are diverted, and only when the processed header is missing — that is the loop brake.
- `DomainValidation` is how Exchange authenticates **Signer** on the way out. `TlsSenderCertificateName` is how Exchange authenticates **Signer** on the way back. Combined with an NSG sourced from `Office365`, the open internet cannot inject mail.
- `CloudServicesMailEnabled` keeps internal Exchange headers so the returned message is still trusted inside the tenant (needed for DKIM on the final send).
- After this, send a test to an external recipient and watch **Activity** in Signer and `docker compose logs`.

### Connect Google Workspace

In [admin.google.com](https://admin.google.com) → Apps → Google Workspace → Gmail → **Routing** / **Compliance**:

1. **Hosts**: add `signer.example.com` port **587**, require TLS. Do not use port 25.
2. **SMTP relay service**: allow Signer to return mail. Restrict to **Only addresses in my domains**, require TLS, and allow-list this VM’s **public IP**.
3. **Content compliance** (outbound and internal sending): advanced content match on **full headers**, header `X-Signer-MessageProcessed` **does not contain** `true` → action **Change route** to the Signer host, require TLS.

Recipients authenticate the message as Google Workspace mail (SPF of the relay / DKIM of the domain) because Signer returns the message **before** Gmail’s internet send. Tighten firewall sources on TCP 587 to [Google mail IP ranges](https://support.google.com/a/answer/60764) and set the same CIDRs in `SMTP_ALLOWED_CIDRS`.

---

### Upgrades, backups, troubleshooting

**Upgrade**

```bash
cd signer
git pull
docker compose up -d --build
```

SQLite lives in the `signer-data` volume and survives image rebuilds.

**Backup**

```bash
docker compose stop signer
docker run --rm -v signer_signer-data:/data -v "$PWD:/backup" busybox \
  tar czf /backup/signer-data.tgz /data
docker compose start signer
```

Copy `signer-data.tgz` off the VM. Restore by extracting into the same volume before `docker compose up`.

**Health**

| Check | Command / place |
| --- | --- |
| Portal | `curl -sS https://signer.example.com/api/health` |
| Container | `docker compose ps` and `docker compose logs -f` |
| SMTP banner | `openssl s_client -starttls smtp -connect signer.example.com:587` (cert SAN = `SMTP_HOSTNAME`) |
| Loop header | Message trace in M365 / Gmail shows `X-Signer-MessageProcessed: true` after a successful pass |
| Unsigned mail | `FAILURE_MODE=fail-open` delivers without a signature if processing throws; `fail-closed` returns SMTP 4xx so the tenant retries |

**Common failures**

- OIDC redirect mismatch → `PUBLIC_URL` and the Entra/Google redirect URI must be exact `https://host` (no trailing slash in `PUBLIC_URL`).
- Super admin cannot sign in → mailbox must match `SUPER_ADMIN_EMAIL` exactly (case-insensitive).
- Connector loop → transport rule / content compliance must skip when the processed header is `true`.
- Mail accepted by Signer, never arrives → outbound 25 blocked; confirm `UPSTREAM_*` and cloud SMTP policy.
- Empty signature fields → run directory sync; users only exist in the cache after Entra/Google sync (or demo seed).

---

## Product surface

- **Signatures** — create, folders, evaluation order, block designer, HTML fields from the directory
- **Rules** — senders, exceptions, groups/domains, internal vs external recipients, date/time, reply/thread advanced rules
- **Disclaimers** — separate legal notices (e.g. external-only confidentiality)
- **Campaigns** — banner images with the same rule engine
- **Rule tester** — dry-run with per-rule pass/fail (does not send mail)
- **User details** — employees edit only admin-unlocked fields
- **RBAC** — owner / admin / editor / designer / user
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

See `.env.example`. Important keys: `PUBLIC_URL`, `SUPER_ADMIN_EMAIL`, `SESSION_SECRET`, `SMTP_REQUIRE_TLS`, `SMTP_ALLOWED_CIDRS`, `TLS_CERT_PATH`, `UPSTREAM_*`, `PROCESSED_HEADER`, `FAILURE_MODE`.
