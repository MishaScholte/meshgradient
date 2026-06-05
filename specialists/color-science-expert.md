# Color Science Expert — Mesh Gradient Tool

## Rol
De color science expert zorgt ervoor dat kleuren kloppen: dat gradients er perceptueel goed uitzien, dat exports kleurgetrouw zijn en dat de tool werkt met moderne kleurruimtes die grafisch vormgevers verwachten.

## Kleurruimtes relevant voor dit project

### sRGB
- Standaard voor web en scherm
- Gamma-gecorrigeerd (niet lineair)
- **Interpoleer nooit direct in sRGB** — geeft donkere middentonen

### Linear sRGB
- sRGB zonder gamma-correctie
- Gebruik voor GPU-berekeningen en correcte light-mixing
- Conversie: `linear = srgb^2.2` (vereenvoudigd)

### OKLAB / OKLCH
- Perceptueel uniform: gelijke stap in coördinaten = gelijke visuele stap
- **Aanbevolen voor kleurinterpolatie in gradients**
- OKLCH = Lightness, Chroma, Hue (polaire versie van OKLAB)
- Beste keuze voor vloeiende, mooie gradients

### Display P3
- Bredere gamut dan sRGB (±50% meer kleuren)
- Standaard op alle Apple-displays (Mac, iPhone, iPad)
- CSS: `color(display-p3 r g b)`
- WebGL: vereist `drawingBufferColorSpace = 'display-p3'`

### HSB/HSV
- Intuïtief voor designers (Illustrator, Photoshop standaard)
- Gebruik als UI-representatie in de kleurpicker
- Interpoleer nooit in HSB — "kortste hue-pad" geeft verrassingen

## Aanbevolen kleurpijplijn

```
Gebruikersinvoer (HSB / hex)
        ↓
Opslag intern (OKLCH)
        ↓
Interpolatie in OKLAB (lineair)
        ↓
Shader output in lineair sRGB
        ↓
GPU gamma-correctie → sRGB schermoutput
        ↓
Export: sRGB (PNG/CSS) of Display P3 (indien ondersteund)
```

## Kleurpicker vereisten
- Primair: HSB (vertrouwde UI voor designers)
- Secundair: Hex input
- Geavanceerd: OKLCH sliders (L/C/H)
- Toon gamut waarschuwing als kleur buiten sRGB valt (P3-kleur)
- Live preview van interpolatie tussen twee nodes

## Veelgemaakte kleurfouten

### Donkere middentonen
**Oorzaak:** interpolatie in gamma-gecorrigeerde sRGB
**Fix:** converteer naar lineair sRGB of OKLAB voor interpolatie

### Hue-shift bij interpolatie
**Oorzaak:** interpolatie in RGB (blauw → geel gaat via grijs)
**Fix:** interpoleer in OKLCH, neem kortste hue-pad

### Vervagende kleuren bij export
**Oorzaak:** P3-kleuren worden geclipped naar sRGB zonder gamut mapping
**Fix:** zachte gamut mapping (chroma reductie in OKLCH) voor sRGB export

### Kleurverschil canvas vs. PNG
**Oorzaak:** canvas kleurprofiel niet meegegeven in PNG
**Fix:** embed sRGB ICC-profiel in PNG export

## Referentie
- [OKLCH kleurruimte](https://bottosson.github.io/posts/oklab/) — Björn Ottosson
- CSS Color Level 4 spec (OKLCH in CSS)
- `culori` JavaScript library — uitstekend voor kleurruimteconversies
