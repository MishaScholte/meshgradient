# Performance Expert — Mesh Gradient Tool

## Rol
De performance expert zorgt ervoor dat de tool snel aanvoelt voor de gebruiker: geen merkbare vertraging bij het slepen van nodes, soepele animaties en snelle export. Grafisch vormgevers werken met professionele hardware maar verwachten ook professionele responsiviteit.

## Prestatiedoelen

| Actie | Target |
|---|---|
| Node slepen (render update) | < 16ms (60fps) |
| Initieel laden van canvas | < 200ms |
| Export naar PNG (1920×1080) | < 500ms |
| Export naar CSS/SVG | < 50ms |
| Undo/redo | < 16ms |

## Kritieke paden

### Render loop
De render loop draait op `requestAnimationFrame`. Regels:
- **Nooit** objecten alloceren in de render loop (geen `new`, geen array literals)
- **Alleen** re-renderen als state veranderd is (dirty flag)
- GPU uploads (uniforms, vertex data) batchen — niet per node uploaden

```ts
// Slecht: elke frame nieuwe Float32Array
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW)

// Goed: hergebruik pre-gealloceerde buffer
gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexBuffer)
```

### Mouse/drag events
- Gebruik `pointer events` (niet mouse events) voor betere performance
- Debounce of throttle is NIET gewenst — die voegen latency toe
- State updates tijdens drag: gebruik lokale (component) state, schrijf pas naar globale state bij `pointerup`

### Tessellatie
- Pre-bereken tessellatie bij node-wijziging, niet in de render loop
- Cache tessellatie per patch; invalideer alleen gewijzigde patches
- Gebruik Web Workers voor zware herberekeningen (export, grote grids)

## Geheugenmanagement
- WebGL buffers expliciet opruimen bij `destroy()` (geen automatic GC)
- ImageData objecten voor PNG export hergebruiken
- Undo stack een maximum geven (bijv. 50 stappen) om geheugengroei te beperken

## Profileringstips
- Chrome DevTools > Performance > Enable "Advanced Paint Instrumentation"
- `chrome://gpu` voor WebGL capabilities
- `console.time` / `console.timeEnd` voor export timing
- Spector.js browser extension voor WebGL frame debugging

## Wanneer optimaliseren
Optimaliseer NIET preventief. Eerst meten, dan optimaliseren:
1. Identificeer bottleneck met profiler
2. Formuleer hypothesis
3. Pas aan, meet opnieuw
4. Documenteer bevinding
