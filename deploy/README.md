# Publicar o Stockwoven num servidor próprio

Site, app, docs e a API (`/api/faucet`) são um único servidor Next.js. No servidor fica assim:

```
navegador ──https──▶ nginx (443, certificado do Certbot)
                      ├─ /_next/static/*  ─▶ arquivos do disco (cache de 1 ano)
                      └─ todo o resto     ─▶ node server.js em 127.0.0.1:3100 (serviço systemd "stockwoven")
```

A diferença para um frontend estático com backend separado (como o hml): não existe uma pasta de HTML com um `/api` apontando para outro processo. O nginx manda tudo para o Next, que serve as páginas e a API. Por isso o `proxy_pass` não tem barra no fim: `/api/faucet` chega ao Next como `/api/faucet`.

| Arquivo | Vai para |
|---|---|
| `deploy/nginx/stockwoven.conf` | `/etc/nginx/sites-available/<domínio>` (e link em `sites-enabled`) |
| `deploy/stockwoven.service` | `/etc/systemd/system/stockwoven.service` |
| `deploy/stockwoven.env.example` | `/etc/stockwoven/stockwoven.env` (com seus valores) |
| `deploy/deploy.sh` | roda direto do repositório clonado |

Os exemplos usam o domínio `stockwoven.esptechnologies.com.br` e a porta `3100` (a 3000 já é do hml). Troque se quiser.

## Requisitos

- Ubuntu ou Debian com `nginx`, `certbot` (`python3-certbot-nginx`) e `git`.
- Node.js 20.9 ou mais novo. Recomendado: Node 24 LTS (`curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install -y nodejs`).
- O domínio apontando (registro A) para o IP do servidor, antes de rodar o Certbot.
- Cerca de 1,5 GB de RAM livre durante o build.

## Primeira instalação

Tudo como root.

**1. Usuário e código**

```bash
useradd --system --create-home --home-dir /opt/stockwoven --shell /usr/sbin/nologin stockwoven
sudo -u stockwoven git clone https://github.com/stockwoven/stockwoven.git /opt/stockwoven/repo
mkdir -p /var/www/stockwoven/releases && chown -R stockwoven:stockwoven /var/www/stockwoven
```

O repositório é privado: o servidor precisa de acesso de leitura. O mais simples é uma *deploy key* (GitHub › Settings › Deploy keys) com a chave SSH do usuário `stockwoven`, clonando por `git@github.com:stockwoven/stockwoven.git`.

**2. Configuração e chave do faucet**

```bash
mkdir -p /etc/stockwoven
cp /opt/stockwoven/repo/deploy/stockwoven.env.example /etc/stockwoven/stockwoven.env
nano /etc/stockwoven/stockwoven.env          # confira PORT, RPC e o caminho da chave
# copie a chave do faucet (JSON) para /etc/stockwoven/faucet-keypair.json, por exemplo com scp
chown root:stockwoven /etc/stockwoven/stockwoven.env && chmod 640 /etc/stockwoven/stockwoven.env
chown stockwoven:stockwoven /etc/stockwoven/faucet-keypair.json && chmod 600 /etc/stockwoven/faucet-keypair.json
```

Veja [A chave do faucet](#a-chave-do-faucet) antes de escolher qual chave usar.

**3. Serviço**

```bash
cp /opt/stockwoven/repo/deploy/stockwoven.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable stockwoven
```

**4. Primeiro deploy**

```bash
chmod +x /opt/stockwoven/repo/deploy/deploy.sh
/opt/stockwoven/repo/deploy/deploy.sh
```

Ele faz o build, monta o release em `/var/www/stockwoven/current` e sobe o serviço. Teste local: `curl -I http://127.0.0.1:3100/`.

**5. nginx e HTTPS**

```bash
DOMINIO=stockwoven.esptechnologies.com.br
sed "s/stockwoven.esptechnologies.com.br/$DOMINIO/" /opt/stockwoven/repo/deploy/nginx/stockwoven.conf > /etc/nginx/sites-available/$DOMINIO
ln -s /etc/nginx/sites-available/$DOMINIO /etc/nginx/sites-enabled/$DOMINIO
nginx -t && systemctl reload nginx
certbot --nginx -d $DOMINIO
```

O Certbot acrescenta sozinho o `listen 443 ssl`, os caminhos do certificado e o redirecionamento de HTTP para HTTPS, e o arquivo fica no mesmo formato do hml. A renovação já é automática.

## Atualizar

```bash
sudo /opt/stockwoven/repo/deploy/deploy.sh               # branch Meteora-Track
sudo /opt/stockwoven/repo/deploy/deploy.sh Frontend      # outra branch
```

Cada deploy vira um release novo em `/var/www/stockwoven/releases/`. O `current` aponta para o último. Se o serviço não responder em 30 segundos, o script volta sozinho para o anterior. Ficam guardados os 5 últimos.

Voltar à mão para um release anterior:

```bash
ln -sfn /var/www/stockwoven/releases/<pasta> /var/www/stockwoven/current
systemctl restart stockwoven
```

## No dia a dia

| Para | Comando |
|---|---|
| Ver se está no ar | `systemctl status stockwoven` |
| Logs ao vivo | `journalctl -u stockwoven -f` |
| Reiniciar | `systemctl restart stockwoven` |
| Logs do nginx | `tail -f /var/log/nginx/error.log` |

## O que precisa saber

**`NEXT_PUBLIC_RPC_URL` entra no build.** O navegador usa esse RPC, e o valor é gravado no JavaScript. Mudou no `.env`, rode o `deploy.sh` de novo. As outras variáveis (`RPC_URL`, `FAUCET_KEYPAIR_PATH`, `PORT`) só pedem `systemctl restart stockwoven`.

**O RPC público da devnet tem limite.** Com várias pessoas usando o app, vale trocar `NEXT_PUBLIC_RPC_URL` por um RPC próprio (Helius, QuickNode), que é gratuito para devnet.

**A aba Markets lê um arquivo fixo** (`app/public/data/tape.json`). Para atualizar os dados: rode a coleta da pesquisa, depois `npx tsx scripts/tape-data.ts <execution-quality>/data/out` na raiz do repositório, faça commit e rode o `deploy.sh`.

**Limites do faucet.** O nginx aceita até 6 pedidos por minuto por IP em `/api/faucet` (com folga de 3). O faucet também só envia uma vez por minuto para cada carteira. Esse controle fica na memória e zera quando o serviço reinicia.

## A chave do faucet

O faucet assina com a autoridade de mint dos tokens de teste. Hoje essa autoridade é a carteira admin (`Dwrba…`), que **também pode atualizar o programa** e administrar o vault. Não coloque essa chave num servidor público: quem tiver acesso ao servidor teria o controle do programa na devnet.

O caminho seguro é uma chave só para o faucet:

```bash
solana-keygen new --no-bip39-passphrase -o faucet-keypair.json
# com a carteira admin, passe a autoridade de mint dos três tokens de teste para a chave nova:
spl-token authorize <mint mINTCx> mint <pubkey da chave nova> -u devnet
spl-token authorize <mint mINTC>  mint <pubkey da chave nova> -u devnet
spl-token authorize <mint USDC>   mint <pubkey da chave nova> -u devnet
# e mande um pouco de SOL de devnet para ela (o faucet também envia SOL para taxas)
```

Os mints estão em `app/src/lib/devnet.json`. Depois disso, a carteira admin não cunha mais esses tokens; só a chave do faucet.
