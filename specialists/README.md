# Specialist Rollen — Mesh Gradient Tool

Elk bestand beschrijft een expertrol die wordt ingezet bij het ontwerpen en bouwen van de tool.

| Rol | Bestand | Focus |
|---|---|---|
| Architect | [architect.md](architect.md) | Technische structuur, datamodel, rendering keuzes |
| Code Reviewer | [code-reviewer.md](code-reviewer.md) | Codekwaliteit, correctheid, performance |
| Shader & Graphics Expert | [shader-graphics-expert.md](shader-graphics-expert.md) | WebGL, Bézier mesh, GLSL interpolatie |
| Performance Expert | [performance-expert.md](performance-expert.md) | 60fps rendering, memory, export snelheid |
| Usability Expert | [usability-expert.md](usability-expert.md) | UX voor grafisch vormgevers, interactiepatronen |
| Color Science Expert | [color-science-expert.md](color-science-expert.md) | Kleurruimtes, OKLCH, perceptuele interpolatie |
| Export Specialist | [export-specialist.md](export-specialist.md) | PNG, SVG, CSS output, WYSIWYG correctheid |
| Accessibility Expert | [accessibility-expert.md](accessibility-expert.md) | Keyboard navigatie, WCAG, schermlezer |
| Product Owner | [product-owner.md](product-owner.md) | MVP scope, prioritering, succesmaatstaven |

## Wanneer welke rol?

- **Nieuwe feature bespreken** → Product Owner + Architect
- **Implementatie reviewen** → Code Reviewer + Graphics Expert
- **UI ontwerpen** → Usability Expert + Accessibility Expert
- **Kleurproblemen** → Color Science Expert
- **Trage rendering** → Performance Expert + Shader Expert
- **Export klopt niet** → Export Specialist + Color Science Expert
