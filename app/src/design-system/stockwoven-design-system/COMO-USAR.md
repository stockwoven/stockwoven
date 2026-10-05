# Como usar este pacote no projeto

1. Copie a pasta `stockwoven-design-system/` para dentro do repositório do frontend
   (ex.: `src/design-system/` ou `public/design-system/`, conforme o stack).
2. Importe os CSS nesta ordem, uma vez, no layout raiz:
   - `css/fonts.css`      → @font-face das 3 famílias (arquivos em `fonts/`)
   - `css/tokens.css`     → variáveis CSS (cores, tipo, espaço, raio) + classes `.t-display-xl` … `.t-eyebrow`
   - `css/components.css` → Button, Logo, PoweredBy, TickerChip, StatCard, WeavePattern
3. Carregue `js/stockwoven.js` (expõe `window.Stockwoven`: `mark()`, `weave()`, `mountMarks()`, `mountWeaves()`).
4. Logos, padrão e imagens sociais estão em `assets/` com os nomes do README.
   Favicon: `assets/social/app-icon.png`.
5. Tema escuro: coloque `data-theme="dark"` no `<html>` ou numa seção.

Regras da marca: `README.md`. Uso de cada componente: `components/*.md`.
