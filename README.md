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

Always-on **inbound SMTP** does not fit Cloud Run, Cloud Functions, or Azure Functions well. Those products either cannot accept SMTP, idle to zero, or time out long mail connections. The cheap, reliable shape is **one small always-on VM running Docker**.

| Cloud | Recommended SKU | Typical list price | Script |
| --- | --- | --- | --- |
| **Azure** | `Standard_B2als_v2` (4 GiB; fallback `Standard_B2s`). `Standard_B2ats_v2` is cheaper but only **1 GiB** — too tight for Docker + Caddy + Node | about US$8–15/month | `deploy/azure/create-vm.sh` |
| **Google Cloud** | `e2-small` (2 GiB; lab: `e2-micro`) Ubuntu 22.04 | similar range | `deploy/gcp/create-vm.sh` |

You will end up with:

- **HTTPS portal** on `https://signer.example.com` (Caddy or nginx in front of container port 3000)
- **SMTP gateway** on **587** (and **25** if the host can bind it)
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

### Port 25 (read this once)

Azure and Google Cloud **commonly block outbound TCP 25** so VMs cannot spam. Inbound 25 is a separate issue (NSG / VPC firewall plus whether the process may bind port 25).

| Direction | What it is | What usually works |
| --- | --- | --- |
| **Inbound** Microsoft 365 → Signer | Exchange Online outbound/partner connectors deliver to a smart host on **port 25** | Open NSG/VPC **25** (and **587**). Map `25:25` in Compose if you need M365. Restrict source IPs when you can. |
| **Inbound** Google → Signer | Content compliance “change route” uses the **host route port you set** | Set the host route to **587** if you would rather not expose 25. |
| **Outbound** Signer → Microsoft MX | `*.mail.protection.outlook.com:25` | Often blocked. Request an **SMTP exemption** (Azure) or use a path your subscription allows. |
| **Outbound** Signer → Google | `smtp-relay.gmail.com:587` | Works without port 25. Prefer this for Workspace. |

If outbound 25 stays blocked, signed Microsoft 365 mail cannot be handed back to MX until the exemption (or another allowed relay) is in place. Set `UPSTREAM_HOST` / `UPSTREAM_PORT` to whatever path you actually have.

### Compatible regions and zones

SMTP **port policy is not per-zone**. Picking a different Azure availability zone or GCP zone will not unblock outbound TCP 25. What *does* vary by location is VM SKU availability, restricted-access regions, and a handful of GCP zones that do not offer E2.

**What the VM must be able to do (every commercial region below):**

| Need | Azure | Google Cloud |
| --- | --- | --- |
| Always-on Linux VM + public IPv4 | Yes (not Functions / Container Apps / Cloud Run) | Yes (not Cloud Run) |
| Inbound TCP 25, 80, 443, 587 | Allowed by the platform; you open the NSG | Allowed by the platform; you open VPC firewall |
| Outbound TCP 443 | Let's Encrypt, Docker Hub, Entra / Google APIs | Same |
| Outbound TCP 587 / 465 | Not blocked (Workspace SMTP relay, other authenticated relays) | [Not blocked](https://cloud.google.com/compute/docs/tutorials/sending-mail) |
| Outbound TCP 25 to `*.mail.protection.outlook.com` | **Subscription**, not region: allowed on standard [EA / MCA-E](https://learn.microsoft.com/troubleshoot/azure/virtual-network/troubleshoot-outbound-smtp-connectivity); blocked (and not exemptable) on PAYG, CSP, Free, Sponsorship, MSDN | **Project**, not zone: blocked to external IPs by default in every region. Do not plan a Microsoft 365 return path on 25 from GCE unless the VPC networks page already shows SMTP egress allowed |

**Do not provision here** (access denied, missing SKU, or the commercial portal/OIDC path is a different cloud):

| Skip | Why |
| --- | --- |
| Azure restricted DR regions: `australiacentral2`, `brazilsoutheast`, `francesouth`, `germanynorth`, `jioindiacentral`, `jioindiawest`, `norwaywest`, `southafricawest`, `switzerlandwest`, `uaecentral` | Subscription often cannot create VMs until Microsoft grants access |
| Azure `denmarkeast`, `indiasouthcentral` | New / limited; Basv2 / `B2s` not in the public retail SKU list |
| Azure US Government / Azure China | Different identity and ACME endpoints than this commercial deploy |
| GCP `asia-southeast3-a/b/c` (Bangkok) | [No E2 machine types](https://cloud.google.com/compute/docs/regions-zones) (N4/C4 only) |
| GCP AI zones (`…-ai…`) | GPU/TPU slices, not a general SMTP VM |
| GCP zone letters that do not exist: `europe-west1-a`, `us-east1-a` | Those regions start at `b` (`europe-west1-b/c/d`, `us-east1-b/c/d`). `us-central1` has `a/b/c/f` (no `d`) |

**Metros where both clouds can host Signer** (generally-available Azure region with Basv2/`B2s`, plus a GCP region whose listed zones include E2). Prefer a location close to the Microsoft 365 / Workspace tenant.

| Metro | Azure `LOCATION` | GCP `REGION` | GCP zones with E2 |
| --- | --- | --- | --- |
| Northern Virginia | `eastus` or `eastus2` | `us-east4` | `us-east4-a`, `b`, `c` |
| Iowa | `centralus` | `us-central1` | `us-central1-a`, `b`, `c`, `f` |
| Texas | `southcentralus` | `us-south1` | `us-south1-a`, `b`, `c` |
| Illinois | `northcentralus` | (use `us-central1` or `us-east5`) | `us-east5-a`, `b`, `c` (Ohio) |
| Washington state | `westus2` | `us-west1` (Oregon) | `us-west1-a`, `b`, `c` |
| California | `westus` | `us-west2` | `us-west2-a`, `b`, `c` |
| Phoenix / Las Vegas | `westus3` | `us-west4` | `us-west4-a`, `b`, `c` |
| Toronto | `canadacentral` | `northamerica-northeast2` | `…-a`, `b`, `c` |
| Montréal / Québec | `canadaeast` | `northamerica-northeast1` | `…-a`, `b`, `c` |
| São Paulo | `brazilsouth` | `southamerica-east1` | `…-a`, `b`, `c` |
| Santiago | `chilecentral` | `southamerica-west1` | `…-a`, `b`, `c` |
| Querétaro | `mexicocentral` | `northamerica-south1` | `…-a`, `b`, `c` |
| London | `uksouth` | `europe-west2` | `europe-west2-a`, `b`, `c` |
| Netherlands | `westeurope` | `europe-west4` | `europe-west4-a`, `b`, `c` |
| Belgium | `belgiumcentral` | `europe-west1` | `europe-west1-b`, `c`, `d` (no `a`) |
| Ireland (Azure) / Belgium (GCP) | `northeurope` | `europe-west1` | `europe-west1-b`, `c`, `d` |
| Frankfurt | `germanywestcentral` | `europe-west3` | `europe-west3-a`, `b`, `c` |
| Paris | `francecentral` | `europe-west9` | `europe-west9-a`, `b`, `c` |
| Milan | `italynorth` | `europe-west8` | `europe-west8-a`, `b`, `c` |
| Madrid | `spaincentral` | `europe-southwest1` | `…-a`, `b`, `c` |
| Warsaw | `polandcentral` | `europe-central2` | `…-a`, `b`, `c` |
| Sweden | `swedencentral` | `europe-north2` | `…-a`, `b`, `c` |
| Zurich | `switzerlandnorth` | `europe-west6` | `europe-west6-a`, `b`, `c` |
| Tokyo | `japaneast` | `asia-northeast1` | `…-a`, `b`, `c` |
| Osaka | `japanwest` | `asia-northeast2` | `…-a`, `b`, `c` |
| Seoul | `koreacentral` | `asia-northeast3` | `…-a`, `b`, `c` |
| Mumbai | `westindia` or `centralindia` | `asia-south1` | `…-a`, `b`, `c` |
| Singapore | `southeastasia` | `asia-southeast1` | `…-a`, `b`, `c` |
| Hong Kong | `eastasia` | `asia-east2` | `…-a`, `b`, `c` |
| Jakarta | `indonesiacentral` | `asia-southeast2` | `…-a`, `b`, `c` |
| Sydney | `australiaeast` | `australia-southeast1` | `…-a`, `b`, `c` |
| Melbourne | `australiasoutheast` | `australia-southeast2` | `…-a`, `b`, `c` |
| Johannesburg | `southafricanorth` | `africa-south1` | `…-a`, `b`, `c` |
| Israel | `israelcentral` | `me-west1` | `me-west1-a`, `b`, `c` |
| Doha | `qatarcentral` | `me-central1` | `me-central1-a`, `b`, `c` |

Safe defaults used by the helper scripts: Azure `eastus`, GCP `us-central1-a`.

**Confirm on your subscription/project before you create the VM** (capacity and SKU restrictions are per-subscription; a region can list a size and still refuse yours):

```bash
# Azure: empty Restrictions column means you can place the size in that region (and which AZ 1/2/3).
az vm list-skus --location eastus --size Standard_B2als_v2 --all \
  --query "[?resourceType=='virtualMachines'].{name:name,zones:locationInfo[0].zones,restr:restrictions}" -o json

# GCP: fails fast if the zone has no e2-small.
gcloud compute machine-types describe e2-small --zone us-central1-a --format='get(name,zone)'
```

Azure availability zones (`1`/`2`/`3`) are optional for this single-VM design. If `list-skus` shows the size only in some zones, pass `--zone` to `az vm create`. Do not pick a restricted DR region hoping the SKU exists there.

---

### Azure

These steps create a B-series Ubuntu VM, a static public IP, Docker Compose, TLS, and the env file. You can run the helper script for the VM, then continue from **Install Docker**.

#### 1. Create the VM

```bash
az login
az account set --subscription "<subscription-id>"

export RESOURCE_GROUP=signer-rg
export LOCATION=eastus          # must be a generally-available region from "Compatible regions and zones"
export VM_NAME=signer

# Optional helper (creates the group, VM, and opens 22/25/80/443/587/3000):
./deploy/azure/create-vm.sh
```

Manual equivalent if you skip the script:

```bash
az group create -n "$RESOURCE_GROUP" -l "$LOCATION"

az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
  --size Standard_B2als_v2 \
  --public-ip-sku Standard \
  --nsg-rule SSH \
  --admin-username azureuser \
  --generate-ssh-keys

for port in 80 443 25 587 3000; do
  az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
    --port "$port" --priority $((1100 + port / 10))
done
```

If `Standard_B2als_v2` is unavailable in the region, use `--size Standard_B2s`. Do not use a restricted DR region (see the table above).

#### 2. Make the public IP static and note it

```bash
IP_NAME=$(az vm list-ip-addresses -g "$RESOURCE_GROUP" -n "$VM_NAME" \
  --query "[0].virtualMachine.network.publicIpAddresses[0].name" -o tsv)

az network public-ip update -g "$RESOURCE_GROUP" -n "$IP_NAME" --allocation-method Static

az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv
```

Create a DNS **A record**: `signer.example.com` → that IPv4 address. Wait until it resolves before requesting TLS certificates.

#### 3. Tighten the network security group (recommended)

Leave SSH (22) open to your admin IPs only. For SMTP, prefer Microsoft’s published [Office 365 IP ranges](https://learn.microsoft.com/microsoft-365/enterprise/urls-and-ip-address-ranges) (service `Exchange Online`, TCP 25/587) instead of `0.0.0.0/0`. HTTPS 80/443 can stay world-open for the portal and Let’s Encrypt.

Also set `SMTP_ALLOWED_CIDRS` in `.env` to the same ranges once you know them (comma-separated CIDRs). Empty means the SMTP banner accepts everyone — lab only.

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
# Exchange Online delivers to smart hosts on 25. Uncomment 25:25 in docker-compose.yml.

# After signing, hand mail back to your tenant MX (needs outbound 25 or an exemption):
UPSTREAM_HOST=yourtenant-com.mail.protection.outlook.com
UPSTREAM_PORT=25
UPSTREAM_SECURE=false

ENTRA_TENANT_ID=<directory / tenant ID>
ENTRA_CLIENT_ID=<app registration id>
ENTRA_CLIENT_SECRET=<app secret>

DEMO_MODE=false
AUTH_ALLOW_DEV_LOGIN=false
FAILURE_MODE=fail-open
```

Find `UPSTREAM_HOST` in Microsoft 365 admin → Settings → Domains → the domain → **MX** record (`<token>.mail.protection.outlook.com`).

If Azure still blocks outbound 25 after you request an exemption, mail cannot return to MX until that is granted. Do not point `UPSTREAM_HOST` at a random open relay.

#### 6. Publish port 25 if Exchange Online will send to this host

In `docker-compose.yml`, uncomment:

```yaml
- "25:25"
```

The process binds 25 as root inside the container (see the Dockerfile). Restrict who can reach it with the NSG and `SMTP_ALLOWED_CIDRS`.

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

Caddy listens on 80/443, obtains a Let’s Encrypt certificate, and reverse-proxies to `127.0.0.1:3000`. SMTP stays on 25/587 on Docker, not through Caddy.

Optional: put `TLS_CERT_PATH` / `TLS_KEY_PATH` in `.env` if you also want STARTTLS on the SMTP listeners (copy the live Caddy certs, or use a separate certificate whose CN/SAN matches `SMTP_HOSTNAME`). Exchange partner receive connectors expect the name on **your** certificate when Signer talks **back** to Microsoft; that is `UPSTREAM_TLS_SERVERNAME` / the inbound connector `TlsSenderCertificateName`.

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
export ZONE=us-central1-a       # E2 zone from "Compatible regions and zones"; not europe-west1-a / us-east1-a
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
SMTP_PORT=25
SMTP_SUBMISSION_PORT=587

# Return path — do not rely on outbound 25:
UPSTREAM_HOST=smtp-relay.gmail.com
UPSTREAM_PORT=587
UPSTREAM_SECURE=false
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

If the content-compliance route targets port 587, you do not need host port 25. If you set the host route to 25, uncomment `25:25` in `docker-compose.yml`.

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
$smartHost = "signer.example.com"   # SMTP_HOSTNAME; Exchange Online uses port 25
$header    = "X-Signer-MessageProcessed"

New-OutboundConnector -Name "Signer send" -ConnectorType Partner -UseMXRecord $false `
  -SmartHosts $smartHost -TlsSettings EncryptionOnly -Enabled $true `
  -IsTransportRuleScoped $true

New-InboundConnector -Name "Signer receive" -ConnectorType Partner -SenderDomains * `
  -RequireTls $true -RestrictDomainsToCertificate $true `
  -TlsSenderCertificateName $smartHost

New-TransportRule -Name "Identify messages to send to Signer" `
  -FromScope InOrganization `
  -ExceptIfHeaderContainsMessageHeader $header `
  -ExceptIfHeaderContainsWords "true" `
  -RouteMessageOutboundConnector "Signer send"
```

Notes:

- Scope the outbound connector with the transport rule so **only** in-org mail that lacks the processed header is diverted. That prevents loops.
- The inbound connector accepts mail **from Signer back into** the tenant. The certificate name must match what Signer presents (`SMTP_HOSTNAME` / `UPSTREAM_TLS_SERVERNAME`).
- After this, send a test to an external recipient and watch **Activity** in Signer and `docker compose logs`.

### Connect Google Workspace

In [admin.google.com](https://admin.google.com) → Apps → Google Workspace → Gmail → **Routing** / **Compliance**:

1. **Hosts**: add `signer.example.com` port **587** (or 25 if you published it), require TLS.
2. **SMTP relay service**: allow Signer to return mail. Restrict to **Only addresses in my domains**, require TLS, and allow-list this VM’s **public IP**.
3. **Content compliance** (outbound and internal sending): advanced content match on **full headers**, header `X-Signer-MessageProcessed` **does not contain** `true` → action **Change route** to the Signer host, require TLS.

SPF: include this VM’s sending IP (or `smtp-relay.gmail.com` if that is the return path) on every domain that sends through Signer. DKIM stays on Google/Microsoft; you are not replacing their outbound reputation, only inserting HTML on the way through.

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
| SMTP banner | `nc -vz signer.example.com 587` (and 25 if mapped) |
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

See `.env.example`. Important keys: `PUBLIC_URL`, `SUPER_ADMIN_EMAIL`, `SESSION_SECRET`, `SMTP_*`, `UPSTREAM_*`, `PROCESSED_HEADER`, `FAILURE_MODE` (`fail-open` delivers unsigned mail if processing throws; `fail-closed` defers with 4xx).
