# Self-hosting Stockwoven

The site, the app, the docs and the API (`/api/faucet`) are one Next.js server. On the server:

```
browser ──https──▶ nginx (443, Certbot certificate)
                    ├─ /_next/static/*  ─▶ files on disk (cached for a year)
                    └─ everything else  ─▶ node server.js on 127.0.0.1:3100 (systemd service "stockwoven")
```

Unlike a static frontend with a separate backend, there is no folder of HTML and no `/api` pointing at another process: nginx sends every path to Next, which serves both the pages and the API. That is why `proxy_pass` has no trailing slash: `/api/faucet` reaches Next as `/api/faucet`. Port 3100 keeps clear of anything already on 3000.

## Requirements

- Ubuntu or Debian with `nginx`, `git` and, for HTTPS, `certbot` with `python3-certbot-nginx`.
- Node.js 20.9 or newer; Node 24 LTS recommended:
  `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install -y nodejs`
- The domain's A record pointing at the server before you ask for HTTPS.
- About 1.5 GB of free memory during the build.

## Run it

```bash
git clone git@github.com:stockwoven/stockwoven.git && cd stockwoven
sudo ./deploy.sh --domain stockwoven.example.com    # first time: setup + deploy
sudo ./deploy.sh --https                            # once, when DNS points here
```

The repository is private, so the server needs read access: a GitHub deploy key is the simplest (repository › Settings › Deploy keys).

Every update after that:

```bash
sudo ./deploy.sh                    # pull the checked-out branch and redeploy
sudo ./deploy.sh --branch Frontend  # switch to another branch
sudo ./deploy.sh --no-pull          # redeploy the code as it is
```

`./deploy.sh --help` lists the options. Every run is safe to repeat. It:

1. **Sets up what's missing:** the `stockwoven` system user, `/etc/stockwoven/stockwoven.env` (copied from `deploy/stockwoven.env.example`), the systemd service, and the nginx site for the domain. The nginx site is written only once, because Certbot edits it afterwards.
2. **Builds:** `git pull`, `npm ci`, `next build`.
3. **Releases:** copies the build to `/var/www/stockwoven/releases/<date>-<commit>`, points `/var/www/stockwoven/current` at it and restarts the service.
4. **Checks** that `127.0.0.1:3100` answers within 30 seconds. If it doesn't, it points `current` back at the previous release and prints the service logs. It keeps the last 5 releases.

## After the first run

Review `/etc/stockwoven/stockwoven.env`:

| Variable | What it is | Applies after |
|---|---|---|
| `PORT` | where the server listens; nginx proxies to it | `./deploy.sh` |
| `RPC_URL` | Solana RPC used by the server (the faucet) | `systemctl restart stockwoven` |
| `NEXT_PUBLIC_RPC_URL` | Solana RPC used by the browser; baked into the build | `./deploy.sh` |
| `FAUCET_KEYPAIR_PATH` | the faucet's key file (JSON byte array), owner `stockwoven`, `chmod 600` | `systemctl restart stockwoven` |
| `DOMAIN` | written by `--domain` | — |

The public devnet RPC rate-limits. With real traffic, set both RPC variables to your own endpoint (Helius and QuickNode are free on devnet).

Without a faucet key, the site works and only "Get test tokens" fails. Read [the faucet key](#the-faucet-key) before choosing one.

## Day to day

| To | Run |
|---|---|
| See if it's up | `systemctl status stockwoven` |
| Follow the logs | `journalctl -u stockwoven -f` |
| Restart | `systemctl restart stockwoven` |
| Go back a release | `ln -sfn /var/www/stockwoven/releases/<folder> /var/www/stockwoven/current && systemctl restart stockwoven` |
| nginx errors | `tail -f /var/log/nginx/error.log` |

**Markets data** is a fixed file, `app/public/data/tape.json`. To refresh it, rerun the research collector, run `npx tsx scripts/tape-data.ts <execution-quality>/data/out` at the repository root, commit, and deploy.

**Faucet limits:** nginx allows 6 requests a minute per IP on `/api/faucet`, with a burst of 3. The faucet itself sends once a minute per wallet; that counter lives in memory and resets on restart.

## Files

| File | Installed as |
|---|---|
| `deploy.sh` (repository root) | run in place |
| `deploy/nginx/stockwoven.conf` | `/etc/nginx/sites-available/<domain>`, linked from `sites-enabled` |
| `deploy/stockwoven.service` | `/etc/systemd/system/stockwoven.service` |
| `deploy/stockwoven.env.example` | `/etc/stockwoven/stockwoven.env` |

## The faucet key

The faucet signs as the mint authority of the test tokens. Today that authority is the admin wallet (`Dwrba…`), which **can also upgrade the program** and administer the vault. Don't put that key on a public server: anyone with access to the server would control the program on devnet.

Use a key that only does the faucet's job:

```bash
solana-keygen new --no-bip39-passphrase -o faucet-keypair.json
# with the admin wallet, hand the test tokens' mint authority to the new key:
spl-token authorize <mINTCx mint> mint <new key's pubkey> -u devnet
spl-token authorize <mINTC mint>  mint <new key's pubkey> -u devnet
spl-token authorize <USDC mint>   mint <new key's pubkey> -u devnet
# and send it some devnet SOL: the faucet also tops up SOL for fees
```

The mints are in `app/src/lib/devnet.json`. Afterwards only the faucet key can mint these tokens, not the admin wallet.
