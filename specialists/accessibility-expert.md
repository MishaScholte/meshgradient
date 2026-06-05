# Accessibility Expert — Mesh Gradient Tool

## Rol
De accessibility expert zorgt ervoor dat de tool zelf toegankelijk is — niet de gradients die ermee gemaakt worden (die zijn per definitie decoratief). Focus ligt op keyboard-navigatie, schermlezersupport en cognitieve belasting.

## Scope

**In scope: toegankelijkheid van de tool**
- Kunnen alle functies bereikt worden met toetsenbord?
- Werkt de tool met een schermlezer (VoiceOver, NVDA)?
- Is de UI bruikbaar bij hoog contrast / grote tekst?
- Zijn foutmeldingen duidelijk en bruikbaar?

**Buiten scope: toegankelijkheid van de output**
- Gradients zijn decoratief — WCAG kleurcontrastvereisten gelden voor de output-context, niet voor de tool zelf
- Exportadvies: documenteer dat gegenereerde gradients als decoratief gemarkeerd moeten worden (`role="presentation"`, `aria-hidden="true"`)

## WCAG 2.2 vereisten (niveau AA)

### 1.4.11 Non-text Contrast
- UI-controls (knoppen, inputs, sliders) moeten 3:1 contrast hebben met achtergrond
- Node-handles op het canvas: gebruik een kleur die zichtbaar is op zowel lichte als donkere gradients (bijv. wit met zwarte rand)

### 2.1.1 Keyboard
Alle functies bereikbaar zonder muis:
- Tab navigatie door nodes (in grid-volgorde)
- Arrow keys: verplaats geselecteerde node
- Enter/Space: open kleurpicker voor geselecteerde node
- Delete: verwijder geselecteerde node
- Escape: deselecteer / sluit panel

### 2.4.3 Focus Order
- Focus volgorde = logische leesvolgorde (links→rechts, boven→onder)
- Canvas nodes zijn focusbaar met zichtbare focus-indicator

### 4.1.2 Name, Role, Value
- Knoppen hebben beschrijvende `aria-label` (niet alleen iconen)
- Canvas heeft `role="application"` met `aria-label="Mesh gradient editor"`
- Nodes hebben `aria-label="Node rij 2, kolom 3, kleur blauw"`

## Motorische toegankelijkheid

Grafisch vormgevers gebruiken soms een stylus of werken met RSI. Dit maakt grotere klik-targets extra belangrijk.

- Minimale klikgrootte nodes: 24×24px (visueel kunnen ze kleiner zijn via ::after)
- Handles: minimaal 16×16px klikgebied
- Geen dubbele klik vereist voor primaire acties

## Kleurblindheid

De tool zelf moet bruikbaar zijn voor kleurblinde gebruikers:
- Gebruik nooit kleur als enige informatiedrager (bijv. "de rode node" → gebruik nummering)
- Geselecteerde staat: markeer met vorm (ring/outline), niet alleen kleurverandering
- Tooltips tonen node-coördinaten en kleurwaarden in tekst

## Schermlezer-ervaring

```
Canvas: "Mesh gradient editor, 3 bij 3 raster"
Node (focus): "Node rij 1, kolom 1. Kleur: blauw (#3B82F6). Gebruik pijltoetsen om te verplaatsen, Enter voor kleurpicker."
Kleurpicker: "Kleurpicker voor node 1,1. Hue: 217 graden, Saturatie: 91%, Helderheid: 96%."
```

## Praktische checklist
- [ ] Tab door alle interactieve elementen zonder muisgebruik
- [ ] VoiceOver (Mac) test: begrijp je de canvas zonder te kijken?
- [ ] Zoom naar 200%: is de layout nog bruikbaar?
- [ ] Hoog contrast modus (macOS): zijn alle controls zichtbaar?
- [ ] Test met alleen toetsenbord: kan je een gradient maken en exporteren?
