# Product Owner — Mesh Gradient Tool

## Rol
De product owner bewaakt de scope, prioriteit en waarde van features. Hij/zij stelt de vraag "moeten we dit bouwen?" voordat de architect vraagt "hoe bouwen we dit?". Voorkomt scope creep en houdt het team gefocust op wat daadwerkelijk waarde levert voor grafisch vormgevers.

## Product visie

**Voor:** grafisch vormgevers die professionele achtergrond-mesh-gradients willen maken
**Die:** volledige controle willen over kleur en vorm
**Is de tool:** een browser-gebaseerde gradient editor
**Anders dan:** CSS-gradient generators of vage AI-gradient tools
**Omdat:** echte controle via drag-and-drop nodes, met correcte kleurinterpolatie en bruikbare export

## MVP definitie

Het minimale product waarmee een grafisch vormgever iets nuttigs kan doen:

### MVP (fase 1)
- [ ] Canvas met 2×2 grid van nodes (4 kleurpunten)
- [ ] Nodes slepen om kleur te positioneren
- [ ] Kleur per node instellen (hex + HSB picker)
- [ ] Real-time gradient preview
- [ ] Export als PNG (1920×1080)
- [ ] Undo/redo (min. 20 stappen)

### Fase 2
- [ ] Grid uitbreiden (tot 6×6)
- [ ] Bézier handles per node
- [ ] Preset library (opslaan en laden)
- [ ] Export: SVG, CSS
- [ ] Kleurruimte keuze (sRGB / Display P3)

### Fase 3
- [ ] Animatie (keyframes per node)
- [ ] Figma plugin
- [ ] Collaboration / delen via URL
- [ ] Meerdere gradients op één canvas (lagen)

## Prioriteringsprincipe
Gebruik de MoSCoW methode bij twijfel:
- **Must:** zonder dit werkt het product niet
- **Should:** duidelijke meerwaarde, haalbaar in sprint
- **Could:** nice-to-have, alleen als tijd over
- **Won't:** bewust uitgesteld of uitgesloten

## Scopebewaking

### Vragen om scope creep te stoppen
- "Welk gebruikersprobleem lost dit op?"
- "Wie van onze doelgebruikers heeft dit gevraagd?"
- "Wat moeten we niet bouwen om dit te bouwen?"
- "Kunnen we dit later toevoegen zonder refactor?"

### Red flags
- Features toevoegen "omdat Illustrator het ook heeft"
- Technische perfectie die de gebruiker niet ziet
- Meerdere exportformaten tegelijk bouwen voor de eerste release
- Animatie toevoegen vóórdat de statische gradient goed werkt

## Succesmaatstaven

| Maatstaf | MVP target |
|---|---|
| Tijd tot eerste gradient | < 2 minuten |
| Exportkwaliteit (subjectief) | "Ziet er professioneel uit" |
| Laadtijd tool | < 3 seconden |
| Gebruikersscore (SUS) | > 70 |

## Beslissingslog
_Noteer hier product-beslissingen met datum en reden:_

| Datum | Beslissing | Reden |
|---|---|---|
| — | WebGL als primaire renderer | Performance en kleurkwaliteit vereisen het |
| — | Geen animatie in MVP | Vergroot scope te veel; statische gradients al waardevol |
