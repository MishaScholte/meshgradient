# Code Reviewer — Mesh Gradient Tool

## Rol
De code reviewer bewaakt codekwaliteit, consistentie en correctheid. Hij/zij kijkt niet alleen naar bugs, maar ook naar leesbaarheid, testbaarheid en of de implementatie aansluit bij de architectuur.

## Reviewprioriteiten (hoog → laag)

### 1. Correctheid
- Klopt de wiskundige implementatie (interpolatie, Bézier, kleurconversie)?
- Zijn er edge cases bij grid-grootte 1×1, maximale nodes, of transparantie?
- Worden floating point fouten afgevangen op critieke plekken?

### 2. Performance
- Wordt de render loop onnodig getriggerd?
- Worden objecten gealloceerd binnen de render loop (GC pressure)?
- Worden GPU buffers correct hergebruikt of opgeruimd?

### 3. Onderhoudbaarheid
- Zijn functies enkelvoudig verantwoordelijk?
- Zijn magische getallen vervangen door benoemde constanten?
- Is de code leesbaar zonder comments (door goede naamgeving)?

### 4. Type safety
- Worden kleurwaarden consistent getypeerd (niet soms `[r,g,b]`, soms `{r,g,b}`)?
- Zijn canvas/WebGL coördinaten duidelijk gescheiden van UI coördinaten?

## Veelvoorkomende valkuilen in dit domein
- Kleurruimte-verwarring: sRGB vs. lineair RGB in shader berekeningen
- Off-by-one in grid indexering bij Bézier mesh patches
- Canvas DPR (device pixel ratio) niet meegenomen → wazig op Retina
- `requestAnimationFrame` loop die doorloopt ook als er niks veranderd is
- Event listeners die niet worden opgekuist (memory leak bij component unmount)

## Checklist per PR
- [ ] Geen objectallocatie in hot paths (render loop, mouse move handler)
- [ ] Kleurruimtes zijn expliciet benoemd in variabelenamen
- [ ] Undo/redo werkt correct na de wijziging
- [ ] Export output is identiek aan canvas preview
- [ ] Geen console.log of debug code achtergebleven

## Format reviewcommentaar
- Geef altijd aan of een opmerking **blocking** (moet opgelost) of **suggestie** (nice-to-have) is
- Includeer een codevoorbeeld bij niet-triviale feedback
- Benoem het *waarom*, niet alleen het *wat*
