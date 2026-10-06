#!/usr/bin/env bash
# Signer — Laravel Forge recipe.
#
# Prepares a Forge server (Ubuntu, provisioned on Linode) to run Signer as a
# systemd service. Create it under Forge → Recipes with user "root", edit the
# two values below, and run it against the server. It is safe to run again:
# every step checks before it changes anything.
#
# What it does:
#   1. Installs Node.js 22 if the server has an older Node, plus sqlite3.
#   2. Makes sure nothing else is holding SMTP ports 25 and 587.
#   3. Creates the data, TLS and backup directories outside the git checkout.
#   4. Installs signer.service: runs as the site user and binds ports 25/587
#      through a single capability (CAP_NET_BIND_SERVICE), not as root.
#   5. Copies the site's Let's Encrypt certificate (issued by Forge) to where
#      Signer can read it, and re-copies it daily so renewals reach SMTP.
#   6. Takes a nightly SQLite backup and keeps 14 days.
#   7. Lets the site user restart the service from the deploy script.
#   8. Opens 25 and 587 in ufw.
#   9. Checks whether Linode's outbound SMTP restriction is still in place.

set -euo pipefail

# ---- Edit these ----------------------------------------------------------
SIGNER_DOMAIN="signer.example.com"   # the Forge site's domain (= PUBLIC_URL host = SMTP_HOSTNAME)
SIGNER_USER="forge"                  # the site's user; "forge" unless the site is isolated
# --------------------------------------------------------------------------

NODE_MAJOR=22
SITE_DIR="/home/${SIGNER_USER}/${SIGNER_DOMAIN}"
DATA_DIR="/home/${SIGNER_USER}/signer-data"
TLS_DIR="/home/${SIGNER_USER}/signer-tls"
SYSTEMCTL=/usr/bin/systemctl

say()  { printf '\n==> %s\n' "$*"; }
warn() { printf '\n!!  %s\n' "$*"; }
die()  { printf '\nXX  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this recipe as root (set the recipe's user to root in Forge)."
[ "$SIGNER_DOMAIN" != "signer.example.com" ] || die "Edit SIGNER_DOMAIN at the top of the recipe first."
id "$SIGNER_USER" > /dev/null 2>&1 || die "User ${SIGNER_USER} does not exist on this server."
[ -x "$SYSTEMCTL" ] || die "Expected systemctl at ${SYSTEMCTL}."

# The app runs from the checkout, or from the active release when the site
# uses zero-downtime deployments. systemd resolves the symlink on each start.
ENV_FILE="${SITE_DIR}/.env"
if [ -L "${SITE_DIR}/current" ]; then
  APP_DIR="${SITE_DIR}/current"
else
  APP_DIR="${SITE_DIR}"
fi

# --------------------------------------------------------------------------
say "Node.js ${NODE_MAJOR}"
# The service and the deploy script both use the system Node in /usr/bin, so
# better-sqlite3 is always compiled for the Node that runs it. A different
# Node earlier on someone's PATH (nvm, n) is left alone and not used.
NODE_BIN=/usr/bin/node
current_major=0
if [ -x "$NODE_BIN" ]; then
  current_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
fi
if [ "$current_major" -lt "$NODE_MAJOR" ]; then
  echo "Found Node ${current_major} in /usr/bin; installing Node ${NODE_MAJOR} from NodeSource."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
else
  echo "Node $("$NODE_BIN" -v) is already installed."
fi

# sqlite3 for backups; build tools in case better-sqlite3 has no prebuilt binary.
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3 build-essential python3 > /dev/null
echo "sqlite3 and build tools present."

# --------------------------------------------------------------------------
say "SMTP ports"
for port in 25 587; do
  holder="$(ss -Hltnp "sport = :${port}" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! printf '%s' "$holder" | grep -q '"node"'; then
    die "Port ${port} is already in use:
${holder}
Stop that service first (for Postfix: systemctl disable --now postfix), then re-run this recipe."
  fi
done
echo "25 and 587 are free (or already held by Signer)."

# --------------------------------------------------------------------------
say "Directories"
install -d -o "$SIGNER_USER" -g "$SIGNER_USER" -m 700 "$DATA_DIR" "$DATA_DIR/backups" "$TLS_DIR"
echo "Data:    ${DATA_DIR}"
echo "TLS:     ${TLS_DIR}"
if [ -f "$ENV_FILE" ]; then
  chown "$SIGNER_USER:$SIGNER_USER" "$(readlink -f "$ENV_FILE")"
  chmod 600 "$(readlink -f "$ENV_FILE")"
  echo ".env:    ${ENV_FILE} (now readable by ${SIGNER_USER} only)"
fi

# --------------------------------------------------------------------------
say "Certificate sync"
cat > /usr/local/sbin/signer-sync-cert <<EOF
#!/usr/bin/env bash
# Installed by the Signer Forge recipe. Copies the Let's Encrypt certificate
# Forge manages for ${SIGNER_DOMAIN} to ${TLS_DIR}, where the Signer process
# (which does not run as root) can read it for SMTP STARTTLS.
#   --restart-if-changed   restart signer.service when the certificate changed
set -euo pipefail
domain="${SIGNER_DOMAIN}"
user="${SIGNER_USER}"
dest="${TLS_DIR}"

cert=""
key=""
# Prefer the certificate Nginx is actually serving for the site.
for conf in /etc/nginx/sites-available/"\$domain" /etc/nginx/sites-enabled/"\$domain" /etc/nginx/forge-conf/"\$domain"/server/*.conf; do
  [ -f "\$conf" ] || continue
  c="\$(awk '\$1 == "ssl_certificate" { gsub(/;/, "", \$2); print \$2; exit }' "\$conf")"
  k="\$(awk '\$1 == "ssl_certificate_key" { gsub(/;/, "", \$2); print \$2; exit }' "\$conf")"
  if [ -n "\$c" ] && [ -n "\$k" ]; then cert="\$c"; key="\$k"; break; fi
done
# Otherwise the newest certificate Forge has stored for the domain.
if [ -z "\$cert" ]; then
  # shellcheck disable=SC2012  # Forge names these directories by numeric id
  newest="\$(ls -1td /etc/nginx/ssl/"\$domain"/*/ 2>/dev/null | head -n 1 || true)"
  newest="\${newest%/}"
  if [ -n "\$newest" ] && [ -f "\$newest/server.crt" ] && [ -f "\$newest/server.key" ]; then
    cert="\$newest/server.crt"
    key="\$newest/server.key"
  fi
fi

if [ -z "\$cert" ] || [ ! -f "\$cert" ] || [ ! -f "\$key" ]; then
  echo "signer-sync-cert: no certificate found for \$domain yet. Issue one under the site's SSL tab in Forge."
  exit 0
fi

changed=0
if ! cmp -s "\$cert" "\$dest/fullchain.pem" || ! cmp -s "\$key" "\$dest/privkey.pem"; then
  install -o "\$user" -g "\$user" -m 600 "\$key" "\$dest/privkey.pem"
  install -o "\$user" -g "\$user" -m 644 "\$cert" "\$dest/fullchain.pem"
  changed=1
  echo "signer-sync-cert: installed certificate from \$cert"
fi

if [ "\${1:-}" = "--restart-if-changed" ] && [ "\$changed" -eq 1 ] && ${SYSTEMCTL} is-active --quiet signer; then
  ${SYSTEMCTL} restart signer
  echo "signer-sync-cert: restarted signer for the renewed certificate"
fi
EOF
chmod 755 /usr/local/sbin/signer-sync-cert
/usr/local/sbin/signer-sync-cert
if [ -f "$TLS_DIR/fullchain.pem" ]; then
  echo "Certificate: $(openssl x509 -in "$TLS_DIR/fullchain.pem" -noout -subject -enddate | tr '\n' ' ')"
fi

# --------------------------------------------------------------------------
say "Backups"
cat > /usr/local/sbin/signer-backup <<EOF
#!/usr/bin/env bash
# Installed by the Signer Forge recipe. Consistent SQLite snapshot plus the
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

# --------------------------------------------------------------------------
say "systemd units"
cat > /etc/systemd/system/signer.service <<EOF
[Unit]
Description=Signer email signature gateway
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=${SIGNER_USER}
Group=${SIGNER_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
# "+" runs the copy as root; "-" lets Signer start before a certificate exists.
ExecStartPre=-+/usr/local/sbin/signer-sync-cert
ExecStart=${NODE_BIN} dist/server.js
Restart=always
RestartSec=5
# Bind 25 and 587 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/signer-cert-sync.service <<EOF
[Unit]
Description=Copy the renewed Let's Encrypt certificate to Signer

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/signer-sync-cert --restart-if-changed
EOF

cat > /etc/systemd/system/signer-cert-sync.timer <<EOF
[Unit]
Description=Daily Signer certificate sync

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/signer-backup.service <<EOF
[Unit]
Description=Signer nightly backup

[Service]
Type=oneshot
User=${SIGNER_USER}
Group=${SIGNER_USER}
ExecStart=/usr/local/sbin/signer-backup
EOF

cat > /etc/systemd/system/signer-backup.timer <<EOF
[Unit]
Description=Nightly Signer backup

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

$SYSTEMCTL daemon-reload
$SYSTEMCTL enable signer.service signer-cert-sync.timer signer-backup.timer > /dev/null
$SYSTEMCTL start signer-cert-sync.timer signer-backup.timer
echo "signer.service, signer-cert-sync.timer and signer-backup.timer are enabled."

# --------------------------------------------------------------------------
say "Deploy permissions"
cat > /etc/sudoers.d/signer <<EOF
# Installed by the Signer Forge recipe: lets the deploy script restart Signer.
${SIGNER_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} restart signer, ${SYSTEMCTL} restart signer.service
EOF
chmod 440 /etc/sudoers.d/signer
visudo -cf /etc/sudoers.d/signer > /dev/null || { rm -f /etc/sudoers.d/signer; die "sudoers entry failed validation."; }
# Read the service log without sudo: journalctl -u signer
usermod -aG systemd-journal "$SIGNER_USER"
echo "${SIGNER_USER} may restart signer and read its journal."

# --------------------------------------------------------------------------
say "Firewall"
if command -v ufw > /dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 25/tcp comment 'Signer SMTP' > /dev/null
  ufw allow 587/tcp comment 'Signer SMTP submission' > /dev/null
  echo "ufw allows 25/tcp and 587/tcp. (Forge's Network tab does not list rules added here.)"
else
  warn "ufw is not active; make sure 25/tcp and 587/tcp are reachable."
fi
echo "If a Linode Cloud Firewall is attached, allow 22, 80, 443, 25 and 587 inbound there too."

# --------------------------------------------------------------------------
say "Outbound SMTP (Linode blocks this on new accounts until support lifts it)"
upstream_host=""
upstream_port=""
if [ -f "$ENV_FILE" ]; then
  upstream_host="$(grep -E '^UPSTREAM_HOST=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d "\"' " || true)"
  upstream_port="$(grep -E '^UPSTREAM_PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d "\"' " || true)"
fi
check_out() {
  if timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2> /dev/null; then
    echo "  open     $1:$2"
  else
    echo "  BLOCKED  $1:$2"
    blocked=1
  fi
}
blocked=0
if [ -n "$upstream_host" ]; then
  check_out "$upstream_host" "${upstream_port:-25}"
else
  check_out smtp-relay.gmail.com 587
  check_out aspmx.l.google.com 25
fi
if [ "$blocked" -eq 1 ]; then
  warn "Outbound SMTP is blocked, so signed mail cannot be handed back yet. Open a Linode support ticket to
    lift the SMTP restriction (set reverse DNS to ${SIGNER_DOMAIN} first), then re-run this recipe."
fi

# --------------------------------------------------------------------------
say "Start"
if [ -f "${APP_DIR}/dist/server.js" ] && [ -f "$ENV_FILE" ]; then
  $SYSTEMCTL restart signer
  healthy=0
  for _ in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:3000/api/health > /dev/null 2>&1; then healthy=1; break; fi
    sleep 1
  done
  if [ "$healthy" -eq 1 ]; then
    echo "Signer is running."
  else
    warn "Signer did not answer /api/health. Last log lines:"
    journalctl -u signer -n 40 --no-pager || true
  fi
else
  echo "Not started yet: deploy the site (and create its .env) first. The deploy script starts it."
fi

# --------------------------------------------------------------------------
ipv4="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
ipv6="$(ip -6 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
say "Done"
cat <<EOF
Public IPv4:  ${ipv4:-unknown}   <- Exchange inbound connector / Google SMTP relay allow list
Public IPv6:  ${ipv6:-none}
Reverse DNS for both should be ${SIGNER_DOMAIN} (Linode Cloud Manager → Linode → Network).

.env values this layout expects:
  DATA_DIR=${DATA_DIR}
  HTTP_HOST=127.0.0.1
  SMTP_HOSTNAME=${SIGNER_DOMAIN}
  TLS_CERT_PATH=${TLS_DIR}/fullchain.pem
  TLS_KEY_PATH=${TLS_DIR}/privkey.pem

Useful:
  systemctl status signer
  journalctl -u signer -f
  /usr/local/sbin/signer-backup      (run a backup now)
EOF
