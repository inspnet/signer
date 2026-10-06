# shellcheck shell=bash
# Signer — Forge deploy script.
#
# In Forge: Site → Deployments → Deploy script. Replace the default script with
# this one and change the `cd` path to your site's directory.
#
# If the site uses zero-downtime deployments, keep the release lines Forge
# generated instead: put the npm lines before the line that activates the
# release, and the restart and health check after it. Then re-run the recipe
# once after the first deploy so signer.service points at the `current` link.

set -e
# Build with the same Node the service runs (installed by the recipe), so the
# native SQLite module matches it.
export PATH="/usr/bin:$PATH"

cd /home/forge/signer.example.com
git pull origin "$FORGE_SITE_BRANCH"

npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
npm run build

# Allowed without a password by the Signer recipe (/etc/sudoers.d/signer).
sudo -n /usr/bin/systemctl restart signer

# Fail the deploy, and get Forge's failure notification, if Signer does not
# come back up.
for _ in $(seq 1 20); do
  if curl -fs http://127.0.0.1:3000/api/health > /dev/null; then
    echo "Signer is up."
    exit 0
  fi
  sleep 1
done
echo "Signer did not answer /api/health within 20 seconds. Check: journalctl -u signer -n 100"
exit 1
