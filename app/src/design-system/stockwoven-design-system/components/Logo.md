# Logo

The Stockwoven symbol and lockup, drawn from one vector path so it is always exact.

- `Stockwoven.mark(color)` returns the symbol as an SVG string; put it in an element with `class="sw-mark"` and a set width and height.
- Any element with `data-sw-mark="#101010"` is filled by `Stockwoven.mountMarks()`.
- Lockup: `<span class="sw-lockup" style="font-size:48px"><span class="sw-mark" data-sw-mark="…"></span>Stockwoven</span>`. The font size sets both the symbol and the wordmark.
- Colors: `brand-ink` on ivory, `brand-ivory` on black or purple, `brand-purple` on ivory or black. One color at a time.
- Minimum 24 px. Clear space: 25% of the symbol width.
- The consumer provides the color; the component never picks one.
