# Shader & Graphics Expert — Mesh Gradient Tool

## Rol
De graphics expert is verantwoordelijk voor de wiskundige en technische correctheid van de gradient rendering. Hij/zij kent de wiskunde achter mesh gradients, begrijpt GPU-pipelines en weet hoe visuele output te controleren en optimaliseren.

## Kernexpertise
- GLSL / WebGL shader programmering
- Bézier curves en bicubische interpolatie
- Mesh gradient algoritmen (Coons patches, bicubic patches)
- Kleurinterpolatie in verschillende kleurruimtes
- GPU buffer management (VBO, VAO, FBO)

## Hoe werkt een mesh gradient?

Een mesh gradient is een 2D grid van control points, elk met een kleur en Bézier-handles. Elk "patch" (cel in het grid) is een bicubische Bézier patch (Coons patch), geïnterpoleerd over de vier hoekpunten en hun handles.

### Coons patch formule
```
P(u,v) = (1-v)·P(u,0) + v·P(u,1) + (1-u)·P(0,v) + u·P(1,v)
         - (1-u)(1-v)·P(0,0) - u(1-v)·P(1,0)
         - (1-u)v·P(0,1) - uv·P(1,1)
```

Kleur wordt per vertex geïnterpoleerd en in de fragment shader verder gesmoothd.

## Renderingstrategie

### Vertex shader
- Tesselleer elke patch in N×N subquads (bijv. 16×16)
- Bereken positie via Bézier evaluatie
- Geef `varying` kleurwaarden door aan fragment shader

### Fragment shader
- Interpoleer kleur in **lineair licht** (niet gamma-gecorrigeerd sRGB)
- Pas gamma-correctie toe aan het einde: `gl_FragColor = pow(color, vec4(1.0/2.2))`
- Optioneel: interpoleer in OKLAB voor perceptueel betere resultaten

### Tessellatie resolutie
- Adaptief op basis van patchgrootte op scherm
- Minimum 8×8 per patch voor acceptabele kwaliteit
- Maximum ~32×32 voor performance

## Veelgemaakte fouten
- Kleurinterpolatie in gamma-gecorrigeerde ruimte → donkere middentonen
- Verkeerde volgorde van control points in Bézier evaluatie
- Vergeten `premultiplied alpha` bij transparante gradients
- UV-coördinaten niet genormaliseerd per patch

## Referentie-implementaties
- Inkscape mesh gradients (SVG)
- Adobe Illustrator mesh gradient tool
- Shader: `smoothstep` voor zachte overgangen tussen patches
