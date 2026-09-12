# Runbase identity

Runbase is a wordmark-led identity. It is written `run/base`, with a contrasting
slash separating the product name's two ideas. The slash also references a URL
path, a command path, and forward movement without relying on a literal cloud,
server, rocket, or monogram.

## Core palette

| Role | Color | Hex |
| --- | --- | --- |
| Signal | Champagne | `#C8A76A` |
| Brand ink | Deep Ink | `#17201C` |
| Night | Carbon | `#111318` |
| Light ground | Warm Bone | `#FBF8F1` |
| Reversed mark | White | `#FFFFFF` |

Champagne is the recognition color, not an effect. Use it as a single flat
color. The wordmark must also remain fully recognizable in one color.

## Usage rules

- Keep clear space around the wordmark equal to the height of its lowercase `u`.
- Use the wordmark at 90 px wide or larger in digital interfaces.
- Use Deep Ink on light backgrounds and White on dark backgrounds. Keep the
  slash Champagne in full-color applications.
- Use the slash-only mark only where the full wordmark cannot fit, such as a
  browser favicon or compact application tile.
- Never add gradients, glow, shadows, bevels, glass effects, outlines, a
  rounded-square container, or extra decorative shapes.
- Never remove or reposition the slash in the full wordmark.

## Production assets

- `apps/web/public/runbase-wordmark.svg` — primary wordmark
- `apps/web/public/runbase-mark.svg` — compact Champagne slash
- `apps/web/public/runbase-mark-ink.svg` — one-color Carbon mark
- `apps/web/public/runbase-mark-white.svg` — reversed White mark
- `apps/web/src/app/icon.svg` — browser and application icon

The React `BrandLogo` renders the primary wordmark. `BrandMark` is reserved for
compact contexts and uses `currentColor`.
