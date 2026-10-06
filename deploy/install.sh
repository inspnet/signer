#!/usr/bin/env bash
# Signer installer for a fresh Ubuntu 24.04 (or 22.04) server, e.g. a Linode.
#
# Log in as root (or a sudo user) and run:
#
#   curl -fsSL https://raw.githubusercontent.com/inspnet/signer/main/deploy/install.sh -o install.sh
#   sudo bash install.sh
#
# The first run asks a few questions and sets everything up: packages,
# Node.js, the Signer service, Nginx with a Let's Encrypt certificate, the
# firewall, nightly backups and log retention. Run it again at any time to
# update Signer to the latest code; later runs keep your configuration.
#
#   sudo bash /opt/signer/deploy/install.sh
#
# Answers can also be supplied as environment variables for an unattended
# first run: SIGNER_DOMAIN, SIGNER_ADMIN_EMAIL, SIGNER_PROVIDER (microsoft or
# google), SIGNER_UPSTREAM_HOST. SIGNER_BRANCH picks a branch (default main).
#
# Layout:
#   /opt/signer               the code (a git checkout; local edits are discarded on update)
#   /etc/signer/signer.env    configuration and secrets
#   /etc/signer/tls/          the certificate Signer uses for SMTP STARTTLS
#   /var/lib/signer/          database, uploads, IP range cache, backups/

set -euo pipefail

REPO_URL="${SIGNER_REPO:-https://github.com/inspnet/signer.git}"
BRANCH="${SIGNER_BRANCH:-main}"
APP_DIR=/opt/signer
DATA_DIR=/var/lib/signer
CONF_DIR=/etc/signer
ENV_FILE="$CONF_DIR/signer.env"
TLS_DIR="$CONF_DIR/tls"
NPM_CACHE=/var/cache/signer-npm
WEBROOT=/var/www/letsencrypt
SVC_USER=signer
NODE_MAJOR=22

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

have_tty() { (exec < /dev/tty) 2> /dev/null; }

# ask VAR "Question" [default] [secret]
ask() {
  local var="$1" prompt="$2" default="${3:-}" secret="${4:-}" value
  value="${!var:-}"
  [ -n "$value" ] && return 0
  if ! have_tty; then
    [ -n "$default" ] && { printf -v "$var" '%s' "$default"; return 0; }
    die "No terminal to ask for ${var}. Set it as an environment variable."
  fi
  if [ -n "$secret" ]; then
    read -r -s -p "    ${prompt}: " value < /dev/tty || true
    echo
  else
    read -r -p "    ${prompt}${default:+ [$default]}: " value < /dev/tty || true
  fi
  printf -v "$var" '%s' "${value:-$default}"
}

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

# Set KEY=VALUE in the env file: replace the KEY= line, else uncomment a
# "# KEY=" line, else append. Values pass through the environment, so slashes,
# ampersands and quotes in them are safe.
env_set() {
  local key="$1" value="$2" tmp mode=append
  if grep -q "^${key}=" "$ENV_FILE"; then
    mode=live
  elif grep -qE "^# ?${key}=" "$ENV_FILE"; then
    mode=commented
  fi
  tmp="$(mktemp)"
  KEY="$key" VALUE="$value" MODE="$mode" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; m = ENVIRON["MODE"]; done = 0 }
    !done && m == "live" && index($0, k "=") == 1 { print k "=" v; done = 1; next }
    !done && m == "commented" && (index($0, "# " k "=") == 1 || index($0, "#" k "=") == 1) { print k "=" v; done = 1; next }
    { print }
    END { if (m == "append") print k "=" v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"   # keep the file's owner and mode
  rm -f "$tmp"
}

public_ipv4() { ip -4 route get 1.1.1.1 2> /dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n 1; }
public_ipv6() { ip -6 -o addr show scope global 2> /dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1; }

as_signer() { runuser -u "$SVC_USER" -- env HOME="$DATA_DIR" npm_config_cache="$NPM_CACHE" PATH="/usr/bin:/bin" "$@"; }

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -y -qq \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install "$@" > /dev/null
}

main() {
  [ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || die "This installer supports Ubuntu (found ${PRETTY_NAME:-unknown})."
  case "${VERSION_ID:-}" in
    22.04 | 24.04) ;;
    *) warn "Tested on Ubuntu 22.04 and 24.04; this is ${PRETTY_NAME}. Continuing." ;;
  esac

  local first_run=1
  [ -f "$ENV_FILE" ] && first_run=0

  # ------------------------------------------------------------------------
  local DOMAIN ADMIN_EMAIL PROVIDER UPSTREAM_HOST UPSTREAM_PORT
  local ENTRA_TENANT="" ENTRA_ID="" ENTRA_SECRET="" GOOGLE_ID="" GOOGLE_SECRET=""
  if [ "$first_run" -eq 1 ]; then
    say "Signer setup"
    note "A few questions. Press Enter to accept a [default]."
    DOMAIN="${SIGNER_DOMAIN:-}"
    ADMIN_EMAIL="${SIGNER_ADMIN_EMAIL:-}"
    PROVIDER="${SIGNER_PROVIDER:-}"
    UPSTREAM_HOST="${SIGNER_UPSTREAM_HOST:-}"
    ask DOMAIN "Hostname for this server, e.g. signer.example.com"
    [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
      die "'${DOMAIN}' is not a valid hostname."
    DOMAIN="${DOMAIN,,}"
    ask ADMIN_EMAIL "Super admin's email (signs in to the portal; also used for Let's Encrypt)"
    [[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "'${ADMIN_EMAIL}' is not an email address."
    ask PROVIDER "Mail provider: microsoft or google" "microsoft"
    PROVIDER="${PROVIDER,,}"
    case "$PROVIDER" in
      microsoft | m365 | office365) PROVIDER=microsoft ;;
      google | workspace | gmail) PROVIDER=google ;;
      *) die "Mail provider must be microsoft or google." ;;
    esac
    if [ "$PROVIDER" = microsoft ]; then
      note "Signed mail goes back to the tenant's MX host: Microsoft 365 admin → Settings → Domains → MX record."
      ask UPSTREAM_HOST "Tenant MX host, e.g. contoso-com.mail.protection.outlook.com"
      [[ "$UPSTREAM_HOST" == *.mail.protection.outlook.com ]] ||
        warn "${UPSTREAM_HOST} does not end in .mail.protection.outlook.com. Check it before routing mail."
      UPSTREAM_PORT=25
      note "Portal sign-in uses an Entra app registration (README → Identity). Leave blank to add later."
      ask ENTRA_TENANT "Entra tenant ID" "-"
      ask ENTRA_ID "Entra application (client) ID" "-"
      if [ "$ENTRA_ID" != "-" ]; then ask ENTRA_SECRET "Entra client secret (hidden)" "" secret; fi
    else
      ask UPSTREAM_HOST "Google SMTP relay host" "smtp-relay.gmail.com"
      UPSTREAM_PORT=587
      note "Portal sign-in uses a Google OAuth client (README → Identity). Leave blank to add later."
      ask GOOGLE_ID "Google OAuth client ID" "-"
      if [ "$GOOGLE_ID" != "-" ]; then ask GOOGLE_SECRET "Google OAuth client secret (hidden)" "" secret; fi
    fi
    [ "$ENTRA_TENANT" = "-" ] && ENTRA_TENANT=""
    [ "$ENTRA_ID" = "-" ] && ENTRA_ID=""
    [ "$GOOGLE_ID" = "-" ] && GOOGLE_ID=""
  else
    say "Updating Signer (configuration in ${ENV_FILE} is kept)"
    DOMAIN="$(env_get SMTP_HOSTNAME)"
    ADMIN_EMAIL="$(env_get SUPER_ADMIN_EMAIL)"
    UPSTREAM_HOST="$(env_get UPSTREAM_HOST)"
    UPSTREAM_PORT="$(env_get UPSTREAM_PORT)"
    [ -n "$DOMAIN" ] || die "SMTP_HOSTNAME is empty in ${ENV_FILE}."
  fi

  local ipv4 ipv6
  ipv4="$(public_ipv4)"
  ipv6="$(public_ipv6)"

  # ------------------------------------------------------------------------
  say "System packages"
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -qq update
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -y -qq \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade > /dev/null
  apt_install ca-certificates curl git gnupg build-essential python3 sqlite3 ufw nginx certbot unattended-upgrades
  note "Up to date. Security updates install automatically (unattended-upgrades)."

  # A 1 GB server runs out of memory building the portal; add swap if needed.
  local mem_kb
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  if [ "$mem_kb" -lt 3000000 ] && ! swapon --show | grep -q .; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile > /dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    note "Added 2 GB of swap for builds."
  fi

  # ------------------------------------------------------------------------
  say "Node.js ${NODE_MAJOR}"
  local current_major=0
  [ -x /usr/bin/node ] && current_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
  if [ "$current_major" -lt "$NODE_MAJOR" ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - > /dev/null
    apt_install nodejs
  fi
  note "$(/usr/bin/node -v)"

  # ------------------------------------------------------------------------
  say "Service account and directories"
  id "$SVC_USER" > /dev/null 2>&1 ||
    useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 "$DATA_DIR" "$DATA_DIR/backups"
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 755 "$APP_DIR" "$NPM_CACHE"
  install -d -o root -g "$SVC_USER" -m 750 "$CONF_DIR" "$TLS_DIR"
  install -d -m 755 "$WEBROOT"
  note "Runs as '${SVC_USER}'. Code ${APP_DIR}, config ${CONF_DIR}, data ${DATA_DIR}."

  # ------------------------------------------------------------------------
  say "Signer code (${BRANCH})"
  if [ -d "$APP_DIR/.git" ]; then
    as_signer git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    as_signer git -C "$APP_DIR" reset --quiet --hard "origin/${BRANCH}"
  else
    as_signer git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  note "At $(as_signer git -C "$APP_DIR" log -1 --format='%h %s')"
  note "Building (a few minutes on a small server)…"
  (cd "$APP_DIR" &&
    as_signer npm ci --no-audit --no-fund --loglevel=error > /dev/null &&
    as_signer npm ci --prefix web --no-audit --no-fund --loglevel=error > /dev/null &&
    as_signer npm run build --silent > /dev/null) || die "Build failed. Re-run with the output: cd ${APP_DIR} && sudo -u ${SVC_USER} npm run build"
  note "Built."

  # ------------------------------------------------------------------------
  say "Configuration"
  if [ "$first_run" -eq 1 ]; then
    install -o root -g "$SVC_USER" -m 640 "$APP_DIR/.env.example" "$ENV_FILE"
    env_set PUBLIC_URL "https://${DOMAIN}"
    env_set SUPER_ADMIN_EMAIL "$ADMIN_EMAIL"
    env_set SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
    env_set DATA_DIR "$DATA_DIR"
    env_set HTTP_HOST 127.0.0.1
    env_set HTTP_PORT 3000
    env_set TRUST_PROXY loopback
    env_set CORS_ORIGINS "https://${DOMAIN}"
    env_set SMTP_HOSTNAME "$DOMAIN"
    env_set SMTP_PORT 25
    env_set SMTP_SUBMISSION_PORT 587
    env_set SMTP_ALT_PORT 0
    env_set SMTP_ALLOWED_CIDRS "$PROVIDER"
    env_set UPSTREAM_HOST "$UPSTREAM_HOST"
    env_set UPSTREAM_PORT "$UPSTREAM_PORT"
    env_set UPSTREAM_SECURE false
    env_set DEMO_MODE false
    env_set AUTH_ALLOW_DEV_LOGIN false
    [ -n "$ENTRA_TENANT" ] && env_set ENTRA_TENANT_ID "$ENTRA_TENANT"
    [ -n "$ENTRA_ID" ] && env_set ENTRA_CLIENT_ID "$ENTRA_ID"
    [ -n "$ENTRA_SECRET" ] && env_set ENTRA_CLIENT_SECRET "$ENTRA_SECRET"
    [ -n "$GOOGLE_ID" ] && env_set GOOGLE_CLIENT_ID "$GOOGLE_ID"
    [ -n "$GOOGLE_SECRET" ] && env_set GOOGLE_CLIENT_SECRET "$GOOGLE_SECRET"
    note "Wrote ${ENV_FILE} (readable by root and ${SVC_USER} only)."
  else
    [ -n "$(env_get SESSION_SECRET)" ] || env_set SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
    chown root:"$SVC_USER" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
    note "Kept ${ENV_FILE}."
  fi

  # ------------------------------------------------------------------------
  say "Ports 25 and 587"
  local port holder
  for port in 25 587; do
    holder="$(ss -Hltnp "sport = :${port}" 2> /dev/null || true)"
    if [ -n "$holder" ] && ! printf '%s' "$holder" | grep -q '"node"'; then
      die "Port ${port} is in use by another program:
${holder}
Stop it (for Postfix: systemctl disable --now postfix) and re-run."
    fi
  done
  note "Free."

  # ------------------------------------------------------------------------
  say "Firewall"
  ufw allow OpenSSH > /dev/null
  ufw allow 80/tcp comment 'Signer portal (HTTP, certificates)' > /dev/null
  ufw allow 443/tcp comment 'Signer portal' > /dev/null
  ufw allow 25/tcp comment 'Signer SMTP' > /dev/null
  ufw allow 587/tcp comment 'Signer SMTP submission' > /dev/null
  ufw --force enable > /dev/null
  note "Open: 22, 80, 443, 25, 587. Everything else inbound is blocked."

  # ------------------------------------------------------------------------
  say "Certificate"
  write_nginx "$DOMAIN"
  local cert_live="/etc/letsencrypt/live/${DOMAIN}"
  install_cert_hook "$DOMAIN"
  if [ ! -f "$cert_live/fullchain.pem" ]; then
    local resolved
    resolved="$(getent ahostsv4 "$DOMAIN" 2> /dev/null | awk 'NR == 1 {print $1}' || true)"
    if [ -z "$resolved" ] || [ "$resolved" != "$ipv4" ]; then
      warn "${DOMAIN} resolves to '${resolved:-nothing}', not this server (${ipv4}).
    Skipping the certificate for now. Create the DNS A record, wait for it to
    resolve, then run this script again."
    else
      certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
        --non-interactive --agree-tos -m "$ADMIN_EMAIL" --keep-until-expiring --quiet ||
        warn "Let's Encrypt did not issue a certificate. Check DNS and that port 80 is reachable, then re-run."
    fi
  fi
  if [ -f "$cert_live/fullchain.pem" ]; then
    RENEWED_LINEAGE="$cert_live" /etc/letsencrypt/renewal-hooks/deploy/signer
    [ -n "$(env_get TLS_CERT_PATH)" ] || env_set TLS_CERT_PATH "$TLS_DIR/fullchain.pem"
    [ -n "$(env_get TLS_KEY_PATH)" ] || env_set TLS_KEY_PATH "$TLS_DIR/privkey.pem"
    write_nginx "$DOMAIN"
    note "Valid until $(openssl x509 -in "$TLS_DIR/fullchain.pem" -noout -enddate | cut -d= -f2). Renews automatically."
  fi

  # ------------------------------------------------------------------------
  say "Services"
  write_units
  systemctl daemon-reload
  systemctl enable --quiet signer.service signer-backup.timer
  systemctl restart signer-backup.timer
  systemctl restart systemd-journald
  systemctl enable --quiet --now certbot.timer 2> /dev/null || true
  systemctl restart signer
  local healthy=0 _
  for _ in $(seq 1 30); do
    if curl -fs http://127.0.0.1:3000/api/health > /dev/null 2>&1; then healthy=1; break; fi
    sleep 1
  done
  if [ "$healthy" -eq 1 ]; then
    note "Signer is running."
  else
    warn "Signer did not start. Last log lines:"
    journalctl -u signer -n 30 --no-pager || true
  fi
  if journalctl -u signer -n 200 --no-pager 2> /dev/null | grep -q "\[signer\] WARNING"; then
    note "Startup warnings (journalctl -u signer to see all):"
    journalctl -u signer -n 200 --no-pager -o cat | grep "\[signer\] WARNING" | sort -u | sed 's/^/      /' | head -n 10
  fi

  # ------------------------------------------------------------------------
  say "Outbound SMTP (Linode blocks this on new accounts until support lifts it)"
  local outbound=open
  if [ -n "$UPSTREAM_HOST" ]; then
    if timeout 8 bash -c "exec 3<>/dev/tcp/${UPSTREAM_HOST}/${UPSTREAM_PORT:-25}" 2> /dev/null; then
      note "open     ${UPSTREAM_HOST}:${UPSTREAM_PORT:-25}"
    else
      note "BLOCKED  ${UPSTREAM_HOST}:${UPSTREAM_PORT:-25}"
      outbound=blocked
    fi
  fi

  # ------------------------------------------------------------------------
  say "Done"
  cat << EOF
    Portal:        https://${DOMAIN}
    Public IPv4:   ${ipv4:-unknown}
    Public IPv6:   ${ipv6:-none}
    Config:        ${ENV_FILE}   (edit, then: systemctl restart signer)
    Logs:          journalctl -u signer -f
    Update:        sudo bash ${APP_DIR}/deploy/install.sh

    Next steps (README → Deploy):
EOF
  local step=1
  if [ ! -f "$TLS_DIR/fullchain.pem" ]; then
    echo "      ${step}. DNS A record ${DOMAIN} → ${ipv4}, then re-run this script for the certificate."; step=$((step + 1))
  fi
  echo "      ${step}. Linode Cloud Manager → this Linode → Network: set reverse DNS of both IPs to ${DOMAIN}."; step=$((step + 1))
  if [ "$outbound" = blocked ]; then
    echo "      ${step}. Open a Linode support ticket to lift the SMTP restriction, then re-run to check."; step=$((step + 1))
  fi
  if [ -z "$(env_get ENTRA_CLIENT_ID)" ] && [ -z "$(env_get GOOGLE_CLIENT_ID)" ]; then
    echo "      ${step}. Add Entra or Google sign-in details to ${ENV_FILE} and restart Signer."; step=$((step + 1))
  fi
  echo "      ${step}. Sign in as $(env_get SUPER_ADMIN_EMAIL), sync the directory, build a signature."; step=$((step + 1))
  echo "      ${step}. Connect Microsoft 365 or Google Workspace (README), using IPv4 ${ipv4}."
  [ -f /var/run/reboot-required ] && warn "Updates installed that need a reboot. Run: reboot"
  return 0
}

write_nginx() {
  local domain="$1" live="/etc/letsencrypt/live/$1" v6=0
  # Listen on IPv6 only where the kernel has it; nginx refuses to start otherwise.
  [ -s /proc/net/if_inet6 ] && v6=1
  # shellcheck disable=SC2016  # nginx variables, not shell ones
  local proxy='
    location / {
        # Signer logs requests itself (journal, 14 days); a second copy here
        # would keep client IPs on another schedule. See PRIVACY.md.
        access_log off;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # Overwrite, so a client cannot supply its own address.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        client_max_body_size 10m;
    }'
  {
    echo "# Written by deploy/install.sh; changes are replaced on the next run."
    echo "server {"
    echo "    listen 80;"
    [ "$v6" -eq 1 ] && echo "    listen [::]:80;"
    echo "    server_name ${domain};"
    echo "    location ^~ /.well-known/acme-challenge/ { root ${WEBROOT}; }"
    if [ -f "$live/fullchain.pem" ]; then
      # shellcheck disable=SC2016
      echo '    location / { return 301 https://$host$request_uri; }'
      echo "}"
      echo "server {"
      # "listen ... http2" works on every Ubuntu nginx; newer ones only warn.
      echo "    listen 443 ssl http2;"
      [ "$v6" -eq 1 ] && echo "    listen [::]:443 ssl http2;"
      echo "    server_name ${domain};"
      echo "    ssl_certificate ${live}/fullchain.pem;"
      echo "    ssl_certificate_key ${live}/privkey.pem;"
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"
      echo '    add_header Strict-Transport-Security "max-age=31536000" always;'
      echo "$proxy"
    else
      echo "$proxy"
    fi
    echo "}"
  } > /etc/nginx/sites-available/signer
  ln -sf /etc/nginx/sites-available/signer /etc/nginx/sites-enabled/signer
  rm -f /etc/nginx/sites-enabled/default
  nginx -t -q || die "Nginx rejected the generated configuration (/etc/nginx/sites-available/signer)."
  systemctl reload nginx 2> /dev/null || systemctl restart nginx
}

install_cert_hook() {
  install -d /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/signer << EOF
#!/usr/bin/env bash
# Installed by Signer's deploy/install.sh. Runs after each certificate issue or
# renewal: gives Signer its own readable copy for SMTP STARTTLS, then reloads
# Nginx and restarts Signer so both serve the new certificate.
set -euo pipefail
live="\${RENEWED_LINEAGE:-/etc/letsencrypt/live/$1}"
[ "\$(basename "\$live")" = "$1" ] || exit 0
install -o root -g ${SVC_USER} -m 644 "\$live/fullchain.pem" ${TLS_DIR}/fullchain.pem
install -o root -g ${SVC_USER} -m 640 "\$live/privkey.pem" ${TLS_DIR}/privkey.pem
systemctl reload nginx || true
if systemctl is-active --quiet signer; then systemctl restart signer; fi
EOF
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/signer
}

write_units() {
  cat > /etc/systemd/system/signer.service << EOF
[Unit]
Description=Signer email signature gateway
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=SIGNER_ENV_FILE=${ENV_FILE}
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
# Bind ports 25 and 587 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

  cat > /usr/local/sbin/signer-backup << EOF
#!/usr/bin/env bash
# Installed by Signer's deploy/install.sh. Consistent SQLite snapshot plus the
# uploaded artwork, kept for 14 days in ${DATA_DIR}/backups.
set -euo pipefail
data="${DATA_DIR}"
stamp="\$(date +%Y%m%d-%H%M%S)"
[ -f "\$data/signer.db" ] || { echo "No database yet."; exit 0; }
sqlite3 "\$data/signer.db" ".backup '\$data/backups/signer-\$stamp.db'"
gzip -f "\$data/backups/signer-\$stamp.db"
if [ -d "\$data/uploads" ]; then
  tar -C "\$data" -czf "\$data/backups/uploads-\$stamp.tgz" uploads
fi
find "\$data/backups" -type f -mtime +14 -delete
echo "Backed up to \$data/backups (\$stamp)."
EOF
  chmod 755 /usr/local/sbin/signer-backup

  cat > /etc/systemd/system/signer-backup.service << EOF
[Unit]
Description=Signer nightly backup

[Service]
Type=oneshot
User=${SVC_USER}
Group=${SVC_USER}
ExecStart=/usr/local/sbin/signer-backup
EOF

  cat > /etc/systemd/system/signer-backup.timer << EOF
[Unit]
Description=Nightly Signer backup

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

  # Signer's request log (client IPs) lives in the journal; keep it no longer
  # than the backups. PRIVACY.md states this. The server is dedicated to
  # Signer, so this applies to the whole journal.
  install -d /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/signer-retention.conf << EOF
# Installed by Signer's deploy/install.sh.
[Journal]
MaxRetentionSec=14day
EOF
}

# Everything runs from main(), which bash reads in full before starting, so
# the update step can replace this file on disk while it runs.
main "$@"
