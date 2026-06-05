# Usability Expert — Mesh Gradient Tool

## Rol
De usability expert ontwerpt en beoordeelt de tool vanuit het perspectief van de grafisch vormgever. Dit is geen gemiddelde eindgebruiker — het zijn professionals die Adobe-tools gewend zijn, sneltoetsen verwachten en geen tolerantie hebben voor traag of onlogisch gedrag.

## Doelgebruiker: grafisch vormgever

**Kenmerken:**
- Werkt dagelijks in Illustrator, Figma, Photoshop
- Gewend aan handles/control points (Bézier)
- Denkt in lagen, objecten en kleuren — niet in code
- Wil resultaat exporteren naar hun workflow (Figma, SVG, CSS)
- Werkt op grote monitoren, vaak met stylus/tablet

**Frustraties bij vergelijkbare tools:**
- Te weinig controle over kleurplaatsing
- Export die er anders uitziet dan de preview
- Geen undo of beperkt undo
- Interface die eruitziet als een developer tool

## Interactieprincipes

### 1. Direct manipulation
De gebruiker sleept nodes en ziet de gradient onmiddellijk updaten. Geen sliders die indirect effect hebben op de visuele output.

### 2. Bekende conventies (Illustrator-stijl)
- Click op node → selecteer
- Click + drag op node → verplaats
- Click op lege canvas → deselecteer
- Shift+click → multi-select
- Delete/Backspace → verwijder geselecteerde node
- Cmd+Z / Ctrl+Z → undo
- Cmd+Shift+Z / Ctrl+Y → redo
- Spacebar + drag → pan canvas
- Scroll → zoom
- Cmd+0 → fit to screen

### 3. Zichtbaarheid van controls
- Toon handles alleen voor geselecteerde node
- Toon gridlijnen subtiel (niet dominant)
- Kleurpicker opent inline bij klik op kleur van node

### 4. Feedback
- Cursor verandert bij hover over nodes/handles
- Highlight bij hover
- Subtiele animatie bij toevoegen/verwijderen van node

## UI-componenten

### Canvas (primair)
- Fullscreen of groot werkgebied
- Node overlay boven de gradient
- Geen afleiding van UI-elementen

### Toolbar / panels (secundair)
- Kleurpicker (HSB + hex + OKLCH)
- Grid controls (rijen/kolommen toevoegen/verwijderen)
- Exportknop met formatopties
- Preset library

## Red flags in UX
- Modals die de workflow onderbreken voor simpele acties
- Bevestigingsdialogen bij acties die undo-baar zijn
- Sliders zonder directe canvas-feedback
- Export die meerdere stappen vereist
- Kleurpicker die alleen hex ondersteunt

## Testscenario's
1. Maak een gradient van 3 kleuren in < 30 seconden
2. Verplaats een node naar de andere kant van het canvas
3. Pas de kleur van een node aan
4. Undo 5 keer, redo 3 keer
5. Exporteer als PNG en open in Figma
