# Galacean Effects RichText Plugin

## Usage

### Simple Import

``` ts
import { Player } from '@galacean/effects';
import '@galacean/effects-plugin-rich-text';
```

### Text rasterization limits

Both modern and legacy rich text use `PlayerConfig.textRasterization` (or
`EngineOptions.textRasterization`). Limits reduce texture resolution while preserving
layout, wrapping, alignment and element size. Omitted options use these defaults:

| Option | Default | Purpose |
| --- | --- | --- |
| `maxTextureSize` | `4096` | Maximum texture side, also capped at half the device limit |
| `maxPixels` | `4 * 1024 * 1024` | Maximum pixels per texture |
| `previewMaxPixels` | `1024 * 1024` | Preview pixel budget, also capped by `maxPixels` |
| `maxLogicalSize` | `10000000` | Maximum layout and style dimensions, including inline `<size>` values |

Use `richText.setRasterizationOptions(options)` to override limits on a
`RichTextComponent`; pass `{}` to restore the engine policy. Invalid dimensions or
inline font sizes are rejected before allocating the canvas.

Hosts can enable rasterization previews while continuously changing text, font size,
dimensions or styles. The same API is available on `TextComponent` and `RichTextComponent`:

``` ts
const endPreview = richText.beginRasterizationPreview();

try {
  richText.setText('<b>Preview</b>');
  richText.flushText(); // Update pixels and draw without advancing playback.
} finally {
  endPreview();
  richText.flushText(); // Restore the normal budget after a changed preview.
}
```

Starting a preview applies the preview budget to subsequent texture updates; it does
not trigger a redraw. Ending a preview marks the text for a normal-budget update only
if a preview texture was generated. `rasterizationMode` is `'preview'` while active and
`'normal'` after ending. Each component has one active preview: starting another one,
reloading data or disposing the component invalidates older handles. Use
`endPreview.isActive()` to check ownership; ending an inactive handle has no effect.

`flushText(false)` updates the texture without drawing the scene. Batch related
edits before flushing to avoid redundant rasterization. During normal playback,
the runtime also updates dirty text automatically. Both rich text implementations
reuse the existing GPU texture when its dimensions and upload settings match.

## Development

### Getting Started

``` bash
# demo
pnpm --filter @galacean/effects-plugin-rich-text dev
```

> [Open in browser](http://localhost:8081/demo/)

## Frame Comparison Testing

> [Open in browser](http://localhost:8081/test/)
