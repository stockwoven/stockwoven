#!/usr/bin/env bash
# Publica uma nova versão do Stockwoven no servidor. Rode como root:
#
#   sudo /opt/stockwoven/repo/deploy/deploy.sh            # branch padrão (Meteora-Track)
#   sudo /opt/stockwoven/repo/deploy/deploy.sh Frontend    # outra branch
#
# Passos: atualiza o código, instala dependências, faz o build com as variáveis de
# /etc/stockwoven/stockwoven.env, monta um release novo em /var/www/stockwoven/releases/<data>,
# troca o link "current" para ele, reinicia o serviço e confere se respondeu. Se o serviço não
# subir, volta para o release anterior. Guarda os 5 últimos releases.

set -euo pipefail

BRANCH="${1:-Meteora-Track}"
REPO=/opt/stockwoven/repo
BASE=/var/www/stockwoven
ENV_FILE=/etc/stockwoven/stockwoven.env
SERVICE=stockwoven
KEEP=5

[ "$(id -u)" -eq 0 ] || { echo "rode como root (sudo)"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "falta $ENV_FILE (copie deploy/stockwoven.env.example)"; exit 1; }

echo "==> código: $BRANCH"
sudo -u stockwoven git -C "$REPO" fetch --quiet origin
sudo -u stockwoven git -C "$REPO" checkout --quiet "$BRANCH"
sudo -u stockwoven git -C "$REPO" reset --quiet --hard "origin/$BRANCH"
COMMIT=$(git -C "$REPO" rev-parse --short HEAD)

echo "==> build ($COMMIT)"
cd "$REPO/app"
set -a; . "$ENV_FILE"; set +a
sudo -u stockwoven --preserve-env=NEXT_PUBLIC_RPC_URL,NODE_ENV npm ci --include=dev --no-audit --no-fund
sudo -u stockwoven --preserve-env=NEXT_PUBLIC_RPC_URL npm run build

echo "==> release"
RELEASE="$BASE/releases/$(date +%Y%m%d-%H%M%S)-$COMMIT"
mkdir -p "$RELEASE"
cp -a .next/standalone/. "$RELEASE/"
mkdir -p "$RELEASE/.next"
cp -a .next/static "$RELEASE/.next/static"
cp -a public "$RELEASE/public"
chown -R stockwoven:stockwoven "$RELEASE"

PREVIOUS=$(readlink -f "$BASE/current" || true)
ln -sfn "$RELEASE" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"

echo "==> reiniciando $SERVICE"
systemctl restart "$SERVICE"
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:${PORT:-3100}/"; then
    echo "==> no ar: $RELEASE"
    ls -1dt "$BASE"/releases/* | tail -n +$((KEEP + 1)) | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

echo "!! o serviço não respondeu em 30 s"
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$RELEASE" ]; then
  echo "!! voltando para $PREVIOUS"
  ln -sfn "$PREVIOUS" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
  systemctl restart "$SERVICE"
fi
journalctl -u "$SERVICE" -n 40 --no-pager
exit 1
