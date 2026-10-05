# WeavePattern

The generated halftone weave: diagonal strands in a plain weave, solid on top and breaking into halftone dots where they dive under, for Stockwoven's own channels.

- Markup: `<div class="sw-weave" style="height:320px"><canvas data-sw-weave data-seed="3"></canvas></div>`, then `Stockwoven.mountWeaves()`.
- `data-seed` shifts the weave; `data-light` switches to the ivory ground; `data-fade="0.4"` adds a halftone fade-in from the left edge over that share of the width.
- Or call `Stockwoven.weave(canvas, {seed: 7, light: true})` after the canvas has its size.
- Full-bleed only; when text sits beside it, use `data-fade`, never a CSS mask. Never under body text, never inside a partner's product.
- The consumer provides the box size; the pattern fills it.
