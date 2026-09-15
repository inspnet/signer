# Signer

Self-hosted **server-side** email signatures and legal disclaimers for Microsoft 365 and Google Workspace.

Signatures are applied in the mail flow **after** the user clicks Send. That is the same model Exclaimer Cloud uses with Exchange connectors — not a Graph/Gmail API push into the user's mailbox (which iOS Mail and other clients can ignore or overwrite).

Mail is processed on **your** Azure or Google Cloud host and returned to Microsoft 365 or Google. It does not pass through a vendor SaaS.

## Why connectors instead of mailbox APIs

| Approach | Consistent on iOS Mail? | User can remove it? | Where mail goes |
| --- | --- | --- | --- |
| Push signature via Microsoft Graph / Gmail API (e.g. client-side tools) | No | Yes | Stays in tenant, but not enforced |
| Exchange transport disclaimer text | Partially | No | Stays in Microsoft 365, very limited design |
| **This product: SMTP gateway + connectors** | Yes | No | Your VM/container in Azure or GCP, then back to M365/Google |

Exclaimer's own server-side path is: mailbox → Send connector → processor → Receive connector → original recipients, with `X-ExclaimerHostedSignatures-MessageProcessed: true` to stop loops. Signer does the same with `X-Signer-MessageProcessed: true` (configurable).

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

## Deploy (lowest cost)

Always-on **inbound SMTP** does not fit Cloud Run / Azure Functions well. The cheap, reliable shape is **one small VM + Docker**:

- **Azure:** `Standard_B2ats_v2` (or B2s) Ubuntu VM, ~US$8–15/month. Script: `deploy/azure/create-vm.sh`.
- **GCP:** `e2-small` Compute Engine, similar range. Script: `deploy/gcp/create-vm.sh`.

Put Caddy or nginx in front of port 3000 for HTTPS. Point Exchange at `smtp.yourdomain.com:587` if you cannot bind port 25.

Azure and GCP often **block outbound TCP 25**. Mitigations:

1. Exchange **send** connector to Signer on **587**.
2. Return path: Google `smtp-relay.gmail.com:587`; Microsoft MX on 25 (request an SMTP exemption) or a TLS partner receive connector.
3. Set `UPSTREAM_HOST` / `UPSTREAM_PORT` accordingly.

```bash
cp .env.example .env
# set PUBLIC_URL, SUPER_ADMIN_EMAIL, SESSION_SECRET, Entra and/or Google
docker compose up -d --build
```

Single image:

```bash
docker build -t signer:local .
docker run --rm -p 3000:3000 -p 587:587 -p 2525:2525 \
  --env-file .env -v signer-data:/data signer:local
```

## Identity

- `SUPER_ADMIN_EMAIL` is the break-glass owner. That mailbox must sign in via Entra or Google.
- **Entra:** App registration, redirect `https://<host>/api/auth/entra/callback`, delegated `openid profile email`. For directory sync, application permissions `User.Read.All`, `Group.Read.All`, `GroupMember.Read.All` with admin consent (same app or `ENTRA_DIRECTORY_*`).
- **Google:** OAuth client, redirect `https://<host>/api/auth/google/callback`. Directory sync uses a service account JSON + domain-wide delegation to `GOOGLE_ADMIN_EMAIL` with `admin.directory.user.readonly` and `admin.directory.group.readonly`.

Lab only: `DEMO_MODE=true` and `AUTH_ALLOW_DEV_LOGIN=true` seeds sample users and a local super-admin button. Do not enable this on a host that receives real mail.

## Mail flow (admin UI)

Sign in → **Mail flow & settings** for generated Exchange PowerShell and Google Admin steps (host, SMTP relay, content compliance). SPF must include this host's sending IP.

## Product surface (from Exclaimer-style operations)

- **Signatures** — create, folders, evaluation order, block designer, HTML fields from the directory
- **Rules** — senders, exceptions, groups/domains, internal vs external recipients, date/time, reply/thread advanced rules
- **Disclaimers** — separate legal notices (e.g. external-only confidentiality)
- **Campaigns** — banner images with the same rule engine
- **Signatures Tester** — dry-run with per-rule pass/fail (does not send mail)
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

## Configuration reference

See `.env.example`. Important keys: `PUBLIC_URL`, `SUPER_ADMIN_EMAIL`, `SESSION_SECRET`, `SMTP_*`, `UPSTREAM_*`, `PROCESSED_HEADER`, `FAILURE_MODE` (`fail-open` delivers unsigned mail if processing throws; `fail-closed` defers with 4xx).
