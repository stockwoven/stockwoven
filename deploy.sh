#!/usr/bin/env bash
# Puts Stockwoven (site, app, docs and /api) online on this server, in one command.
#
#   sudo ./deploy.sh --domain stockwoven.example.com   # first time: sets everything up, then deploys
#   sudo ./deploy.sh --https                           # once DNS points here: HTTPS with Certbot
#   sudo ./deploy.sh                                   # every update after that
#
# Options:
#   --domain <name>   domain for nginx (remembered in /etc/stockwoven/stockwoven.env)
#   --branch <name>   git branch to deploy (default: the one checked out)
#   --no-pull         deploy the code as it is, without git pull
#   --https           run Certbot for the domain after deploying
#
# What it does, every run (safe to repeat):
#   1. Setup if missing: system user "stockwoven", /etc/stockwoven/stockwoven.env (from
#      deploy/stockwoven.env.example), the systemd service, the nginx site.
#   2. git pull, npm ci, next build (standalone server).
#   3. A dated release in /var/www/stockwoven/releases, "current" switched to it, service restarted.
#   4. Checks it answers on 127.0.0.1:$PORT; if not, switches back to the previous release.
# See deploy/README.md for what each piece is.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$REPO/app"
BASE=/var/www/stockwoven
CONF_DIR=/etc/stockwoven
ENV_FILE="$CONF_DIR/stockwoven.env"
SERVICE=stockwoven
SERVICE_USER=stockwoven
KEEP=5

DOMAIN_ARG=""
BRANCH=""
PULL=1
HTTPS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN_ARG="${2:?--domain needs a name}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --https) HTTPS=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root: sudo ./deploy.sh"
[ -d "$APP" ] || fail "no app/ next to deploy.sh; run it from the repository"
command -v node >/dev/null || fail "Node.js is missing (needs 20.9+; see deploy/README.md)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=9)?0:1)' \
  || fail "Node.js $(node -v) is too old; needs 20.9+"
command -v npm >/dev/null || fail "npm is missing"

# ---------------------------------------------------------------- 1. setup
say "setup"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "created user $SERVICE_USER"
fi
mkdir -p "$BASE/releases" "$CONF_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$BASE" "$BASE/releases"

if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO/deploy/stockwoven.env.example" "$ENV_FILE"
  chown "root:$SERVICE_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "created $ENV_FILE (review it: RPC and faucet key)"
fi
if [ -n "$DOMAIN_ARG" ]; then
  if grep -q '^DOMAIN=' "$ENV_FILE"; then sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN_ARG|" "$ENV_FILE"; else printf '\nDOMAIN=%s\n' "$DOMAIN_ARG" >> "$ENV_FILE"; fi
fi
set -a; . "$ENV_FILE"; set +a
PORT="${PORT:-3100}"
DOMAIN="${DOMAIN:-}"

if [ -n "${FAUCET_KEYPAIR_PATH:-}" ] && [ ! -f "$FAUCET_KEYPAIR_PATH" ] && [ -z "${FAUCET_SECRET_KEY:-}" ]; then
  echo "note: no faucet key at $FAUCET_KEYPAIR_PATH; the site works, the test-token faucet won't (see deploy/README.md)"
fi

install -m 644 "$REPO/deploy/stockwoven.service" /etc/systemd/system/stockwoven.service
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true

if [ -n "$DOMAIN" ]; then
  command -v nginx >/dev/null || fail "nginx is missing (apt install nginx)"
  SITE="/etc/nginx/sites-available/$DOMAIN"
  if [ ! -f "$SITE" ]; then
    # Only written once: Certbot edits this file afterwards, and a redeploy must not undo that.
    sed -e "s/stockwoven.esptechnologies.com.br/$DOMAIN/g" -e "s/127.0.0.1:3100/127.0.0.1:$PORT/" \
      "$REPO/deploy/nginx/stockwoven.conf" > "$SITE"
    ln -sfn "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
    nginx -t || { rm -f "/etc/nginx/sites-enabled/$DOMAIN"; fail "nginx rejected the new site; nothing else changed"; }
    systemctl reload nginx
    echo "nginx site $DOMAIN enabled"
  fi
else
  echo "note: no domain yet; the app will answer on 127.0.0.1:$PORT only (sudo ./deploy.sh --domain <name>)"
fi

# ---------------------------------------------------------------- 2. code and build
if [ "$PULL" -eq 1 ] && git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$BRANCH" ]; then
    say "git: $BRANCH"
    git -C "$REPO" fetch --quiet origin "$BRANCH"
    git -C "$REPO" checkout --quiet "$BRANCH"
  else
    say "git: $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  fi
  if git -C "$REPO" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    git -C "$REPO" pull --ff-only --quiet || fail "git pull failed (local changes on the server?)"
  else
    echo "no upstream branch; deploying the code as it is"
  fi
fi
COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)

say "build ($COMMIT)"
cd "$APP"
export NEXT_TELEMETRY_DISABLED=1
npm ci --include=dev --no-audit --no-fund --loglevel=error
npm run build
[ -f .next/standalone/server.js ] || fail "build has no .next/standalone/server.js (is output: \"standalone\" in app/next.config.ts?)"

# ---------------------------------------------------------------- 3. release
say "release"
RELEASE="$BASE/releases/$(date +%Y%m%d-%H%M%S)-$COMMIT"
mkdir -p "$RELEASE/.next"
cp -a .next/standalone/. "$RELEASE/"
cp -a .next/static "$RELEASE/.next/static"
cp -a public "$RELEASE/public"
chown -R "$SERVICE_USER:$SERVICE_USER" "$RELEASE"

PREVIOUS=$(readlink -f "$BASE/current" 2>/dev/null || true)
ln -sfn "$RELEASE" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
systemctl restart "$SERVICE"

# ---------------------------------------------------------------- 4. check
say "checking 127.0.0.1:$PORT"
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then
    ls -1dt "$BASE"/releases/* | tail -n +$((KEEP + 1)) | xargs -r rm -rf
    say "online: $RELEASE"
    if [ "$HTTPS" -eq 1 ]; then
      [ -n "$DOMAIN" ] || fail "--https needs a domain (--domain <name>)"
      command -v certbot >/dev/null || fail "certbot is missing (apt install certbot python3-certbot-nginx)"
      certbot --nginx -d "$DOMAIN"
    fi
    if [ -n "$DOMAIN" ]; then
      if grep -q "listen 443" "/etc/nginx/sites-available/$DOMAIN" 2>/dev/null; then echo "https://$DOMAIN"; else echo "http://$DOMAIN  (HTTPS: sudo ./deploy.sh --https)"; fi
    fi
    exit 0
  fi
  sleep 1
done

echo "!! the service didn't answer in 30 s"
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$RELEASE" ]; then
  echo "!! back to $PREVIOUS"
  ln -sfn "$PREVIOUS" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
  systemctl restart "$SERVICE"
fi
journalctl -u "$SERVICE" -n 40 --no-pager || true
exit 1
