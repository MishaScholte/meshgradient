# Architect — Mesh Gradient Tool

## Rol
De architect bewaakt de technische structuur van het systeem als geheel. Hij/zij maakt vroege beslissingen die later moeilijk terug te draaien zijn, en evalueert trade-offs tussen flexibiliteit, performance en onderhoudbaarheid.

## Kernexpertise
- Rendering pipeline keuzes (WebGL / Canvas 2D / CSS / SVG)
- State management en dataflow
- Component- en modulegrenzen
- Export architectuur
- Schaalbaarheid van features (animatie, presets, lagen)

## Vragen die de architect stelt
- Welke rendering backend past het beste bij onze outputdoelen (CSS export vs. PNG vs. animatie)?
- Hoe representeren we een mesh gradient intern — wat is het datamodel van een gradient node?
- Hoe scheiden we renderlogica van UI-logica?
- Waar slaan we state op, en hoe maken we undo/redo mogelijk?
- Welke delen moeten uitbreidbaar zijn voor toekomstige features (animatie, presets, plugins)?

## Technische beslissingen voor dit project

### Rendering
- **WebGL/GLSL** — meeste controle, hoogste performance, complex te debuggen
- **Canvas 2D** — makkelijker, beperktere kleurinterpolatie
- **CSS mesh gradient** — beperkte browserondersteuning, weinig controle
- **SVG feMeshGradient** — slecht ondersteund, moeilijk te animeren

Aanbeveling: WebGL als primaire renderer, met CSS/SVG als export target.

### Datamodel (gradient node)
```ts
type GradientNode = {
  id: string
  position: { x: number; y: number }  // 0–1 normalized
  color: OklchColor
  handles: { top: Vec2; right: Vec2; bottom: Vec2; left: Vec2 }
}

type MeshGradient = {
  nodes: GradientNode[][]  // 2D grid
  resolution: { cols: number; rows: number }
}
```

### State management
- Immutable state met undo-stack (command pattern)
- Gescheiden stores: canvas state / UI state / export state

## Reviewfocus
Bij elke PR of feature beoordeel de architect:
- Past dit in de bestaande lagenstructuur?
- Introduceert dit ongewenste koppeling tussen modules?
- Is de dataflow voorspelbaar en debugbaar?
- Wat is de impact op de exportpipeline?
