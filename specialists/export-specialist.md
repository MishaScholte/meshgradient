# Export Specialist — Mesh Gradient Tool

## Rol
De export specialist zorgt ervoor dat de output van de tool bruikbaar is in de workflow van de grafisch vormgever. Een gradient die er mooi uitziet in de tool maar niet correct exporteert, is waardeloos. Export is een eerste-klas feature.

## Exportformaten

### PNG / JPEG (raster)
**Wanneer:** eindproduct, presentaties, mockups
- Resolutie instelbaar (1×, 2×, 4× of custom px)
- PNG: transparantie ondersteunen, sRGB ICC-profiel embedden
- JPEG: kwaliteit slider, geen transparantie
- Kleurprofiel: sRGB (default) of Display P3

### SVG (vector)
**Wanneer:** schaalbare assets, Figma/Illustrator import
- SVG `<meshgradient>` — experimenteel, slechte browserondersteuning
- Alternatief: SVG met `<feImage>` + embedded base64 PNG (pragmatisch)
- Of: SVG met veel `<rect>` patches (acceptabele benadering)
- Vermeld in UI welke aanpak gebruikt wordt en de beperkingen

### CSS
**Wanneer:** web developers die de gradient in code willen
- CSS heeft geen native mesh gradient support
- Output opties:
  1. `background-image: url(data:image/png;base64,...)` (embedded PNG)
  2. Meerdere `radial-gradient()` lagen als benadering
  3. CSS Custom Properties voor kleurwaarden
- Label output duidelijk als "approximation" indien van toepassing

### Figma Plugin (toekomstig)
**Wanneer:** direct in Figma workflow importeren
- Figma API: `figma.createImage()` met PNG bytes
- Of: Figma fill als image fill op een rechthoek
- Plugin communicatie via `postMessage`

### Lottie / JSON animatie (toekomstig)
**Wanneer:** geanimeerde gradient als app-achtergrond
- Lottie ondersteunt geen mesh gradients natively
- Workaround: keyframe-interpolated PNG sequence

## Export UI

```
[ Export ]
  ├── Formaat: PNG  SVG  CSS  [Custom...]
  ├── Formaat: PNG
  │     ├── Breedte: [1920] px
  │     ├── Hoogte: [1080] px  [Vergrendel aspect ratio]
  │     ├── Schaal: 1×  2×  4×
  │     └── Kleurprofiel: sRGB  Display P3
  └── [Download] [Kopieer naar klembord]
```

## Correctheidsvereisten
- Preview in canvas = identiek aan export (WYSIWYG)
- Test op minimaal: Chrome, Safari, Firefox
- Test export op: Mac (P3 display), Windows (sRGB)

## Prestaties
- PNG export van 4K (3840×2160) moet < 2 seconden
- Gebruik `OffscreenCanvas` + Web Worker voor zware exports
- Toon progressindicator bij exports > 500ms

## Edge cases
- Export van gradient met transparante nodes
- Export bij zeer kleine canvas (< 100px)
- Export bij maximale grid (bijv. 8×8 nodes)
- Knippen naar klembord mislukt in non-HTTPS context (geef duidelijke foutmelding)

## Wat te vermijden
- Exporteer nooit zonder visuele bevestiging (laat preview zien)
- Geen stille export-fouten — toon altijd status
- Geen export die de UI blokkeert (gebruik async/worker)
