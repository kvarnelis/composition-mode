# Changelog

## 1.1.0 — 2026-04-21

Added four new settings for taming composition mode on large external monitors and tuning page aesthetics:

- **Max paper width (px)** — absolute cap on page width (default 1400). Prevents the page from growing unboundedly on wide monitors where the previous viewport-percentage rule produced a 2000+ px text column. Configurable 800–2400.
- **Image width** — percentage of the text column embedded images fill (default 100%, configurable 50–100%). Centers automatically when below 100%. Per-image `![[img.jpg|400]]` overrides still apply.
- **Side margin (inches)** — left/right margin between paper edge and text column (default 1.25 in, configurable 0.5–2.5 in).
- **Top/bottom margin (inches)** — vertical margin on each page (default 1.0 in, configurable 0.5–2.0 in).

Fixed:

- Image embeds no longer shrink-wrap to an awkward sub-column width inside the live-preview widget. Image embed wrappers are now block-level with explicit `width: 100%`, and the nested `<img>` is forced to fill — so images reliably stretch to the full text column (before being scaled down by the new Image width setting).

## 1.0.1 — 2026-04-21

- Fix responsive zoom controls.

## 1.0.0 — 2026-04-21

- Initial release.
