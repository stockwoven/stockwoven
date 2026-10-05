# Decisão de framework: Anchor, Quasar ou Pinocchio

Data: 2026-10-05. Branch: `anchor-otimizacoes`. Prazo do projeto: 2026-10-12 (Colosseum).

**Recomendação: ficar em Anchor.** Nenhum dos cinco critérios mínimos para migrar é atendido por completo. O ganho de CU existe (até ~30% numa instrução), mas não muda nada para o usuário nem para integrações hoje, e as duas alternativas têm lacunas concretas para o que o Stockwoven usa: Token-2022 com ScaledUiAmount e CPIs para o cp-amm com argumentos `Option`. Dentro do Anchor, as otimizações seguras medidas dão no máximo ~1,5% de CU. Por isso, nenhuma foi aplicada ao programa (detalhes na seção 6).

---

## 1. Inventário

### Ferramentas e build

| Item | Versão |
|---|---|
| anchor-lang / anchor-spl / anchor-cli | 1.2.0 (última estável, 2026-09-04) |
| Agave / solana-cli, cargo-build-sbf | 3.1.10, platform-tools v1.52 |
| Rust | 1.89.0 (`rust-toolchain.toml`) |
| Testes | LiteSVM 0.10, com o cp-amm real copiado da mainnet (`scripts/fetch-fixtures.sh`) |
| Perfil release | `overflow-checks = true`, `lto = "fat"`, `codegen-units = 1` |

O build e os testes rodam no WSL: `cargo build-sbf` e depois `cargo test -p stockwoven`. Hoje passam **14 de 14** testes (4 de matemática e 10 de ponta a ponta).

### Programa (1.448 linhas de Rust em `programs/stockwoven/src`)

| Instrução | Contas | Checagens implícitas do Anchor | CPIs |
|---|---|---|---|
| `initialize_vault` | 26 + até 2 em `remaining_accounts` (token badges) | `init` de 5 contas (vault PDA, share mint PDA, ATA do admin, 2 reservas PDA), seeds e bump, 9 `InterfaceAccount`, `mint::`/`token::` constraints, `address =` ×3, `Program<…>` ×3 | System, Token/Token-2022 (via `init`), ATA, cp-amm `initialize_customizable_pool` (parâmetros com `Option`), `mint_to` |
| `deposit` | 20 | `has_one` ×8, `Account<Vault>` (dono e discriminador), 7 `InterfaceAccount` (dono e unpack), `token::mint`/`token_program`, `address =` ×2 | `transfer_checked` ×2, cp-amm `add_liquidity`, `transfer_checked` ×2 (reembolso), `mint_to` |
| `deposit_single` | 21 | iguais às do `deposit` | `transfer_checked`, cp-amm `swap`, cp-amm `add_liquidity`, `transfer_checked` ×2, `mint_to` |
| `redeem` | 19 | `has_one` ×6, 6 `InterfaceAccount`, `address =` ×3 | `burn`, cp-amm `remove_liquidity` |
| `harvest` | 15 | `has_one` ×7, 4 `InterfaceAccount`, `address =` ×3 | cp-amm `claim_position_fee` |
| `set_deposits_paused` | 2 | `Signer`, `has_one = admin` | nenhuma |

- **Estado:** uma conta, `Vault`: 10 `Pubkey`, um `u128`, um `bool` e um `u8`, em Borsh, 354 bytes com o discriminador.
- **PDAs:**
  - `["vault", pool]`
  - `["shares", vault]`
  - `["reserve", vault, mint]`
  - a pool é a PDA `["cpool", max(mint), min(mint)]` do cp-amm.
- **Eventos:** 5, via `emit!` (`sol_log_data`).
- **Erros:** 11.
- **CPI para o cp-amm:** gerada por `declare_program!(cp_amm)` a partir de `idls/cp_amm.json`.

### Tokens reais dos emissores (lidos da mainnet em 2026-10-05)

| Token | Mint | Programa | Decimais | Extensões |
|---|---|---|---|---|
| xStocks INTCx | `XshPgPdX…mArM` | Token-2022 | 8 | MetadataPointer, TokenMetadata, **PermanentDelegate**, DefaultAccountState (initialized), **ScaledUiAmount** (multiplicador 1), **Pausable** (não pausado), ConfidentialTransferMint, TransferHook (programa nulo) |
| Backpack INTC | `iNTCy1qT…5rxFaF` | Token-2022 | 6 | as mesmas do INTCx |
| Ondo INTCon | `cJpUMp5R…3ondo` | Token-2022 | 9 | as mesmas, **sem PermanentDelegate**; ScaledUiAmount (multiplicador 1) |

- **Nenhum tem TransferFee.**
- **O AAPLx já usa um multiplicador diferente de 1 (1,00266),** segundo a pesquisa (não conferi on-chain). Isso mostra que o ScaledUiAmount está em uso de verdade, para dividendos e eventos corporativos.
- **Token badge do cp-amm:** todos precisam de um, e todos já têm na mainnet.

**Isso tem consequência fora da questão de framework.** O programa não depende do valor exibido ("UI amount"), porque a contabilidade é por liquidez. Mas o app e a cotação inicial da pool assumem "1 token bruto ÷ 10^decimais = 1 ação". Quando os multiplicadores de dois emissores divergirem, esse valor fica errado e o preço justo entre os dois tokens deixa de ser 1:1. Isso precisa ser tratado antes da mainnet, em qualquer framework (seção 7).

### O que está implantado e quem consome a interface

- **Devnet:**
  - O programa `H9ZJ…Zm7b` foi implantado hoje com `deposit_single`: 445.344 bytes e 2,26 SOL de rent.
  - Há um vault vivo, com cerca de 31 swINTC em circulação.
  - Existem duas pools USDC de rota e uma lookup table que referencia as contas do vault.
- **Mainnet:** nada implantado.
- **Consumidores:**
  - O frontend (`app/src/lib/stockwoven.ts`) e os scripts (`scripts/devnet-setup.ts`) montam as instruções à mão: **discriminadores de 8 bytes do Anchor escritos no código** e ordem de contas fixa.
  - Os testes usam os tipos gerados pelo Anchor (`stockwoven::accounts::*`, `instruction::*`).
  - Nenhum consumidor lê o IDL do Stockwoven. Não há indexador nem bot.

---

## 2. Linha de base medida

Medi com o teste `cu_profile` (`cargo test -p stockwoven --test test_vault -- --ignored --nocapture cu_profile`). Ele envia cada instrução uma vez no LiteSVM, com o cp-amm real, e divide o CU de cada transação pelo programa que o gastou.

| Instrução | Total (SPL) | Stockwoven | cp-amm | token | Total (Token-2022) | Stockwoven |
|---|---:|---:|---:|---:|---:|---:|
| `initialize_vault` | 221.877 | 63.833 | 90.135 | 54.799 | 215.677 | 61.329 |
| `deposit` | 97.915 | 32.505 | 23.730 | 41.530 | 73.678 | 32.390 |
| `deposit_single` (A) | 131.898 | 44.752 | 45.466 | 41.530 | 107.469 | 44.123 |
| `deposit_single` (B) | 131.314 | 43.394 | 46.240 | 41.530 | 106.885 | 42.765 |
| `redeem` | 64.156 | 22.294 | 24.659 | 17.053 | 56.331 | 22.175 |
| `harvest` | 40.907 | 16.189 | 18.395 | 6.173 | 36.732 | 15.885 |
| `set_deposits_paused` | 3.431 | 3.281 | 0 | 0 | 3.431 | 3.281 |
| swap direto no cp-amm (sem o Stockwoven) | 33.805 | 0 | 21.309 | 12.346 | 25.919 | 0 |

- **Binário:** `stockwoven.so` tem 484.832 bytes. O rent da conta de dados do programa é **2,46 SOL**, cobrado uma vez e devolvido se a conta for fechada.

### Onde vão os 32,5k CU do Stockwoven num `deposit`

Medi com marcadores temporários de `sol_log_compute_units`, que já foram removidos.

| Trecho | CU próprios | Some com outro framework? |
|---|---:|---|
| Entrada até o handler: dispatch, desserialização e validação de 20 contas | ~14.400 | **Quase todo.** Pinocchio e Quasar fazem isso em poucas centenas a ~2k |
| Matemática das shares | ~600 | não |
| Overhead das 2 CPIs de entrada | ~4.100 | só em parte: a syscall de CPI custa o mesmo, o que se ganha é montar as contas |
| Overhead da CPI `add_liquidity` (14 contas) | ~6.600 | só em parte |
| `reload` ×2 + 2 reembolsos | ~4.900 | só em parte |
| `mint_to` | ~1.900 | só em parte |
| Evento + saída | ~1.200 | pouco |

**Estimativa de ganho de uma migração:** de 32,5k para ~8–12k CU próprios. São −20 a −25k CU por `deposit`: **−20 a −28% do total da transação**. O resto (cp-amm e programas de token) não muda.

---

## 3. O ganho importa aqui?

- **O swap não passa pelo Stockwoven.** O Jupiter roteia direto para o cp-amm, porque a conta da posição não entra no `swap`. O CU do vault não pesa em nenhuma rota de agregador. A pesquisa confirmou isso, e o teste `swap (cp-amm only)` mostra 0 CU do Stockwoven.
- **Taxa para o usuário:** hoje o app não define preço de prioridade, então CU a menos não muda o que o usuário paga. Com prioridade de 50.000 microlamports/CU, cortar 25k CU economiza cerca de 0,0000013 SOL por depósito.
- **Limites:** a transação mais pesada, o depósito roteado por USDC, usa ~117k de 1,4M CU e 633 de 1.232 bytes. Não há pressão de limite.
- **Rent do binário:** um programa em Pinocchio teria provavelmente 60–150 KB, contra 485 KB hoje. A economia seria de ~1,5–2 SOL, uma vez, no deploy da mainnet. É o único ganho em dinheiro, e é pequeno.
- **Quando isso mudaria:**
  - se depósitos e resgates de swINTC virarem uma rota de agregador, com o vault dentro de swaps compostos, como acontece com LSTs;
  - se o vault passar a ser chamado por CPI de outros protocolos em transações apertadas.

  Nenhum dos dois está no roadmap até o hackathon.

---

## 4. Comparação

| Critério | Ficar em Anchor 1.2.0 | Quasar | Pinocchio 0.11.2 |
|---|---|---|---|
| CU próprio por `deposit` (estimado) | 32,5k (medido) | ~8–12k | ~8–12k |
| Tamanho do binário | 485 KB / 2,46 SOL | provavelmente bem menor, não medido | provavelmente 60–150 KB |
| Maturidade | estável; repositório em otter-sec/anchor; usado em produção há anos | **beta, sem auditoria, "não use com fundos reais"**; nenhuma release ou tag; crates.io só tem placeholders 0.0.0; último commit em 2026-07-26 | estável; base do p-token; auditado (Zellic e Neodyme, 2025), mas **antes da 0.10/0.11**. `pinocchio-token-2022` sem auditoria encontrada |
| Token-2022 com as extensões reais | completo: `anchor-spl` usa `spl-token-2022-interface`, que lê ScaledUiAmount, Pausable, PermanentDelegate | `transfer_checked` sim, mas **nenhum leitor de extensão**; `Mint2022` lê só os 82 bytes da base | `transfer_checked` sim; lê PermanentDelegate, Pausable e TransferHook; **ScaledUiAmount teria que ser lido à mão** |
| CPI para o cp-amm | `declare_program!` a partir do IDL do Anchor | `declare_program!` próprio, **sem `Option`, `Vec` nem enum**; `initialize_customizable_pool` usa `Option` e precisaria de CPI escrita à mão | toda CPI escrita à mão (dados e `AccountMeta`) |
| Segurança das validações | automática: dono, discriminador, signer, mut, has_one, seeds, init | macros parecidas com as do Anchor, mas o framework não é auditado | **todas escritas à mão**: ~100 checagens nas 6 instruções |
| Compatibilidade com o que existe | nenhuma mudança | **quebra**: discriminador de 1 byte muda instruções e conta `Vault`; precisa de outro program ID ou migração de estado; frontend e scripts reescritos | pode manter discriminadores de 8 bytes e layout Borsh, à mão; atualizar no lugar é possível, mas arriscado |
| IDL e clientes | gerados | gerados (TS, Rust) | por conta própria (Codama 1.11 ou Shank 0.4.9) |
| Esforço | 0 | ~1,5–2 semanas, mais trabalho por falta de suporte a extensões | ~2–3 semanas, mais testes negativos e reauditoria |
| Custo de auditoria futura | menor: auditores conhecem as checagens do Anchor | maior: framework novo também precisa ser revisado | maior: cada checagem manual é superfície de auditoria |

---

## 5. Critérios mínimos para migrar

| Critério | Quasar | Pinocchio |
|---|---|---|
| O ganho medido é material para o produto | ❌ o vault não está no caminho do swap; sem preço de prioridade; longe dos limites | ❌ mesmo motivo; só ~1,5–2 SOL de rent uma vez |
| Suporte completo, na versão fixada, a tudo que o Stockwoven usa | ❌ sem leitores de extensão Token-2022; `declare_program!` não aceita os parâmetros do `initialize_customizable_pool` | ⚠️ cobre as CPIs, mas ScaledUiAmount e cp-amm seriam escritos à mão |
| Existe caminho de testes que prove equivalência | ✅ dá para rodar a mesma bateria nos dois | ✅ idem |
| Risco de segurança adicional aceitável e explícito | ❌ framework beta, sem auditoria, guardando ativos | ⚠️ ~100 checagens manuais num programa que guarda ativos, a 7 dias do prazo |
| Mudança de layout, discriminador ou IDL sem quebrar o que está vivo | ❌ quebra a conta `Vault` e todos os clientes | ⚠️ possível só reproduzindo à mão o layout do Anchor |

Nenhuma alternativa passa em todos. **Decisão: ficar em Anchor.**

---

## 6. Otimizações dentro do Anchor (medidas)

| Otimização | Efeito medido | Segura? | Aplicada? |
|---|---|---|---|
| Feature `no-log-ix-name` (tira o log "Instruction: X") | −106 a −137 CU por instrução (0,1–0,2%) | sim | **não**: ganho irrelevante e o log ajuda a depurar e a ler transações no explorer |
| Mints como `UncheckedAccount` em `redeem` e `harvest` (endereço continua preso por `has_one`; o cp-amm checa contra a pool) | −580 a −830 CU (1–1,5%), −360 bytes | sim, mas tira uma checagem de tipo redundante | **não**: ganho pequeno não justifica tirar defesa em profundidade nem um redeploy |
| `opt-level` do perfil release: `"s"` | binário 391.488 bytes (−19%), rent ~1,99 SOL (−0,47 SOL uma vez); `deposit` de 97,9k para 108,0k CU (+10%), CU próprio +31% | sim (só compilador) | **não**: economiza 0,47 SOL uma vez e custa +10% de CU em toda transação |
| `opt-level` do perfil release: `"z"` | binário 369.592 bytes (−24%), rent 1,88 SOL (−0,59 SOL); `deposit` de 97,9k para 118,9k CU (+21%) | sim | **não**: mesma troca, pior |
| `zero_copy` / `AccountLoader` no `Vault` | não medido: muda o layout (alinhamento do `u128` e tamanho da conta), o que quebra o vault vivo | não neste momento | não |
| Guardar o bump para não recalcular `find_program_address` | já feito: `vault.bump` é usado nas assinaturas; `find_program_address` só roda no `initialize_vault` | — | já estava |
| `Box` nas contas | já usado em todas as contas grandes | — | já estava |
| `LazyAccount` no `Vault` | não medido: o `Vault` tem 354 bytes, e desserializar custa pouco perto dos ~14k de validação | — | não |

Os ~14k CU de entrada se espalham por 20 contas, cada uma com uma checagem pequena. Nenhuma otimização isolada dentro do Anchor chega perto do ganho de uma migração, e a soma das seguras fica abaixo de 2%. O ajuste de compilação vai na direção oposta: troca CU por tamanho, e o `opt-level = 3` atual (o padrão) é a melhor escolha para um programa chamado muitas vezes e implantado uma vez.

O que esta branch traz é o teste `cu_profile`. Ele fica como ferramenta para medir de novo antes de qualquer decisão futura.

---

## 7. Riscos e próximos passos (independentes do framework)

1. **ScaledUiAmount**, o achado mais importante desta análise:
   - O valor exibido pelo app (`stockValue`, `navPerShare`) e o preço inicial da pool assumem multiplicador 1 nos dois emissores.
   - Antes da mainnet, o app deve ler o multiplicador de cada mint e valorar em ações reais. Também é preciso decidir como a pool se comporta quando os multiplicadores divergirem: o preço justo deixa de ser 1:1, e a arbitragem passa a ajustar a pool.
2. **Os testes não usam as extensões reais.** Os mocks de Token-2022 só têm PermanentDelegate. É preciso acrescentar mints com Pausable (incluindo o caso pausado), ScaledUiAmount ≠ 1, DefaultAccountState e TransferHook nulo. O LiteSVM aceita isso.
3. **Emissor pausado:** se um emissor pausar o token, `redeem` falha nesse token, porque o cp-amm transfere os dois. Isso deve ficar documentado e, se possível, ter uma rota de saída de emergência.
4. **Gatilhos para reabrir esta decisão:**
   - deposit/redeem entrarem em rotas de agregador;
   - o Quasar sair do beta, com auditoria e suporte a extensões Token-2022;
   - o deploy na mainnet exigir um binário menor.

   Nesse caso, a migração a avaliar seria para Pinocchio, começando por `deposit`/`redeem`, com o Anchor como oráculo nos testes diferenciais.

## 8. Fontes

- Pinocchio: https://github.com/anza-xyz/pinocchio, https://crates.io/crates/pinocchio. Auditorias: https://reports.zellic.io/publications/pinocchio-and-p-token e https://neodyme.io/reports/P-Token.pdf
- Quasar: https://github.com/blueshift-gg/quasar, https://quasar-lang.com/docs/getting-started/migrating-from-anchor, https://quasar-lang.com/docs/profiling/benchmarks
- Anchor: https://github.com/otter-sec/anchor/releases, https://github.com/otter-sec/anchor/blob/master/bench/COMPUTE_UNITS.md
- Extensões aceitas pelo cp-amm: https://github.com/MeteoraAg/damm-v2/blob/main/programs/cp-amm/src/utils/token.rs, https://docs.meteora.ag/overview/products/damm-v2/token-2022-extensions
- Backpack INTC: https://learn.backpack.exchange/blog/tokenized-intel-intc
- Mints e extensões: `getAccountInfo` (jsonParsed) em `api.mainnet-beta.solana.com`, 2026-10-05.
