import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import {
  ChevronDown, Undo2, Redo2, Trash2, Plus, Shuffle, Contrast, Pipette,
  Import, FileBraces, MoreHorizontal, Copy, Check, ImageDown, HelpCircle,
} from 'lucide-react'
import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const CANVAS_W = 856
const CANVAS_H = 540
const MIN_ZOOM = 0.05
const MAX_ZOOM = 10
const ZOOM_STEP = 1.08
const INTER_W = 160
const INTER_H = 120
const MAX_HISTORY = 50
const LS_KEY = 'hazy-palettes'
const DEFAULT_WARP_R = 150
const MIN_WARP_R = 20
const INIT_FILTERS = { grain: 0, blur: 0, contrast: 100, brightness: 100, saturation: 100, hue: 0 }
const DEFAULT_RX = 280
const DEFAULT_RY = 280
const MIN_RADIUS = 20
const ROT_HANDLE_OFFSET = 28
const ROT_SNAP = Math.PI / 12  // 15°
const COLOR_DEFAULTS = ['#ff6b6b', '#4fc3f7', '#a29bfe', '#fdcb6e', '#55efc4', '#fd79a8', '#e17055', '#74b9ff']
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const THUMB_W = 64
const THUMB_H = Math.round(THUMB_W * CANVAS_H / CANVAS_W)
const DOCS_LS_KEY = 'hazy-documents'
const DOC_SAVE_DEBOUNCE = 600
const THUMB_DEBOUNCE = 400
const DEFAULT_DOC_NAME = 'Untitled'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 8) }

function hexToRgb(hex) {
  let h = (hex || '#000000').replace('#', '')
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  }
}

function seededRand(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000 }
}

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v =>
    Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  ).join('')
}

// Resolves any valid CSS color (hex, rgb(), hsl(), named color, ...) to a hex string
// by letting the browser's own CSS parser/computed style do the conversion.
let colorProbeEl = null
function resolveCssColor(str) {
  const s = (str || '').trim()
  if (!s) return null
  if (!colorProbeEl) {
    colorProbeEl = document.createElement('div')
    colorProbeEl.style.display = 'none'
    document.body.appendChild(colorProbeEl)
  }
  colorProbeEl.style.color = ''
  colorProbeEl.style.color = s
  if (!colorProbeEl.style.color) return null
  const m = getComputedStyle(colorProbeEl).color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return null
  return rgbToHex({ r: +m[1], g: +m[2], b: +m[3] })
}

// Extracts every recognizable color (hex, rgb()/hsl()/etc, named) from a pasted string
function parseColorsFromText(text) {
  const funcRe = /(?:rgba?|hsla?|hwb|lab|lch|oklch|oklab|color)\([^)]*\)/gi
  const functional = text.match(funcRe) || []
  const rest = text.replace(funcRe, ' ')
  const tokens = rest.split(/[\s,;\n\r\t]+/).map(t => t.trim()).filter(Boolean)
  const results = []
  const seen = new Set()
  for (const t of [...functional, ...tokens]) {
    const hex = resolveCssColor(t)
    if (hex && !seen.has(hex)) { seen.add(hex); results.push(hex) }
  }
  return results
}

function loadPalettes() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}
function writePalettes(p) { localStorage.setItem(LS_KEY, JSON.stringify(p)) }

// Checks whether an object has the shape of a Hazy document (colors/dots/background/size/warp/filters)
function isValidDocShape(doc) {
  return !!doc && typeof doc === 'object'
    && Array.isArray(doc.colors)
    && Array.isArray(doc.dots)
    && doc.background && typeof doc.background === 'object'
    && doc.size && typeof doc.size === 'object'
    && doc.warp && typeof doc.warp === 'object'
    && doc.filters && typeof doc.filters === 'object'
}

function isValidDocEntry(entry) {
  return !!entry && typeof entry === 'object'
    && typeof entry.id === 'string'
    && typeof entry.name === 'string'
    && isValidDocShape(entry.doc)
}

// Creates a brand-new document from the initial template, with fresh ids so colors/dots
// don't share references or ids with INIT_DOC or other documents.
function freshDoc() {
  const idMap = new Map()
  const colors = INIT_COLORS.map(c => {
    const id = uid()
    idMap.set(c.id, id)
    return { ...c, id }
  })
  const dots = INIT_DOTS.map(d => ({ ...d, id: uid(), colorId: idMap.get(d.colorId) }))
  return {
    ...structuredClone(INIT_DOC),
    colors,
    dots,
    warp: structuredClone(INIT_WARP),
  }
}


function buildCSSFilter({ blur, contrast, brightness, saturation, hue }) {
  const parts = []
  if (blur > 0) parts.push(`blur(${(blur * 0.2).toFixed(1)}px)`)
  if (contrast !== 100) parts.push(`contrast(${contrast}%)`)
  if (brightness !== 100) parts.push(`brightness(${brightness}%)`)
  if ((saturation ?? 100) !== 100) parts.push(`saturate(${saturation ?? 100}%)`)
  if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`)
  return parts.join(' ') || 'none'
}

// ─── Initial document ─────────────────────────────────────────────────────────

const INIT_COLORS = [
  { id: 'ca', hex: '#ff6b6b' },
  { id: 'cb', hex: '#4fc3f7' },
  { id: 'cc', hex: '#a29bfe' },
  { id: 'cd', hex: '#fdcb6e' },
]

const INIT_DOTS = [
  { id: 'da', colorId: 'ca', x: 214, y: 135, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
  { id: 'db', colorId: 'cb', x: 642, y: 135, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
  { id: 'dc', colorId: 'cc', x: 214, y: 405, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
  { id: 'dd', colorId: 'cd', x: 642, y: 405, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
]

const INIT_WARP = { warpDots: [], intensity: 100 }

const INIT_DOC = {
  background: { hex: '#050510', transparent: false },
  size: { w: CANVAS_W, h: CANVAS_H },
  sharpness: 2,
  colors: INIT_COLORS,
  dots: INIT_DOTS,
  warp: INIT_WARP,
  blurDots: [],
  filters: INIT_FILTERS,
}

// ─── Render pipeline ──────────────────────────────────────────────────────────

function renderMeshGradient(interCanvas, offCtx, { background, sharpness = 2, colors, dots }) {
  const W = offCtx.canvas.width, H = offCtx.canvas.height
  const IW = interCanvas.width, IH = interCanvas.height
  const scaleX = W / IW, scaleY = H / IH
  const p = sharpness

  const colorMap = {}
  colors.forEach(c => { colorMap[c.id] = c })

  const cpts = dots.map(dot => {
    const color = colorMap[dot.colorId]
    if (!color) return null
    const { r, g, b } = hexToRgb(color.hex)
    const theta = dot.theta ?? 0
    return {
      x: dot.x / scaleX, y: dot.y / scaleY,
      rx: (dot.rx ?? DEFAULT_RX) / scaleX,
      ry: (dot.ry ?? DEFAULT_RY) / scaleY,
      cosT: Math.cos(theta), sinT: Math.sin(theta),
      r, g, b,
    }
  }).filter(Boolean)

  offCtx.clearRect(0, 0, W, H)
  if (!background.transparent) {
    offCtx.fillStyle = background.hex
    offCtx.fillRect(0, 0, W, H)
  }

  if (cpts.length === 0) return

  const interCtx = interCanvas.getContext('2d')
  const imgData = new ImageData(IW, IH)
  const data = imgData.data
  const N = cpts.length

  for (let py = 0; py < IH; py++) {
    for (let px = 0; px < IW; px++) {
      let wSum = 0, rSum = 0, gSum = 0, bSum = 0

      for (let i = 0; i < N; i++) {
        const pt = cpts[i]
        const dx = px - pt.x, dy = py - pt.y
        const d2 = dx * dx + dy * dy
        if (d2 < 0.25) { rSum = pt.r; gSum = pt.g; bSum = pt.b; wSum = 1; break }
        // Rotate into ellipse-local space, compute Mahalanobis distance
        const ex = dx * pt.cosT + dy * pt.sinT
        const ey = -dx * pt.sinT + dy * pt.cosT
        const dM2 = (ex * ex) / (pt.rx * pt.rx) + (ey * ey) / (pt.ry * pt.ry)
        const w = Math.exp(-dM2 * p)
        rSum += pt.r * w; gSum += pt.g * w; bSum += pt.b * w; wSum += w
      }

      const idx = (py * IW + px) << 2
      if (wSum < 1e-10) {
        // Outside all ellipses — transparent so background shows through
        data[idx] = 0; data[idx+1] = 0; data[idx+2] = 0; data[idx+3] = 0
      } else {
        data[idx]   = (rSum / wSum + 0.5) | 0
        data[idx+1] = (gSum / wSum + 0.5) | 0
        data[idx+2] = (bSum / wSum + 0.5) | 0
        data[idx+3] = 255
      }
    }
  }

  interCtx.putImageData(imgData, 0, 0)
  offCtx.save()
  offCtx.imageSmoothingEnabled = true
  offCtx.imageSmoothingQuality = 'high'
  offCtx.drawImage(interCanvas, 0, 0, W, H)
  offCtx.restore()
}

function applyWarp(visCtx, offscreen, { warpDots = [], intensity = 100 }) {
  const scale = intensity / 100
  const W = offscreen.width, H = offscreen.height

  const active = warpDots.filter(d => d.dx !== 0 || d.dy !== 0)
  if (!active.length || scale === 0) {
    visCtx.clearRect(0, 0, W, H)
    visCtx.drawImage(offscreen, 0, 0)
    return
  }

  const offCtx = offscreen.getContext('2d')
  const src = offCtx.getImageData(0, 0, W, H).data
  const destImg = new ImageData(W, H)
  const dest = destImg.data

  const dots = active.map(d => {
    const theta = d.theta ?? 0
    const rx = Math.max(1, d.rx ?? DEFAULT_WARP_R)
    const ry = Math.max(1, d.ry ?? DEFAULT_WARP_R)
    return {
      x: d.x, y: d.y,
      dx: d.dx * scale, dy: d.dy * scale,
      cosT: Math.cos(theta), sinT: Math.sin(theta),
      rx2: rx * rx, ry2: ry * ry,
    }
  })
  const n = dots.length

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let dxSum = 0, dySum = 0
      for (let i = 0; i < n; i++) {
        const d = dots[i]
        const rawX = px - d.x, rawY = py - d.y
        const ex = rawX * d.cosT + rawY * d.sinT
        const ey = -rawX * d.sinT + rawY * d.cosT
        const w = Math.exp(-(ex * ex) / d.rx2 - (ey * ey) / d.ry2)
        dxSum += d.dx * w
        dySum += d.dy * w
      }
      let sx = (px - dxSum + 0.5) | 0
      let sy = (py - dySum + 0.5) | 0
      if (sx < 0) sx = 0; else if (sx >= W) sx = W - 1
      if (sy < 0) sy = 0; else if (sy >= H) sy = H - 1
      const si = (sy * W + sx) << 2, di = (py * W + px) << 2
      dest[di] = src[si]; dest[di+1] = src[si+1]; dest[di+2] = src[si+2]; dest[di+3] = src[si+3]
    }
  }

  visCtx.clearRect(0, 0, W, H)
  visCtx.putImageData(destImg, 0, 0)
}

function applyMotionBlur(visCtx, offscreen, blurDots = []) {
  const W = offscreen.width, H = offscreen.height
  const active = blurDots.filter(d => d.dx !== 0 || d.dy !== 0)
  if (!active.length) {
    visCtx.clearRect(0, 0, W, H)
    visCtx.drawImage(offscreen, 0, 0)
    return
  }

  const offCtx = offscreen.getContext('2d')
  const src = offCtx.getImageData(0, 0, W, H).data
  const dest = new ImageData(W, H)
  const d = dest.data
  const SAMPLES = 12

  const dots = active.map(dot => {
    const theta = dot.theta ?? 0
    return {
      x: dot.x, y: dot.y,
      dx: dot.dx, dy: dot.dy,
      cosT: Math.cos(theta), sinT: Math.sin(theta),
      rx2: Math.max(1, (dot.rx ?? DEFAULT_WARP_R) ** 2),
      ry2: Math.max(1, (dot.ry ?? DEFAULT_WARP_R) ** 2),
    }
  })
  const n = dots.length

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let wdx = 0, wdy = 0
      for (let i = 0; i < n; i++) {
        const dot = dots[i]
        const rawX = px - dot.x, rawY = py - dot.y
        const ex = rawX * dot.cosT + rawY * dot.sinT
        const ey = -rawX * dot.sinT + rawY * dot.cosT
        const w = Math.exp(-(ex * ex) / dot.rx2 - (ey * ey) / dot.ry2)
        wdx += dot.dx * w
        wdy += dot.dy * w
      }

      const di = (py * W + px) << 2
      if (Math.abs(wdx) < 0.5 && Math.abs(wdy) < 0.5) {
        d[di] = src[di]; d[di+1] = src[di+1]; d[di+2] = src[di+2]; d[di+3] = src[di+3]
        continue
      }

      let rS = 0, gS = 0, bS = 0, aS = 0
      for (let s = 0; s < SAMPLES; s++) {
        const t = s / (SAMPLES - 1) - 0.5
        let sx = (px + wdx * t + 0.5) | 0
        let sy = (py + wdy * t + 0.5) | 0
        if (sx < 0) sx = 0; else if (sx >= W) sx = W - 1
        if (sy < 0) sy = 0; else if (sy >= H) sy = H - 1
        const si = (sy * W + sx) << 2
        rS += src[si]; gS += src[si+1]; bS += src[si+2]; aS += src[si+3]
      }
      d[di] = (rS / SAMPLES + 0.5) | 0
      d[di+1] = (gS / SAMPLES + 0.5) | 0
      d[di+2] = (bS / SAMPLES + 0.5) | 0
      d[di+3] = (aS / SAMPLES + 0.5) | 0
    }
  }

  visCtx.clearRect(0, 0, W, H)
  visCtx.putImageData(dest, 0, 0)
}

// ─── WCAG contrast heatmap ───────────────────────────────────────────────────

const CONTRAST_THRESHOLDS = {
  AA: { normal: 4.5, large: 3 },
  AAA: { normal: 7, large: 4.5 },
}

function srgbToLinear(c) {
  c /= 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// Returns a low-res canvas color-coding each region by which text color (white/black)
// meets the requested WCAG contrast threshold:
//   green = both work, blue = white only, amber = black only, red = neither
function computeContrastHeatmap(srcCanvas, level, size) {
  const W = srcCanvas.width, H = srcCanvas.height
  const DS = 6
  const ow = Math.max(1, Math.ceil(W / DS))
  const oh = Math.max(1, Math.ceil(H / DS))
  const src = srcCanvas.getContext('2d').getImageData(0, 0, W, H).data
  const threshold = CONTRAST_THRESHOLDS[level][size]

  const out = document.createElement('canvas')
  out.width = ow; out.height = oh
  const octx = out.getContext('2d')
  const img = octx.createImageData(ow, oh)
  const d = img.data

  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(W - 1, x * DS)
      const sy = Math.min(H - 1, y * DS)
      const si = (sy * W + sx) << 2
      const L = 0.2126 * srgbToLinear(src[si]) + 0.7152 * srgbToLinear(src[si + 1]) + 0.0722 * srgbToLinear(src[si + 2])
      const contrastWhite = 1.05 / (L + 0.05)
      const contrastBlack = (L + 0.05) / 0.05
      const whiteOk = contrastWhite >= threshold
      const blackOk = contrastBlack >= threshold

      let r, g, b
      if (whiteOk && blackOk) { r = 34; g = 197; b = 94 }
      else if (whiteOk) { r = 59; g = 130; b = 246 }
      else if (blackOk) { r = 234; g = 179; b = 8 }
      else { r = 239; g = 68; b = 68 }

      const di = (y * ow + x) << 2
      d[di] = r; d[di + 1] = g; d[di + 2] = b; d[di + 3] = 255
    }
  }

  octx.putImageData(img, 0, 0)
  return out
}


// ─── Section ──────────────────────────────────────────────────────────────────

function Section({ title, defaultOpen = false, tourId, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-white/[0.07]" data-tour={tourId}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35 hover:text-white/60 hover:bg-white/[0.04] transition-colors select-none"
      >
        {title}<ChevronDown size={13} strokeWidth={2.5}
          style={{ transition: 'transform 0.18s ease', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
      </button>
      <div style={{
        overflow: 'hidden',
        maxHeight: open ? 1600 : 0,
        opacity: open ? 1 : 0,
        transition: 'max-height 0.22s ease, opacity 0.18s ease',
      }}>
        <div className="px-4 pt-1 pb-4">{children}</div>
      </div>
    </div>
  )
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

function Toggle({ on, onChange, label }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <div onClick={() => onChange(!on)} style={{
        width: 28, height: 16, borderRadius: 8,
        background: on ? 'rgba(139,92,246,0.7)' : 'rgba(255,255,255,0.1)',
        position: 'relative', flexShrink: 0, transition: 'background 0.15s',
      }}>
        <div style={{
          position: 'absolute', top: 2, width: 12, height: 12,
          borderRadius: '50%', background: 'white', transition: 'left 0.15s',
          left: on ? 14 : 2,
        }} />
      </div>
      <span className="text-[10px] text-white/30">{label}</span>
    </label>
  )
}

// ─── ColorRow ─────────────────────────────────────────────────────────────────

function ColorRow({ label, color, isActive, onActivate, onChange, onDelete }) {
  const pickerRef = useRef(null)
  const [hexDraft, setHexDraft] = useState(color.hex)
  useEffect(() => setHexDraft(color.hex), [color.hex])

  function commitHex(val) {
    const c = /^#/.test(val) ? val : '#' + val
    if (/^#[0-9a-fA-F]{6}$/.test(c)) onChange({ ...color, hex: c.toLowerCase() })
    else setHexDraft(color.hex)
  }

  return (
    <div
      className={`flex items-center gap-1.5 mb-1 px-1.5 py-1 rounded-md cursor-pointer transition-colors ${
        isActive ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
      }`}
      onClick={onActivate}
    >
      {/* Active dot */}
      <div style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        background: isActive ? 'white' : 'transparent',
        border: `1.5px solid rgba(255,255,255,${isActive ? 0.9 : 0.2})`,
        transition: 'background 0.12s',
      }} />

      {/* Label */}
      <span className="text-[11px] font-semibold text-white/40 w-4 text-center shrink-0">{label}</span>

      {/* Swatch */}
      <div
        onClick={e => { e.stopPropagation(); pickerRef.current?.click() }}
        style={{
          width: 20, height: 20, borderRadius: 4, flexShrink: 0,
          background: color.hex, border: '1.5px solid rgba(255,255,255,0.12)', cursor: 'pointer',
        }}
      />
      <input ref={pickerRef} type="color" value={color.hex}
        onChange={e => onChange({ ...color, hex: e.target.value })}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }} />

      {/* Hex input */}
      <input
        value={hexDraft}
        onChange={e => setHexDraft(e.target.value)}
        onBlur={e => commitHex(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && commitHex(hexDraft)}
        onClick={e => e.stopPropagation()}
        maxLength={7}
        className="font-mono text-[11px] text-white/60 bg-white/[0.05] border border-white/[0.08] rounded px-1.5 py-0.5 outline-none focus:border-white/20 flex-1 min-w-0"
        spellCheck={false}
      />

      {/* Delete */}
      <button
        onClick={e => { e.stopPropagation(); onDelete() }}
        className="text-white/20 hover:text-red-400 transition-colors shrink-0"
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}


// ─── FileRailItem ─────────────────────────────────────────────────────────────

function FileRailItem({ entry, isActive, onSelect, onRename, canDelete, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.name)
  const inputRef = useRef(null)

  useEffect(() => {
    if (editing) {
      setDraft(entry.name)
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
    }
  }, [editing])

  function commit() {
    setEditing(false)
    onRename(draft)
  }

  return (
    <div className="relative w-full group shrink-0">
      <button
        onClick={onSelect}
        onDoubleClick={() => setEditing(true)}
        title={entry.name}
        className={`w-full aspect-[8/5] rounded overflow-hidden border-2 transition-colors ${
          isActive ? 'border-white' : 'border-white/10 hover:border-white/30'
        }`}
        style={{ background: '#1c1c1c' }}
      >
        {entry.thumbnail
          ? <img src={entry.thumbnail} alt={entry.name} className="w-full h-full object-cover" />
          : <div className="w-full h-full" />}
      </button>
      {canDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Delete"
          className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full bg-[#222] border border-white/15 text-white/50 hover:text-red-400 hover:border-red-400/40 transition-colors"
        >
          <Trash2 size={11} />
        </button>
      )}
      {editing && (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          className="absolute left-0 top-full mt-0.5 w-full z-10 text-[9px] text-center bg-[#0d0d0d] border border-white/20 rounded px-0.5 py-0.5 outline-none focus:border-white/40 text-white/80"
        />
      )}
    </div>
  )
}


// ─── FilterSlider ─────────────────────────────────────────────────────────────

function FilterSlider({ label, value, min, max, step = 1, unit, onChange }) {
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-[10px] text-white/40 uppercase tracking-wide">{label}</span>
        <span className="text-[10px] text-white/35 tabular-nums">{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)}
        className="w-full accent-violet-400"
        style={{ cursor: 'pointer' }} />
    </div>
  )
}

let dotClipboard = null

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {

  // ── Documents ────────────────────────────────────────────────────────────────

  const [documents, setDocuments] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DOCS_LS_KEY) || 'null')
      if (Array.isArray(raw) && raw.length && raw.every(isValidDocEntry)) {
        return raw.map(d => ({ ...d, past: [], future: [], thumbnail: d.thumbnail ?? null }))
      }
    } catch {}
    return [{ id: uid(), name: DEFAULT_DOC_NAME, doc: INIT_DOC, past: [], future: [], thumbnail: null }]
  })
  const [activeDocId, setActiveDocId] = useState(documents[0].id)
  const activeDoc = documents.find(d => d.id === activeDocId) ?? documents[0]

  // ── History ─────────────────────────────────────────────────────────────────

  const [past, setPast] = useState(activeDoc.past ?? [])
  const [present, _setPresent] = useState(activeDoc.doc)
  const [future, setFuture] = useState(activeDoc.future ?? [])
  const presentRef = useRef(activeDoc.doc)

  function syncPresent(doc) { presentRef.current = doc; _setPresent(doc) }
  function commit(doc) {
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), presentRef.current])
    setFuture([])
    syncPresent(doc)
  }
  function liveUpdate(doc) { syncPresent(doc) }

  function undo() {
    if (!past.length) return
    const prev = past[past.length - 1]
    setFuture(f => [presentRef.current, ...f])
    setPast(p => p.slice(0, -1))
    syncPresent(prev)
  }
  function redo() {
    if (!future.length) return
    const next = future[0]
    setPast(p => [...p, presentRef.current])
    setFuture(f => f.slice(1))
    syncPresent(next)
  }

  const cW = present.size?.w ?? CANVAS_W
  const cH = present.size?.h ?? CANVAS_H

  // ── View ─────────────────────────────────────────────────────────────────────

  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } })
  const [view, _setView] = useState({ zoom: 1, pan: { x: 0, y: 0 } })
  function setView(v) { viewRef.current = v; _setView(v) }

  // ── Refs ─────────────────────────────────────────────────────────────────────

  const canvasRef = useRef(null)
  const mainRef = useRef(null)

  const offscreenRef = useRef(null)
  if (!offscreenRef.current) {
    const c = document.createElement('canvas')
    c.width = CANVAS_W; c.height = CANVAS_H
    offscreenRef.current = c
  }

  const interRef = useRef(null)
  if (!interRef.current) {
    const c = document.createElement('canvas')
    c.width = INTER_W; c.height = INTER_H
    interRef.current = c
  }

  const warpedRef = useRef(null)
  if (!warpedRef.current) {
    const c = document.createElement('canvas')
    c.width = CANVAS_W; c.height = CANVAS_H
    warpedRef.current = c
  }

  const contrastRef = useRef(null)
  const importInputRef = useRef(null)
  const fileMenuRef = useRef(null)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [copiedPNG, setCopiedPNG] = useState(false)

  const panDrag = useRef(false)
  const panLast = useRef({ x: 0, y: 0 })
  const dotDrag = useRef(null)
  const warpDotDrag = useRef(null)
  const blurDotDrag = useRef(null)
  const ellipseDrag = useRef(null)
  const groupRotDrag = useRef(null)
  const pinchDist = useRef(null)
  const spaceHeld = useRef(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [boxSelect, setBoxSelect] = useState(null)
  const boxSelectRef = useRef(null)

  // ── UI state ─────────────────────────────────────────────────────────────────

  const [mode, setMode] = useState('compose')
  const [activeColorId, setActiveColorId] = useState(activeDoc.doc.colors[0]?.id ?? null)
  const [selectedDotIds, _setSelectedDotIds] = useState(() => new Set())
  const selectedDotIdsRef = useRef(new Set())
  function setSelectedDotIds(val) {
    const next = typeof val === 'function' ? val(selectedDotIdsRef.current) : val
    selectedDotIdsRef.current = next
    _setSelectedDotIds(next)
  }
  const [selectedWarpDotIds, _setSelectedWarpDotIds] = useState(() => new Set())
  const selectedWarpDotIdsRef = useRef(new Set())
  function setSelectedWarpDotIds(val) {
    const next = typeof val === 'function' ? val(selectedWarpDotIdsRef.current) : val
    selectedWarpDotIdsRef.current = next
    _setSelectedWarpDotIds(next)
  }
  const [selectedBlurDotIds, _setSelectedBlurDotIds] = useState(() => new Set())
  const selectedBlurDotIdsRef = useRef(new Set())
  function setSelectedBlurDotIds(val) {
    const next = typeof val === 'function' ? val(selectedBlurDotIdsRef.current) : val
    selectedBlurDotIdsRef.current = next
    _setSelectedBlurDotIds(next)
  }
  const [paletteName, setPaletteName] = useState('')
  const [savedPalettes, setSavedPalettes] = useState(loadPalettes)
  const [wDraft, setWDraft] = useState(String(CANVAS_W))
  const [hDraft, setHDraft] = useState(String(CANVAS_H))
  const [contrastCheck, setContrastCheck] = useState(false)
  const [contrastLevel, setContrastLevel] = useState('AA')
  const [contrastSize, setContrastSize] = useState('normal')

  // ── Document operations ────────────────────────────────────────────────────────

  function resetDocUIState(doc) {
    setSelectedDotIds(new Set())
    setSelectedWarpDotIds(new Set())
    setSelectedBlurDotIds(new Set())
    setActiveColorId(doc.colors[0]?.id ?? null)
    setMode('compose')
    setView({ zoom: 1, pan: { x: 0, y: 0 } })
  }

  function switchDocument(targetId) {
    if (targetId === activeDocId) return
    const target = documents.find(d => d.id === targetId)
    if (!target) return
    const currentDoc = presentRef.current
    setDocuments(docs => docs.map(d => d.id === activeDocId
      ? { ...d, doc: currentDoc, past, future }
      : d))
    setPast(target.past ?? [])
    setFuture(target.future ?? [])
    syncPresent(target.doc)
    setActiveDocId(targetId)
    resetDocUIState(target.doc)
  }

  function addDocument() {
    const currentDoc = presentRef.current
    const newDoc = freshDoc()
    const newEntry = { id: uid(), name: DEFAULT_DOC_NAME, doc: newDoc, past: [], future: [], thumbnail: null }
    setDocuments(docs => [
      ...docs.map(d => d.id === activeDocId
        ? { ...d, doc: currentDoc, past, future }
        : d),
      newEntry,
    ])
    setPast([])
    setFuture([])
    syncPresent(newDoc)
    setActiveDocId(newEntry.id)
    resetDocUIState(newDoc)
  }

  function deleteDocument(id) {
    if (documents.length <= 1) return
    const target = documents.find(d => d.id === id)
    if (!target) return
    if (!window.confirm(`Delete "${target.name}"?`)) return
    if (id === activeDocId) {
      const idx = documents.findIndex(d => d.id === id)
      const neighbor = documents[idx - 1] ?? documents[idx + 1]
      setDocuments(docs => docs.filter(d => d.id !== id))
      setPast(neighbor.past ?? [])
      setFuture(neighbor.future ?? [])
      syncPresent(neighbor.doc)
      setActiveDocId(neighbor.id)
      resetDocUIState(neighbor.doc)
    } else {
      setDocuments(docs => docs.filter(d => d.id !== id))
    }
  }

  function renameDocument(id, name) {
    const trimmed = name.trim()
    if (!trimmed) return
    setDocuments(docs => docs.map(d => d.id === id ? { ...d, name: trimmed } : d))
  }

  // ── Canvas render ─────────────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const offscreen = offscreenRef.current
    const inter = interRef.current
    const warped = warpedRef.current
    if (!canvas || !offscreen || !inter || !warped) return
    if (offscreen.width !== cW || offscreen.height !== cH) {
      offscreen.width = cW; offscreen.height = cH
    }
    if (inter.width !== cW || inter.height !== cH) {
      inter.width = cW; inter.height = cH
    }
    if (warped.width !== cW || warped.height !== cH) {
      warped.width = cW; warped.height = cH
    }
    const offCtx = offscreen.getContext('2d')
    renderMeshGradient(inter, offCtx, present)
    const warpedCtx = warped.getContext('2d')
    applyWarp(warpedCtx, offscreen, present.warp)
    const ctx = canvas.getContext('2d')
    applyMotionBlur(ctx, warped, present.blurDots ?? [])

    const contrastCanvas = contrastRef.current
    if (contrastCanvas) {
      if (contrastCanvas.width !== cW || contrastCanvas.height !== cH) {
        contrastCanvas.width = cW; contrastCanvas.height = cH
      }
      const cctx = contrastCanvas.getContext('2d')
      cctx.clearRect(0, 0, cW, cH)
      if (contrastCheck) {
        const heat = computeContrastHeatmap(canvas, contrastLevel, contrastSize)
        cctx.imageSmoothingEnabled = false
        cctx.drawImage(heat, 0, 0, cW, cH)
      }
    }
  }, [present, contrastCheck, contrastLevel, contrastSize])

  // ── Thumbnail capture ────────────────────────────────────────────────────────

  useEffect(() => {
    const id = setTimeout(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const thumb = document.createElement('canvas')
      thumb.width = THUMB_W
      thumb.height = THUMB_H
      thumb.getContext('2d').drawImage(canvas, 0, 0, THUMB_W, THUMB_H)
      const dataUrl = thumb.toDataURL('image/png')
      setDocuments(docs => docs.map(d => d.id === activeDocId ? { ...d, thumbnail: dataUrl } : d))
    }, THUMB_DEBOUNCE)
    return () => clearTimeout(id)
  }, [present, activeDocId])

  // ── Document persistence ─────────────────────────────────────────────────────

  useEffect(() => {
    const id = setTimeout(() => {
      const toSave = documents.map(d => ({
        id: d.id,
        name: d.name,
        doc: d.id === activeDocId ? presentRef.current : d.doc,
        thumbnail: d.thumbnail ?? null,
      }))
      try {
        localStorage.setItem(DOCS_LS_KEY, JSON.stringify(toSave))
      } catch (err) {
        console.warn('Failed to save documents to localStorage', err)
      }
    }, DOC_SAVE_DEBOUNCE)
    return () => clearTimeout(id)
  }, [documents, present, activeDocId])

  // ── Wheel zoom ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    function onWheel(e) {
      e.preventDefault()
      const { zoom, pan } = viewRef.current
      const rect = el.getBoundingClientRect()
      const ox = e.clientX - rect.left - rect.width / 2
      const oy = e.clientY - rect.top - rect.height / 2
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
      const s = newZoom / zoom
      setView({ zoom: newZoom, pan: { x: ox + (pan.x - ox) * s, y: oy + (pan.y - oy) * s } })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Space key (pan mode) ──────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e) {
      if (e.code === 'Space' && !e.target.matches('input, textarea')) {
        e.preventDefault()
        if (!spaceHeld.current) { spaceHeld.current = true; setSpaceDown(true) }
      }
    }
    function onKeyUp(e) {
      if (e.code === 'Space') { spaceHeld.current = false; setSpaceDown(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  // ── Canvas coordinate conversion ──────────────────────────────────────────────

  function viewportToCanvas(clientX, clientY) {
    const rect = canvasRef.current.getBoundingClientRect()
    const zoom = viewRef.current.zoom
    return {
      x: (clientX - rect.left) / zoom,
      y: (clientY - rect.top) / zoom,
    }
  }

  function canvasToViewport(cx, cy) {
    const mainRect = mainRef.current.getBoundingClientRect()
    const canvasRect = canvasRef.current.getBoundingClientRect()
    return {
      x: (canvasRect.left - mainRect.left) + cx * view.zoom,
      y: (canvasRect.top - mainRect.top) + cy * view.zoom,
    }
  }

  // ── Canvas pan + click-to-place ────────────────────────────────────────────────

  function onMainPointerDown(e) {
    if (e.target.closest('button, input, select, [data-no-pan]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (spaceHeld.current) {
      panDrag.current = true
      panLast.current = { x: e.clientX, y: e.clientY }
    } else if (mode === 'compose' || mode === 'warp' || mode === 'blur') {
      const bs = { startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY, shiftKey: e.shiftKey }
      boxSelectRef.current = bs
      setBoxSelect({ ...bs })
    }
  }
  function onMainPointerMove(e) {
    if (panDrag.current) {
      const dx = e.clientX - panLast.current.x
      const dy = e.clientY - panLast.current.y
      panLast.current = { x: e.clientX, y: e.clientY }
      const v = viewRef.current
      setView({ ...v, pan: { x: v.pan.x + dx, y: v.pan.y + dy } })
    } else if (boxSelectRef.current) {
      boxSelectRef.current = { ...boxSelectRef.current, curX: e.clientX, curY: e.clientY }
      setBoxSelect({ ...boxSelectRef.current })
    }
  }
  function onMainPointerUp() {
    if (panDrag.current) {
      panDrag.current = false
      return
    }
    const bs = boxSelectRef.current
    if (!bs) return
    boxSelectRef.current = null
    setBoxSelect(null)
    const moved = Math.hypot(bs.curX - bs.startX, bs.curY - bs.startY) > 6
    const p1 = viewportToCanvas(Math.min(bs.startX, bs.curX), Math.min(bs.startY, bs.curY))
    const p2 = viewportToCanvas(Math.max(bs.startX, bs.curX), Math.max(bs.startY, bs.curY))
    if (mode === 'warp') {
      if (!moved) { setSelectedWarpDotIds(new Set()); return }
      const inside = new Set((presentRef.current.warp.warpDots ?? [])
        .filter(d => d.x >= p1.x && d.x <= p2.x && d.y >= p1.y && d.y <= p2.y)
        .map(d => d.id))
      setSelectedWarpDotIds(bs.shiftKey ? prev => new Set([...prev, ...inside]) : inside)
      return
    }
    if (mode === 'blur') {
      if (!moved) { setSelectedBlurDotIds(new Set()); return }
      const inside = new Set((presentRef.current.blurDots ?? [])
        .filter(d => d.x >= p1.x && d.x <= p2.x && d.y >= p1.y && d.y <= p2.y)
        .map(d => d.id))
      setSelectedBlurDotIds(bs.shiftKey ? prev => new Set([...prev, ...inside]) : inside)
      return
    }
    if (!moved) {
      setSelectedDotIds(new Set())
      return
    }
    const inside = new Set(presentRef.current.dots
      .filter(d => d.x >= p1.x && d.x <= p2.x && d.y >= p1.y && d.y <= p2.y)
      .map(d => d.id))
    setSelectedDotIds(bs.shiftKey ? prev => new Set([...prev, ...inside]) : inside)
  }

  function onMainDoubleClick(e) {
    if (e.target.closest('button, input, select, [data-no-pan]')) return
    const pos = viewportToCanvas(e.clientX, e.clientY)
    if (mode === 'warp') placeWarpDot(pos.x, pos.y)
    else if (mode === 'blur') placeBlurDot(pos.x, pos.y)
    else placeDot(pos.x, pos.y)
  }

  // ── Pinch ─────────────────────────────────────────────────────────────────────

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      const [a, b] = e.touches
      pinchDist.current = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    }
  }
  function onTouchMove(e) {
    if (e.touches.length !== 2) return
    e.preventDefault()
    const [a, b] = e.touches
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    if (pinchDist.current) {
      const v = viewRef.current
      setView({ ...v, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * dist / pinchDist.current)) })
    }
    pinchDist.current = dist
  }

  // ── Dot drag ──────────────────────────────────────────────────────────────────

  function onDotPointerDown(e, id) {
    e.stopPropagation()

    if (e.shiftKey) {
      // Shift-click toggles membership without starting a drag
      setSelectedDotIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
      })
      return
    }

    e.currentTarget.setPointerCapture(e.pointerId)

    // If the clicked dot isn't already selected, replace the selection
    const currentIds = selectedDotIdsRef.current
    const effectiveIds = currentIds.has(id) ? currentIds : new Set([id])
    if (!currentIds.has(id)) setSelectedDotIds(new Set([id]))

    // Record start position for every dot in the effective selection
    const startPositions = {}
    presentRef.current.dots.forEach(d => {
      if (effectiveIds.has(d.id)) startPositions[d.id] = { x: d.x, y: d.y }
    })
    dotDrag.current = { anchorId: id, startPositions, clientX: e.clientX, clientY: e.clientY, snapshot: presentRef.current }
  }
  function onDotPointerMove(e, id) {
    const dd = dotDrag.current
    if (!dd || dd.anchorId !== id) return
    const dx = (e.clientX - dd.clientX) / viewRef.current.zoom
    const dy = (e.clientY - dd.clientY) / viewRef.current.zoom
    liveUpdate({
      ...presentRef.current,
      dots: presentRef.current.dots.map(d => {
        const start = dd.startPositions[d.id]
        return start ? { ...d, x: start.x + dx, y: start.y + dy } : d
      }),
    })
  }
  function onDotPointerUp(e, id) {
    e.stopPropagation()
    const dd = dotDrag.current
    if (!dd || dd.anchorId !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), dd.snapshot])
    setFuture([])
    dotDrag.current = null
  }

  // ── Ellipse handle drag ───────────────────────────────────────────────────────

  function onEllipseHandlePointerDown(e, type) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const dot = presentRef.current.dots.find(d => d.id === [...selectedDotIdsRef.current][0])
    if (!dot) return
    const canvasPos = viewportToCanvas(e.clientX, e.clientY)
    ellipseDrag.current = {
      type,
      dotId: dot.id,
      snapshot: presentRef.current,
      prevAngle: Math.atan2(canvasPos.y - dot.y, canvasPos.x - dot.x),
    }
  }

  function onEllipseHandlePointerMove(e, type) {
    const ed = ellipseDrag.current
    if (!ed || ed.type !== type) return
    const dot = presentRef.current.dots.find(d => d.id === ed.dotId)
    if (!dot) return
    const canvasPos = viewportToCanvas(e.clientX, e.clientY)
    const dx = canvasPos.x - dot.x
    const dy = canvasPos.y - dot.y
    const theta = dot.theta ?? 0
    const updatedDot = { ...dot }

    if (type === 'rx') {
      const projected = dx * Math.cos(theta) + dy * Math.sin(theta)
      updatedDot.rx = Math.max(MIN_RADIUS, projected)
      if (e.shiftKey) updatedDot.ry = updatedDot.rx
    } else if (type === 'ry') {
      const projected = -dx * Math.sin(theta) + dy * Math.cos(theta)
      updatedDot.ry = Math.max(MIN_RADIUS, projected)
      if (e.shiftKey) updatedDot.rx = updatedDot.ry
    } else if (type === 'rot') {
      const currentAngle = Math.atan2(dy, dx)
      let delta = currentAngle - ed.prevAngle
      // Clamp to [-π, π] to avoid jumps when crossing ±180°
      if (delta > Math.PI) delta -= 2 * Math.PI
      else if (delta < -Math.PI) delta += 2 * Math.PI
      updatedDot.theta = theta + delta
      ed.prevAngle = currentAngle
    }

    liveUpdate({
      ...presentRef.current,
      dots: presentRef.current.dots.map(d => d.id === ed.dotId ? updatedDot : d),
    })
  }

  function onEllipseHandlePointerUp(e, type) {
    e.stopPropagation()
    const ed = ellipseDrag.current
    if (!ed || ed.type !== type) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), ed.snapshot])
    setFuture([])
    ellipseDrag.current = null
  }

  // ── Warp dot drag ─────────────────────────────────────────────────────────────

  function onWarpDotBodyPointerDown(e, id) {
    e.stopPropagation()
    if (e.shiftKey) {
      setSelectedWarpDotIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const prevSel = selectedWarpDotIdsRef.current
    const selIds = prevSel.has(id) ? prevSel : new Set([id])
    if (!prevSel.has(id)) setSelectedWarpDotIds(selIds)
    const starts = {}
    for (const sid of selIds) {
      const dot = presentRef.current.warp.warpDots.find(d => d.id === sid)
      if (dot) starts[sid] = { x: dot.x, y: dot.y }
    }
    warpDotDrag.current = { type: 'body', id, starts, clientX: e.clientX, clientY: e.clientY, snapshot: presentRef.current }
  }
  function onWarpDotBodyPointerMove(e, id) {
    const wd = warpDotDrag.current
    if (!wd || wd.type !== 'body' || wd.id !== id) return
    const dx = (e.clientX - wd.clientX) / viewRef.current.zoom
    const dy = (e.clientY - wd.clientY) / viewRef.current.zoom
    liveUpdate({
      ...presentRef.current,
      warp: {
        ...presentRef.current.warp,
        warpDots: presentRef.current.warp.warpDots.map(d => {
          const s = wd.starts[d.id]
          return s ? { ...d, x: s.x + dx, y: s.y + dy } : d
        }),
      },
    })
  }
  function onWarpDotBodyPointerUp(e, id) {
    e.stopPropagation()
    const wd = warpDotDrag.current
    if (!wd || wd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), wd.snapshot])
    setFuture([])
    warpDotDrag.current = null
  }

  function onWarpArrowPointerDown(e, id) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedWarpDotIds(new Set([id]))
    warpDotDrag.current = { type: 'arrow', id, snapshot: presentRef.current }
  }
  function onWarpArrowPointerMove(e, id) {
    const wd = warpDotDrag.current
    if (!wd || wd.type !== 'arrow' || wd.id !== id) return
    const dot = presentRef.current.warp.warpDots.find(d => d.id === id)
    if (!dot) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    liveUpdate({
      ...presentRef.current,
      warp: {
        ...presentRef.current.warp,
        warpDots: presentRef.current.warp.warpDots.map(d =>
          d.id === id ? { ...d, dx: cp.x - dot.x, dy: cp.y - dot.y } : d
        ),
      },
    })
  }
  function onWarpArrowPointerUp(e, id) {
    e.stopPropagation()
    const wd = warpDotDrag.current
    if (!wd || wd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), wd.snapshot])
    setFuture([])
    warpDotDrag.current = null
  }

  function onWarpEllipsePointerDown(e, id, type) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedWarpDotIds(new Set([id]))
    const dot = presentRef.current.warp.warpDots.find(d => d.id === id)
    if (!dot) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    warpDotDrag.current = {
      type, id,
      snapshot: presentRef.current,
      prevAngle: Math.atan2(cp.y - dot.y, cp.x - dot.x),
    }
  }
  function onWarpEllipsePointerMove(e, id, type) {
    const wd = warpDotDrag.current
    if (!wd || wd.type !== type || wd.id !== id) return
    const dot = presentRef.current.warp.warpDots.find(d => d.id === id)
    if (!dot) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    const dx = cp.x - dot.x, dy = cp.y - dot.y
    const theta = dot.theta ?? 0
    const updated = { ...dot }
    if (type === 'rx') {
      updated.rx = Math.max(MIN_WARP_R, dx * Math.cos(theta) + dy * Math.sin(theta))
      if (e.shiftKey) updated.ry = updated.rx
    } else if (type === 'ry') {
      updated.ry = Math.max(MIN_WARP_R, -dx * Math.sin(theta) + dy * Math.cos(theta))
      if (e.shiftKey) updated.rx = updated.ry
    } else if (type === 'rot') {
      const cur = Math.atan2(dy, dx)
      let delta = cur - wd.prevAngle
      if (delta > Math.PI) delta -= 2 * Math.PI
      else if (delta < -Math.PI) delta += 2 * Math.PI
      const raw = theta + delta
      updated.theta = e.shiftKey ? Math.round(raw / ROT_SNAP) * ROT_SNAP : raw
      wd.prevAngle = cur
    }
    liveUpdate({
      ...presentRef.current,
      warp: {
        ...presentRef.current.warp,
        warpDots: presentRef.current.warp.warpDots.map(d => d.id === id ? updated : d),
      },
    })
  }
  function onWarpEllipsePointerUp(e, id) {
    e.stopPropagation()
    const wd = warpDotDrag.current
    if (!wd || wd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), wd.snapshot])
    setFuture([])
    warpDotDrag.current = null
  }

  // ── Blur dot drag ─────────────────────────────────────────────────────────────

  function onBlurDotBodyPointerDown(e, id) {
    e.stopPropagation()
    if (e.shiftKey) {
      setSelectedBlurDotIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const prevSel = selectedBlurDotIdsRef.current
    const selIds = prevSel.has(id) ? prevSel : new Set([id])
    if (!prevSel.has(id)) setSelectedBlurDotIds(selIds)
    const starts = {}
    for (const sid of selIds) {
      const dot = presentRef.current.blurDots.find(d => d.id === sid)
      if (dot) starts[sid] = { x: dot.x, y: dot.y }
    }
    blurDotDrag.current = { type: 'body', id, starts, clientX: e.clientX, clientY: e.clientY, snapshot: presentRef.current }
  }
  function onBlurDotBodyPointerMove(e, id) {
    const bd = blurDotDrag.current
    if (!bd || bd.type !== 'body' || bd.id !== id) return
    const dx = (e.clientX - bd.clientX) / viewRef.current.zoom
    const dy = (e.clientY - bd.clientY) / viewRef.current.zoom
    liveUpdate({
      ...presentRef.current,
      blurDots: presentRef.current.blurDots.map(d => {
        const s = bd.starts[d.id]
        return s ? { ...d, x: s.x + dx, y: s.y + dy } : d
      }),
    })
  }
  function onBlurDotBodyPointerUp(e, id) {
    e.stopPropagation()
    const bd = blurDotDrag.current
    if (!bd || bd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), bd.snapshot])
    setFuture([])
    blurDotDrag.current = null
  }

  function onBlurArrowPointerDown(e, id) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedBlurDotIds(new Set([id]))
    blurDotDrag.current = { type: 'arrow', id, snapshot: presentRef.current }
  }
  function onBlurArrowPointerMove(e, id) {
    const bd = blurDotDrag.current
    if (!bd || bd.type !== 'arrow' || bd.id !== id) return
    const dot = presentRef.current.blurDots.find(d => d.id === id)
    if (!dot) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    liveUpdate({
      ...presentRef.current,
      blurDots: presentRef.current.blurDots.map(d =>
        d.id === id ? { ...d, dx: cp.x - dot.x, dy: cp.y - dot.y } : d
      ),
    })
  }
  function onBlurArrowPointerUp(e, id) {
    e.stopPropagation()
    const bd = blurDotDrag.current
    if (!bd || bd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), bd.snapshot])
    setFuture([])
    blurDotDrag.current = null
  }

  function onBlurEllipsePointerDown(e, id, type) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedBlurDotIds(new Set([id]))
    const dot = presentRef.current.blurDots.find(d => d.id === id)
    if (!dot) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    blurDotDrag.current = { type, id, snapshot: presentRef.current, prevAngle: Math.atan2(cp.y - dot.y, cp.x - dot.x) }
  }
  function onBlurEllipsePointerMove(e, id, type) {
    const bd = blurDotDrag.current
    if (!bd || bd.type !== type || bd.id !== id) return
    const dot = presentRef.current.blurDots.find(d => d.id === id)
    if (!dot) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    const dx = cp.x - dot.x, dy = cp.y - dot.y
    const theta = dot.theta ?? 0
    const updated = { ...dot }
    if (type === 'rx') {
      updated.rx = Math.max(MIN_WARP_R, dx * Math.cos(theta) + dy * Math.sin(theta))
      if (e.shiftKey) updated.ry = updated.rx
    } else if (type === 'ry') {
      updated.ry = Math.max(MIN_WARP_R, -dx * Math.sin(theta) + dy * Math.cos(theta))
      if (e.shiftKey) updated.rx = updated.ry
    } else if (type === 'rot') {
      const cur = Math.atan2(dy, dx)
      let delta = cur - bd.prevAngle
      if (delta > Math.PI) delta -= 2 * Math.PI
      else if (delta < -Math.PI) delta += 2 * Math.PI
      const raw = theta + delta
      updated.theta = e.shiftKey ? Math.round(raw / ROT_SNAP) * ROT_SNAP : raw
      bd.prevAngle = cur
    }
    liveUpdate({ ...presentRef.current, blurDots: presentRef.current.blurDots.map(d => d.id === id ? updated : d) })
  }
  function onBlurEllipsePointerUp(e, id) {
    e.stopPropagation()
    const bd = blurDotDrag.current
    if (!bd || bd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), bd.snapshot])
    setFuture([])
    blurDotDrag.current = null
  }

  // ── Group rotation (warp + blur) ──────────────────────────────────────────────

  function startGroupRot(e, dotMode, dots) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const cx = (Math.min(...dots.map(d => d.x)) + Math.max(...dots.map(d => d.x))) / 2
    const cy = (Math.min(...dots.map(d => d.y)) + Math.max(...dots.map(d => d.y))) / 2
    const cp = viewportToCanvas(e.clientX, e.clientY)
    groupRotDrag.current = {
      dotMode,
      centroid: { x: cx, y: cy },
      initAngle: Math.atan2(cp.y - cy, cp.x - cx),
      starts: dots.map(d => ({ id: d.id, x: d.x, y: d.y, theta: d.theta ?? 0 })),
      snapshot: presentRef.current,
    }
  }

  function onGroupRotPointerMove(e) {
    const gr = groupRotDrag.current
    if (!gr) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    let delta = Math.atan2(cp.y - gr.centroid.y, cp.x - gr.centroid.x) - gr.initAngle
    if (delta > Math.PI) delta -= 2 * Math.PI
    else if (delta < -Math.PI) delta += 2 * Math.PI
    if (e.shiftKey) delta = Math.round(delta / ROT_SNAP) * ROT_SNAP
    const cos = Math.cos(delta), sin = Math.sin(delta)
    const { x: ocx, y: ocy } = gr.centroid
    const applyRot = (d) => {
      const s = gr.starts.find(s => s.id === d.id)
      if (!s) return d
      const rx = s.x - ocx, ry = s.y - ocy
      return { ...d, x: ocx + rx * cos - ry * sin, y: ocy + rx * sin + ry * cos, theta: s.theta + delta }
    }
    const cur = presentRef.current
    if (gr.dotMode === 'warp') {
      liveUpdate({ ...cur, warp: { ...cur.warp, warpDots: cur.warp.warpDots.map(applyRot) } })
    } else {
      liveUpdate({ ...cur, blurDots: (cur.blurDots ?? []).map(applyRot) })
    }
  }

  function onGroupRotPointerUp(e) {
    e.stopPropagation()
    const gr = groupRotDrag.current
    if (!gr) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), gr.snapshot])
    setFuture([])
    groupRotDrag.current = null
  }

  // ── Color operations ──────────────────────────────────────────────────────────

  function addColor() {
    const hex = COLOR_DEFAULTS[present.colors.length % COLOR_DEFAULTS.length]
    const newColor = { id: uid(), hex }
    commit({ ...present, colors: [...present.colors, newColor] })
    setActiveColorId(newColor.id)
  }

  function addColors(hexes) {
    const room = 26 - presentRef.current.colors.length
    if (room <= 0 || !hexes.length) return
    const toAdd = hexes.slice(0, room).map(hex => ({ id: uid(), hex }))
    commit({ ...presentRef.current, colors: [...presentRef.current.colors, ...toAdd] })
    setActiveColorId(toAdd[toAdd.length - 1].id)
  }

  async function pickColorWithEyedropper() {
    if (!window.EyeDropper) return
    try {
      const result = await new window.EyeDropper().open()
      if (result?.sRGBHex) addColors([result.sRGBHex])
    } catch {
      // user cancelled
    }
  }

  function updateColor(id, updated) {
    commit({ ...present, colors: present.colors.map(c => c.id === id ? { ...c, ...updated } : c) })
  }

  function deleteColor(id) {
    // Remove the color and all dots using it
    commit({
      ...present,
      colors: present.colors.filter(c => c.id !== id),
      dots: present.dots.filter(d => d.colorId !== id),
    })
    if (activeColorId === id) {
      const remaining = present.colors.filter(c => c.id !== id)
      setActiveColorId(remaining[0]?.id ?? null)
    }
    // Remove dots of deleted color from selection
    const deletedIds = new Set(present.dots.filter(d => d.colorId === id).map(d => d.id))
    if ([...deletedIds].some(id => selectedDotIds.has(id)))
      setSelectedDotIds(prev => new Set([...prev].filter(id => !deletedIds.has(id))))
  }

  // ── Dot operations ────────────────────────────────────────────────────────────

  function placeDot(x, y) {
    if (!activeColorId || !present.colors.find(c => c.id === activeColorId)) return
    const dot = { id: uid(), colorId: activeColorId, x, y, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 }
    commit({ ...present, dots: [...present.dots, dot] })
    setSelectedDotIds(new Set([dot.id]))
  }

  function placeWarpDot(x, y) {
    const dot = { id: uid(), x, y, dx: 0, dy: 0, rx: DEFAULT_WARP_R, ry: DEFAULT_WARP_R, theta: 0 }
    commit({ ...present, warp: { ...present.warp, warpDots: [...(present.warp.warpDots ?? []), dot] } })
    setSelectedWarpDotIds(new Set([dot.id]))
  }

  function deleteSelectedWarpDots() {
    if (!selectedWarpDotIds.size) return
    commit({ ...present, warp: { ...present.warp, warpDots: present.warp.warpDots.filter(d => !selectedWarpDotIds.has(d.id)) } })
    setSelectedWarpDotIds(new Set())
  }

  function placeBlurDot(x, y) {
    const dot = { id: uid(), x, y, dx: 0, dy: 0, rx: DEFAULT_WARP_R, ry: DEFAULT_WARP_R, theta: 0 }
    commit({ ...present, blurDots: [...(present.blurDots ?? []), dot] })
    setSelectedBlurDotIds(new Set([dot.id]))
  }
  function deleteSelectedBlurDots() {
    if (!selectedBlurDotIds.size) return
    commit({ ...present, blurDots: (present.blurDots ?? []).filter(d => !selectedBlurDotIds.has(d.id)) })
    setSelectedBlurDotIds(new Set())
  }
  function clearBlurDots() {
    commit({ ...present, blurDots: [] })
    setSelectedBlurDotIds(new Set())
  }

  // ── Dot copy / paste ──────────────────────────────────────────────────────────

  function copyDots() {
    if (mode === 'compose' && selectedDotIds.size > 0) {
      const colorMap = Object.fromEntries(present.colors.map(c => [c.id, c]))
      const items = [...selectedDotIds].map(id => {
        const dot = present.dots.find(d => d.id === id)
        if (!dot) return null
        return {
          fx: dot.x / cW, fy: dot.y / cH,
          frx: (dot.rx ?? DEFAULT_RX) / cW, fry: (dot.ry ?? DEFAULT_RY) / cH,
          theta: dot.theta ?? 0,
          colorHex: colorMap[dot.colorId]?.hex ?? '#ffffff',
        }
      }).filter(Boolean)
      dotClipboard = { type: 'compose', docId: activeDocId, items }
    } else if (mode === 'warp' && selectedWarpDotIds.size > 0) {
      const items = [...selectedWarpDotIds].map(id => {
        const dot = present.warp.warpDots.find(d => d.id === id)
        if (!dot) return null
        return {
          fx: dot.x / cW, fy: dot.y / cH,
          fdx: dot.dx / cW, fdy: dot.dy / cH,
          frx: (dot.rx ?? DEFAULT_WARP_R) / cW, fry: (dot.ry ?? DEFAULT_WARP_R) / cH,
          theta: dot.theta ?? 0,
        }
      }).filter(Boolean)
      dotClipboard = { type: 'warp', docId: activeDocId, items }
    } else if (mode === 'blur' && selectedBlurDotIds.size > 0) {
      const items = [...selectedBlurDotIds].map(id => {
        const dot = present.blurDots.find(d => d.id === id)
        if (!dot) return null
        return {
          fx: dot.x / cW, fy: dot.y / cH,
          fdx: dot.dx / cW, fdy: dot.dy / cH,
          frx: (dot.rx ?? DEFAULT_WARP_R) / cW, fry: (dot.ry ?? DEFAULT_WARP_R) / cH,
          theta: dot.theta ?? 0,
        }
      }).filter(Boolean)
      dotClipboard = { type: 'blur', docId: activeDocId, items }
    } else {
      dotClipboard = null
    }
  }

  function pasteDots() {
    if (!dotClipboard) return
    const { type, items } = dotClipboard
    if (type === 'compose') {
      const colorIdMap = {}
      const newColors = []
      items.forEach(item => {
        const existing = present.colors.find(c => c.hex === item.colorHex)
        if (existing) {
          colorIdMap[item.colorHex] = existing.id
        } else {
          const nc = { id: uid(), hex: item.colorHex }
          newColors.push(nc)
          colorIdMap[item.colorHex] = nc.id
        }
      })
      const off = dotClipboard.docId === activeDocId ? 10 : 0
      const newDots = items.map(item => ({
        id: uid(), colorId: colorIdMap[item.colorHex],
        x: item.fx * cW + off, y: item.fy * cH + off,
        rx: item.frx * cW, ry: item.fry * cH,
        theta: item.theta,
      }))
      commit({ ...present, colors: [...present.colors, ...newColors], dots: [...present.dots, ...newDots] })
      setSelectedDotIds(new Set(newDots.map(d => d.id)))
      if (newDots[0]) setActiveColorId(newDots[0].colorId)
      setMode('compose')
    } else if (type === 'warp') {
      const off = dotClipboard.docId === activeDocId ? 10 : 0
      const newDots = items.map(item => ({
        id: uid(),
        x: item.fx * cW + off, y: item.fy * cH + off,
        dx: item.fdx * cW, dy: item.fdy * cH,
        rx: item.frx * cW, ry: item.fry * cH,
        theta: item.theta,
      }))
      commit({ ...present, warp: { ...present.warp, warpDots: [...(present.warp.warpDots ?? []), ...newDots] } })
      setSelectedWarpDotIds(new Set(newDots.map(d => d.id)))
      setMode('warp')
    } else if (type === 'blur') {
      const off = dotClipboard.docId === activeDocId ? 10 : 0
      const newDots = items.map(item => ({
        id: uid(),
        x: item.fx * cW + off, y: item.fy * cH + off,
        dx: item.fdx * cW, dy: item.fdy * cH,
        rx: item.frx * cW, ry: item.fry * cH,
        theta: item.theta,
      }))
      commit({ ...present, blurDots: [...(present.blurDots ?? []), ...newDots] })
      setSelectedBlurDotIds(new Set(newDots.map(d => d.id)))
      setMode('blur')
    }
  }

  function reassignDot(dotId, colorId) {
    commit({ ...present, dots: present.dots.map(d => d.id === dotId ? { ...d, colorId } : d) })
  }

  function deleteSelectedDots() {
    if (selectedDotIds.size === 0) return
    commit({ ...present, dots: present.dots.filter(d => !selectedDotIds.has(d.id)) })
    setSelectedDotIds(new Set())
  }

  function randomizeColors() {
    const rand = seededRand(Date.now())
    commit({
      ...present,
      colors: present.colors.map(c => ({
        ...c,
        hex: rgbToHex({ r: rand() * 255, g: rand() * 255, b: rand() * 255 }),
      })),
    })
  }

  // ── Background operations ─────────────────────────────────────────────────────

  function updateBackground(bg) { commit({ ...present, background: bg }) }

  function setSize(newW, newH) {
    const w = Math.max(100, Math.min(4000, Math.round(newW)))
    const h = Math.max(100, Math.min(4000, Math.round(newH)))
    if (w === cW && h === cH) return
    const sX = w / cW, sY = h / cH
    commit({
      ...present,
      size: { w, h },
      dots: present.dots.map(d => ({
        ...d,
        x: d.x * sX, y: d.y * sY,
        rx: (d.rx ?? DEFAULT_RX) * sX,
        ry: (d.ry ?? DEFAULT_RY) * sY,
      })),
      warp: {
        ...present.warp,
        warpDots: (present.warp.warpDots ?? []).map(d => ({
          ...d,
          x: d.x * sX, y: d.y * sY,
          dx: d.dx * sX, dy: d.dy * sY,
          rx: (d.rx ?? DEFAULT_WARP_R) * sX,
          ry: (d.ry ?? DEFAULT_WARP_R) * sY,
        })),
      },
      blurDots: (present.blurDots ?? []).map(d => ({
        ...d,
        x: d.x * sX, y: d.y * sY,
        dx: d.dx * sX, dy: d.dy * sY,
        rx: (d.rx ?? DEFAULT_WARP_R) * sX,
        ry: (d.ry ?? DEFAULT_WARP_R) * sY,
      })),
    })
  }

  function startTutorial() {
    driver({
      showProgress: true,
      animate: true,
      overlayOpacity: 0.6,
      popoverClass: 'hazy-driver-popover',
      steps: [
        {
          popover: {
            title: 'Welcome to Hazy',
            description: 'A quick tour of the key features. You can restart this tour at any time via the "Tutorial" button.',
          },
        },
        {
          element: '[data-tour="canvas"]',
          popover: {
            title: 'Canvas',
            description: 'Double-click to add a new point. Hold Shift to select multiple points. Hold Space and drag to pan. In Warp and Blur mode you can resize the circle and drag the yellow center point to control the intensity of the effect.',
            side: 'left',
          },
        },
        {
          element: '[data-tour="colors-section"]',
          popover: {
            title: 'Colors',
            description: 'Quickly add colors by pasting one or more hex values directly from your clipboard (⌘V).',
            side: 'right',
          },
        },
        {
          element: '[data-tour="mode-switcher"]',
          popover: {
            title: 'Compose / Warp / Blur',
            description: 'Switch between the three modes: place color points (Compose), distort the gradient (Warp), or apply local blur (Blur).',
            side: 'bottom',
          },
        },
        {
          element: '[data-tour="contrast-toggle"]',
          popover: {
            title: 'Contrast check',
            description: 'Show a WCAG contrast heatmap to see where white or black text is readable on your gradient (AA/AAA, normal or large text).',
            side: 'bottom',
          },
        },
      ],
    }).drive()
  }

  function exportPNG() {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'hazy-gradient.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  async function copyPNG() {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob(async blob => {
      if (!blob) return
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setCopiedPNG(true)
        setTimeout(() => setCopiedPNG(false), 1500)
      } catch (err) {
        console.warn('Failed to copy image to clipboard', err)
        alert('Could not copy image to clipboard.')
      }
    }, 'image/png')
  }

  function exportDocumentJSON() {
    const name = activeDoc.name || 'hazy-gradient'
    const payload = { hazyDoc: 1, name, doc: presentRef.current }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safeName = name.trim().replace(/[^a-z0-9-_ ]/gi, '').trim() || 'hazy-gradient'
    link.download = `${safeName}.json`
    link.href = url
    link.click()
    URL.revokeObjectURL(url)
  }

  function importDocumentJSON(file) {
    const reader = new FileReader()
    reader.onload = () => {
      let parsed
      try {
        parsed = JSON.parse(reader.result)
      } catch {
        alert('Could not read file — not valid JSON.')
        return
      }
      const doc = isValidDocShape(parsed) ? parsed : parsed?.doc
      if (!isValidDocShape(doc)) {
        alert('Invalid Hazy document file.')
        return
      }
      const newEntry = { id: uid(), name: parsed.name ?? 'Imported', doc, past: [], future: [], thumbnail: null }
      const currentDoc = presentRef.current
      setDocuments(docs => [
        ...docs.map(d => d.id === activeDocId
          ? { ...d, doc: currentDoc, past, future }
          : d),
        newEntry,
      ])
      setPast([])
      setFuture([])
      syncPresent(doc)
      setActiveDocId(newEntry.id)
      resetDocUIState(doc)
    }
    reader.onerror = () => alert('Could not read file — not valid JSON.')
    reader.readAsText(file)
  }

  // ── Warp operations ───────────────────────────────────────────────────────────

  function updateWarpIntensity(v) {
    commit({ ...present, warp: { ...present.warp, intensity: v } })
  }
  function clearWarpDots() {
    commit({ ...present, warp: { ...present.warp, warpDots: [] } })
    setSelectedWarpDotIds(new Set())
  }

  // ── Filter operations ─────────────────────────────────────────────────────────

  function updateFilter(key, value) {
    commit({ ...present, filters: { ...present.filters, [key]: value } })
  }
  function resetFilters() {
    commit({ ...present, filters: INIT_FILTERS })
  }

  // ── Palette operations ────────────────────────────────────────────────────────

  function saveCurrentPalette() {
    const name = paletteName.trim(); if (!name) return
    const all = loadPalettes()
    all[name] = { colors: present.colors, dots: present.dots, background: present.background, warp: present.warp, filters: present.filters }
    writePalettes(all)
    setSavedPalettes({ ...all })
    setPaletteName('')
  }
  function loadPaletteByName(name) {
    const all = loadPalettes(); const p = all[name]; if (!p) return
    commit({
      ...present,
      colors: p.colors ?? present.colors,
      dots: p.dots ?? present.dots,
      background: p.background ?? present.background,
      warp: p.warp ?? present.warp,
      filters: p.filters ?? INIT_FILTERS,
    })
    setSelectedDotIds(new Set())
    if (p.colors?.length) setActiveColorId(p.colors[0].id)
  }
  function deletePalette(name) {
    const all = loadPalettes()
    delete all[name]
    writePalettes(all)
    setSavedPalettes({ ...all })
  }

  // ── Paste-to-add color ────────────────────────────────────────────────────────

  useEffect(() => {
    function onPaste(e) {
      if (dotClipboard !== null) return
      const active = document.activeElement
      const isEditable = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
      if (isEditable) return
      const text = e.clipboardData?.getData('text')
      if (!text) return
      const hexes = parseColorsFromText(text)
      if (!hexes.length) return
      e.preventDefault()
      addColors(hexes)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // ── Keyboard ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && ellipseDrag.current) {
        e.preventDefault()
        syncPresent(ellipseDrag.current.snapshot)
        ellipseDrag.current = null
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        e.preventDefault()
        const { zoom, pan } = viewRef.current
        if (e.key === '0') {
          setView({ zoom: 1, pan: { x: 0, y: 0 } })
        } else {
          const factor = (e.key === '=' || e.key === '+') ? ZOOM_STEP : 1 / ZOOM_STEP
          const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
          const s = newZoom / zoom
          setView({ zoom: newZoom, pan: { x: pan.x * s, y: pan.y * s } })
        }
        return
      }
      if (e.target.tagName === 'INPUT') return
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !e.metaKey && !e.ctrlKey) {
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        const cur = presentRef.current
        if (mode === 'compose' && selectedDotIds.size > 0) {
          e.preventDefault()
          commit({ ...cur, dots: cur.dots.map(d => selectedDotIds.has(d.id) ? { ...d, x: d.x + dx, y: d.y + dy } : d) })
        } else if (mode === 'warp' && selectedWarpDotIds.size > 0) {
          e.preventDefault()
          commit({ ...cur, warp: { ...cur.warp, warpDots: cur.warp.warpDots.map(d => selectedWarpDotIds.has(d.id) ? { ...d, x: d.x + dx, y: d.y + dy } : d) } })
        } else if (mode === 'blur' && selectedBlurDotIds.size > 0) {
          e.preventDefault()
          commit({ ...cur, blurDots: (cur.blurDots ?? []).map(d => selectedBlurDotIds.has(d.id) ? { ...d, x: d.x + dx, y: d.y + dy } : d) })
        }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (mode === 'warp' && selectedWarpDotIds.size > 0) {
          e.preventDefault(); deleteSelectedWarpDots()
        } else if (mode === 'blur' && selectedBlurDotIds.size > 0) {
          e.preventDefault(); deleteSelectedBlurDots()
        } else if (mode === 'compose' && selectedDotIds.size > 0) {
          e.preventDefault(); deleteSelectedDots()
        }
      }
      if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
      }
      if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
        const hasSelection =
          (mode === 'compose' && selectedDotIds.size > 0) ||
          (mode === 'warp' && selectedWarpDotIds.size > 0) ||
          (mode === 'blur' && selectedBlurDotIds.size > 0)
        if (hasSelection) {
          e.preventDefault()
          copyDots()
        } else {
          dotClipboard = null
        }
      }
      if (e.key === 'v' && (e.metaKey || e.ctrlKey) && dotClipboard !== null) {
        e.preventDefault()
        pasteDots()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDotIds, selectedWarpDotIds, selectedBlurDotIds, mode, past, future])

  // ── Derived ───────────────────────────────────────────────────────────────────

  const paletteNames = Object.keys(savedPalettes)
  const canUndo = past.length > 0
  const canRedo = future.length > 0
  const selectedDot = selectedDotIds.size === 1
    ? present.dots.find(d => d.id === [...selectedDotIds][0]) ?? null
    : null
  const cssFilter = buildCSSFilter(present.filters)
  const blurPx = present.filters.blur * 0.2
  const blurScale = blurPx > 0 ? 1 + (blurPx * 3) / Math.min(cW, cH) : 1
  const canvasCSS = {
    display: 'block',
    filter: cssFilter,
    ...(blurScale > 1 && { transform: `scale(${blurScale.toFixed(4)})` }),
    ...(present.background.transparent && {
      backgroundImage: 'repeating-conic-gradient(#666 0% 25%, #444 0% 50%)',
      backgroundSize: '16px 16px',
    }),
  }
  const bgPickerRef = useRef(null)
  const [bgHexDraft, setBgHexDraft] = useState(present.background.hex)
  useEffect(() => setBgHexDraft(present.background.hex), [present.background.hex])
  useEffect(() => { setWDraft(String(cW)); setHDraft(String(cH)) }, [cW, cH])

  useEffect(() => {
    if (!fileMenuOpen) return
    function onPointerDown(e) {
      if (!fileMenuRef.current?.contains(e.target)) setFileMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [fileMenuOpen])

  function commitBgHex(val) {
    const c = /^#/.test(val) ? val : '#' + val
    if (/^#[0-9a-fA-F]{6}$/.test(c)) updateBackground({ ...present.background, hex: c.toLowerCase() })
    else setBgHexDraft(present.background.hex)
  }

  // ── JSX ───────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen overflow-hidden bg-[#111]">

      <div className="flex flex-col shrink-0">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="h-12 flex items-center justify-between px-5 border-b border-white/[0.07] shrink-0 bg-[#181818]">
        <span className="text-white text-[17px] font-semibold tracking-tight">Hazy</span>
        <button onClick={startTutorial}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-white/45 border border-white/[0.08] hover:text-white/80 hover:border-white/20 hover:bg-white/[0.06] transition-colors">
          <HelpCircle size={12} /> Tutorial
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) importDocumentJSON(file)
            e.target.value = ''
          }}
        />
      </div>

      <div className="flex flex-1 overflow-hidden">

      {/* ── File rail ───────────────────────────────────────────────────── */}
      <aside data-tour="file-rail" className="w-24 shrink-0 flex flex-col items-center bg-[#0d0d0d] border-r border-white/[0.07] px-4 py-2 gap-1.5 overflow-y-auto">
        {documents.map(entry => (
          <FileRailItem
            key={entry.id}
            entry={entry}
            isActive={entry.id === activeDocId}
            onSelect={() => switchDocument(entry.id)}
            onRename={name => renameDocument(entry.id, name)}
            canDelete={documents.length > 1}
            onDelete={() => deleteDocument(entry.id)}
          />
        ))}
        <button
          onClick={addDocument}
          title="Add gradient"
          className="w-full aspect-[8/5] shrink-0 rounded border border-dashed border-white/15 text-white/30 hover:text-white/60 hover:border-white/30 flex items-center justify-center transition-colors"
        >
          <Plus size={12} strokeWidth={2.5} />
        </button>
      </aside>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-80 shrink-0 flex flex-col bg-[#181818] border-r border-white/[0.07]">

        <nav className="flex-1 overflow-y-auto min-h-0">

          {/* ── Colors ── */}
          <Section title="Colors" defaultOpen tourId="colors-section">

            {/* Background */}
            <div className="mb-3 pb-3 border-b border-white/[0.06]">
              <div className="text-[10px] text-white/30 mb-2 uppercase tracking-wide">Background</div>
              <div className="flex items-center gap-1.5 mb-2">
                <div onClick={() => bgPickerRef.current?.click()} style={{
                  width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                  background: present.background.hex,
                  border: '1.5px solid rgba(255,255,255,0.12)', cursor: 'pointer',
                }} />
                <input ref={bgPickerRef} type="color" value={present.background.hex}
                  onChange={e => updateBackground({ ...present.background, hex: e.target.value })}
                  style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }} />
                <input value={bgHexDraft}
                  onChange={e => setBgHexDraft(e.target.value)}
                  onBlur={e => commitBgHex(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && commitBgHex(bgHexDraft)}
                  maxLength={7}
                  className="font-mono text-[11px] text-white/60 bg-white/[0.05] border border-white/[0.08] rounded px-1.5 py-0.5 outline-none focus:border-white/20 w-[68px] shrink-0"
                  spellCheck={false}
                />
              </div>
              <Toggle on={present.background.transparent}
                onChange={v => updateBackground({ ...present.background, transparent: v })}
                label="Transparent" />
            </div>

            {/* Palette */}
            <div className="mb-2">
              <div className="text-[10px] text-white/30 mb-2 uppercase tracking-wide">
                Palette
              </div>
              {present.colors.map((color, i) => (
                <ColorRow
                  key={color.id}
                  label={LABELS[i] ?? (i + 1)}
                  color={color}
                  isActive={activeColorId === color.id}
                  onActivate={() => setActiveColorId(color.id)}
                  onChange={updated => updateColor(color.id, updated)}
                  onDelete={() => deleteColor(color.id)}
                />
              ))}
              {present.colors.length < 26 && (
                <div className="mt-1 flex items-stretch gap-1.5">
                  <button onClick={addColor}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                    <Plus size={12} strokeWidth={2.5} /> Add color
                  </button>
                  {window.EyeDropper && (
                    <button onClick={pickColorWithEyedropper}
                      title="Pick color from screen"
                      className="flex items-center justify-center px-2.5 rounded border border-white/[0.08] text-white/35 hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                      <Pipette size={12} />
                    </button>
                  )}
                </div>
              )}
            </div>


            {/* Randomize + palette */}
            <div className="mt-3 pt-3 border-t border-white/[0.06]">
              <button onClick={randomizeColors}
                className="w-full mb-3 flex items-center justify-center gap-1.5 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <Shuffle size={12} /> Randomize colors
              </button>
              <div className="flex gap-1.5 mb-2">
                <input value={paletteName} onChange={e => setPaletteName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveCurrentPalette()}
                  placeholder="Palette name…"
                  className="flex-1 min-w-0 bg-white/[0.05] border border-white/[0.08] rounded px-2 py-1 text-[11px] text-white/60 placeholder-white/20 outline-none focus:border-white/20" />
                <button onClick={saveCurrentPalette}
                  className="px-2.5 py-1 rounded bg-white/[0.07] text-white/50 text-[11px] hover:bg-white/[0.12] hover:text-white/80 transition-colors shrink-0">
                  Save
                </button>
              </div>
              {paletteNames.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {paletteNames.map(n => (
                    <div key={n} className="flex items-center gap-1 group">
                      <button
                        onClick={() => loadPaletteByName(n)}
                        className="flex-1 min-w-0 text-left px-2 py-1 rounded text-[11px] text-white/50 hover:text-white/80 hover:bg-white/[0.06] transition-colors truncate">
                        {n}
                      </button>
                      <button
                        onClick={() => deletePalette(n)}
                        className="shrink-0 p-1 rounded text-white/20 hover:text-red-400 hover:bg-white/[0.05] transition-colors opacity-0 group-hover:opacity-100">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          {/* ── Warp ── */}
          <Section title="Warp" tourId="warp-section">
            <p className="text-[10px] text-white/25 leading-relaxed mb-3">
              Switch to Warp mode and double-click to place dots. Drag the yellow handle to set direction and strength.
            </p>
            <div className="mb-3">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[10px] text-white/30 uppercase tracking-wide">Intensity</span>
                <span className="text-[10px] text-white/40 tabular-nums">{present.warp.intensity}%</span>
              </div>
              <input type="range" min={0} max={200} value={present.warp.intensity}
                onChange={e => updateWarpIntensity(+e.target.value)}
                className="w-full accent-violet-400" style={{ cursor: 'pointer' }} />
            </div>
            <button onClick={clearWarpDots}
              className="w-full py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
              Clear all{(present.warp.warpDots ?? []).length > 0 ? ` (${present.warp.warpDots.length})` : ''}
            </button>
          </Section>

          {/* ── Filters ── */}
          <Section title="Filters" tourId="filters-section">
            <FilterSlider label="Sharpness" value={present.sharpness} min={1} max={8} step={0.5} unit="" onChange={v => commit({ ...present, sharpness: v })} />
            <FilterSlider label="Grain" value={present.filters.grain} min={0} max={100} unit="%" onChange={v => updateFilter('grain', v)} />
            <FilterSlider label="Blur" value={present.filters.blur} min={0} max={100} unit="%" onChange={v => updateFilter('blur', v)} />
            <FilterSlider label="Contrast" value={present.filters.contrast} min={100} max={200} unit="%" onChange={v => updateFilter('contrast', v)} />
            <FilterSlider label="Brightness" value={present.filters.brightness} min={100} max={200} unit="%" onChange={v => updateFilter('brightness', v)} />
            <FilterSlider label="Saturation" value={present.filters.saturation ?? 100} min={0} max={200} unit="%" onChange={v => updateFilter('saturation', v)} />
            <FilterSlider label="Hue rotate" value={present.filters.hue} min={0} max={360} unit="°" onChange={v => updateFilter('hue', v)} />
            <button onClick={resetFilters}
              className="w-full mt-1 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
              Reset filters
            </button>
          </Section>

          {/* ── Size ── */}
          <Section title="Size" tourId="size-section">
            <div className="flex gap-3">
              {[['W', wDraft, setWDraft, v => setSize(v, cH)], ['H', hDraft, setHDraft, v => setSize(cW, v)]].map(([label, draft, setDraft, commit]) => (
                <div key={label} className="flex-1">
                  <div className="text-[10px] text-white/30 mb-1.5 uppercase tracking-wide">{label}</div>
                  <div className="flex items-center gap-1">
                    <input
                      type="number" min={100} max={4000} value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onBlur={e => commit(Number(e.target.value))}
                      onKeyDown={e => e.key === 'Enter' && commit(Number(draft))}
                      className="w-full bg-white/[0.05] border border-white/[0.08] rounded px-2 py-1 text-[11px] text-white/60 outline-none focus:border-white/20 tabular-nums"
                      style={{ colorScheme: 'dark' }}
                    />
                    <span className="text-[10px] text-white/25 shrink-0">px</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

        </nav>

        {/* Undo / Redo */}
      </aside>

      </div>

      </div>

      {/* ── Canvas area ──────────────────────────────────────────────────── */}
      <main
        ref={mainRef}
        data-tour="canvas"
        className="flex-1 relative overflow-hidden"
        style={{ cursor: spaceDown ? 'grab' : mode !== 'compose' || activeColorId ? 'crosshair' : 'default' }}
        onPointerDown={onMainPointerDown}
        onPointerMove={onMainPointerMove}
        onPointerUp={onMainPointerUp}
        onPointerLeave={() => { panDrag.current = false; boxSelectRef.current = null; setBoxSelect(null) }}
        onDoubleClick={onMainDoubleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      >
        {/* Mode switcher */}
        <div data-tour="mode-switcher" className="absolute top-3 left-1/2 -translate-x-1/2 z-20 select-none" data-no-pan="">
          <div style={{
            display: 'flex', gap: 2, padding: 3,
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 10,
            backdropFilter: 'blur(10px)',
          }}>
            {['Compose', 'Warp', 'Blur'].map(label => {
              const m = label.toLowerCase()
              const active = mode === m
              return (
                <button key={label} data-no-pan=""
                  onClick={() => {
                    setMode(m)
                    if (m !== 'compose') setSelectedDotIds(new Set())
                    if (m !== 'warp') setSelectedWarpDotIds(new Set())
                    if (m !== 'blur') setSelectedBlurDotIds(new Set())
                  }}
                  style={{
                    padding: '4px 14px',
                    borderRadius: 7,
                    fontSize: 11, fontWeight: 500,
                    border: 'none', cursor: 'pointer',
                    transition: 'background 0.15s, color 0.15s',
                    background: active ? 'rgba(139,92,246,0.28)' : 'transparent',
                    color: active ? 'rgba(196,181,253,1)' : 'rgba(255,255,255,0.38)',
                    boxShadow: active ? 'inset 0 0 0 1px rgba(139,92,246,0.4)' : 'none',
                  }}>
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Export buttons */}
        <div data-tour="export-buttons" className="absolute top-3 right-3 z-20 flex items-center gap-1.5 select-none" data-no-pan="">
          <div className="flex items-center" style={{
            height: 28, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6,
          }}>
            <button onClick={undo} disabled={!canUndo} data-no-pan=""
              title="Undo (⌘Z)"
              className="flex items-center justify-center px-2 h-full transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
              style={{ color: 'rgba(255,255,255,0.7)', cursor: canUndo ? 'pointer' : 'default' }}>
              <Undo2 size={12} strokeWidth={2.2} />
            </button>
            <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.09)' }} />
            <button onClick={redo} disabled={!canRedo} data-no-pan=""
              title="Redo (⌘⇧Z)"
              className="flex items-center justify-center px-2 h-full transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
              style={{ color: 'rgba(255,255,255,0.7)', cursor: canRedo ? 'pointer' : 'default' }}>
              <Redo2 size={12} strokeWidth={2.2} />
            </button>
          </div>
          <button onClick={copyPNG} data-no-pan=""
            className="flex items-center gap-1.5 px-2.5 rounded-md text-[11px] font-medium leading-none transition-colors"
            style={{
              height: 28,
              color: copiedPNG ? 'rgba(134,239,172,1)' : 'rgba(255,255,255,0.7)',
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.09)',
              cursor: 'pointer',
            }}>
            {copiedPNG ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy as PNG</>}
          </button>
          <div ref={fileMenuRef} className="relative">
            <button onClick={() => setFileMenuOpen(v => !v)} data-no-pan=""
              title="More options"
              className="flex items-center justify-center px-2 rounded-md transition-colors"
              style={{
                height: 28,
                color: 'rgba(255,255,255,0.7)', background: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.09)',
                cursor: 'pointer',
              }}>
              <MoreHorizontal size={12} />
            </button>
            {fileMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 rounded-md border border-white/[0.08] bg-[#1c1c1c] shadow-lg shadow-black/40 py-1 z-20">
                <button onClick={() => { setFileMenuOpen(false); exportPNG() }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.06] transition-colors">
                  <ImageDown size={12} /> Export as PNG
                </button>
                <button onClick={() => { setFileMenuOpen(false); importInputRef.current?.click() }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.06] transition-colors">
                  <Import size={12} /> Import gradient (JSON)
                </button>
                <button onClick={() => { setFileMenuOpen(false); exportDocumentJSON() }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-white/60 hover:text-white/90 hover:bg-white/[0.06] transition-colors">
                  <FileBraces size={12} /> Export gradient (JSON)
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Canvas + overlays */}
        <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: 'none' }}>
          <div style={{
            position: 'relative',
            transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
            transformOrigin: 'center center',
            willChange: 'transform',
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}>
          <div style={{
            position: 'relative',
            boxShadow: '0 24px 80px rgba(0,0,0,0.75), 0 8px 24px rgba(0,0,0,0.5)',
            overflow: 'hidden',
          }}>
            <canvas ref={canvasRef} width={cW} height={cH} style={canvasCSS} />

            {/* Contrast heatmap overlay */}
            {contrastCheck && (
              <canvas ref={contrastRef} width={cW} height={cH} style={{
                position: 'absolute', left: 0, top: 0, width: cW, height: cH,
                pointerEvents: 'none', mixBlendMode: 'normal',
              }} />
            )}

            {/* Grain overlay */}
            {present.filters.grain > 0 && (
              <svg style={{
                position: 'absolute', left: 0, top: 0,
                width: cW, height: cH,
                pointerEvents: 'none',
                mixBlendMode: 'overlay',
                opacity: present.filters.grain / 200,
              }}>
                <defs>
                  <filter id="hazy-grain" x="0" y="0" width="100%" height="100%">
                    <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
                    <feColorMatrix type="saturate" values="0" />
                  </filter>
                </defs>
                <rect width={cW} height={cH} filter="url(#hazy-grain)" />
              </svg>
            )}

            {/* Dots */}
            {mode === 'compose' && present.dots.map(dot => {
              const color = present.colors.find(c => c.id === dot.colorId)
              if (!color) return null
              const colorIndex = present.colors.indexOf(color)
              const label = LABELS[colorIndex] ?? ''
              const selected = selectedDotIds.has(dot.id)
              return (
                <div key={dot.id} data-no-pan=""
                  onPointerDown={e => onDotPointerDown(e, dot.id)}
                  onPointerMove={e => onDotPointerMove(e, dot.id)}
                  onPointerUp={e => onDotPointerUp(e, dot.id)}
                  style={{
                    position: 'absolute', left: dot.x, top: dot.y,
                    transform: 'translate(-50%, -50%)',
                    width: 22, height: 22, borderRadius: '50%',
                    background: color.hex,
                    border: selected ? '2.5px solid white' : '1.5px solid rgba(255,255,255,0.8)',
                    boxShadow: selected
                      ? '0 0 0 2.5px rgba(139,92,246,0.85), 0 2px 8px rgba(0,0,0,0.5)'
                      : '0 1px 5px rgba(0,0,0,0.5)',
                    cursor: 'move', touchAction: 'none', zIndex: 10,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <span style={{
                    fontSize: 9, fontWeight: 800, color: 'rgba(255,255,255,0.9)',
                    textShadow: '0 0 4px rgba(0,0,0,0.7)',
                    userSelect: 'none', pointerEvents: 'none', lineHeight: 1,
                  }}>
                    {label}
                  </span>
                </div>
              )
            })}

            {/* Warp dots overlay */}
            {mode === 'warp' && (() => {
              const warpDots = present.warp.warpDots ?? []
              const selDots = warpDots.filter(d => selectedWarpDotIds.has(d.id))
              const multiSel = selectedWarpDotIds.size > 1
              const minX = multiSel ? Math.min(...selDots.map(d => d.x)) : 0
              const maxX = multiSel ? Math.max(...selDots.map(d => d.x)) : 0
              const minY = multiSel ? Math.min(...selDots.map(d => d.y)) : 0
              const maxY = multiSel ? Math.max(...selDots.map(d => d.y)) : 0
              const bcx = (minX + maxX) / 2
              const GRP_ROT_DIST = 44
              return (
                <svg style={{
                  position: 'absolute', left: 0, top: 0,
                  width: cW, height: cH,
                  overflow: 'visible', pointerEvents: 'none',
                }}>
                  {/* Bounding box + group rotation handle */}
                  {multiSel && (
                    <>
                      <rect x={minX} y={minY} width={Math.max(1, maxX - minX)} height={Math.max(1, maxY - minY)}
                        fill="none" stroke="rgba(139,92,246,0.3)" strokeWidth={1} strokeDasharray="4 3"
                        pointerEvents="none"
                      />
                      <line x1={bcx} y1={minY} x2={bcx} y2={minY - GRP_ROT_DIST}
                        stroke="rgba(255,255,255,0.2)" strokeWidth={1} pointerEvents="none"
                      />
                      <circle cx={bcx} cy={minY - GRP_ROT_DIST} r={6}
                        fill="rgb(139,92,246)" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5}
                        style={{ cursor: 'grab', pointerEvents: 'all' }}
                        onPointerDown={e => startGroupRot(e, 'warp', selDots)}
                        onPointerMove={onGroupRotPointerMove}
                        onPointerUp={onGroupRotPointerUp}
                      />
                    </>
                  )}
                  {warpDots.map(wd => {
                    const sel = selectedWarpDotIds.has(wd.id)
                    const ax = wd.x + wd.dx, ay = wd.y + wd.dy
                    const hasDelta = wd.dx !== 0 || wd.dy !== 0
                    const theta = wd.theta ?? 0
                    const rx = wd.rx ?? DEFAULT_WARP_R
                    const ry = wd.ry ?? DEFAULT_WARP_R
                    const cosT = Math.cos(theta), sinT = Math.sin(theta)
                    const rxHx = wd.x + rx * cosT, rxHy = wd.y + rx * sinT
                    const ryHx = wd.x - ry * sinT, ryHy = wd.y + ry * cosT
                    const rotHx = wd.x + (rx + ROT_HANDLE_OFFSET) * cosT
                    const rotHy = wd.y + (rx + ROT_HANDLE_OFFSET) * sinT
                    return (
                      <g key={wd.id}>
                        <ellipse cx={wd.x} cy={wd.y} rx={rx} ry={ry}
                          fill={sel ? 'rgba(139,92,246,0.06)' : 'rgba(255,255,255,0.02)'}
                          stroke={sel ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.12)'}
                          strokeWidth={1} strokeDasharray="4 3" pointerEvents="none"
                          transform={`rotate(${theta * 180 / Math.PI}, ${wd.x}, ${wd.y})`}
                        />
                        {hasDelta && (
                          <line x1={wd.x} y1={wd.y} x2={ax} y2={ay}
                            stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} pointerEvents="none"
                          />
                        )}
                        <circle cx={wd.x} cy={wd.y} r={6}
                          fill={sel ? 'rgb(139,92,246)' : 'rgba(255,255,255,0.8)'}
                          stroke={sel ? 'rgba(109,40,217,0.9)' : 'rgba(0,0,0,0.4)'}
                          strokeWidth={1.5}
                          style={{ cursor: 'move', pointerEvents: 'all' }}
                          onPointerDown={e => onWarpDotBodyPointerDown(e, wd.id)}
                          onPointerMove={e => onWarpDotBodyPointerMove(e, wd.id)}
                          onPointerUp={e => onWarpDotBodyPointerUp(e, wd.id)}
                        />
                        <circle cx={ax} cy={ay} r={5}
                          fill="rgba(251,191,36,0.9)" stroke="rgba(0,0,0,0.4)" strokeWidth={1.5}
                          style={{ cursor: 'grab', pointerEvents: 'all' }}
                          onPointerDown={e => onWarpArrowPointerDown(e, wd.id)}
                          onPointerMove={e => onWarpArrowPointerMove(e, wd.id)}
                          onPointerUp={e => onWarpArrowPointerUp(e, wd.id)}
                        />
                        {/* Per-dot ellipse handles — single selection only */}
                        {sel && !multiSel && (
                          <>
                            <line x1={rxHx} y1={rxHy} x2={rotHx} y2={rotHy}
                              stroke="rgba(255,255,255,0.2)" strokeWidth={1} pointerEvents="none"
                            />
                            <circle cx={rxHx} cy={rxHy} r={5}
                              fill="white" stroke="rgba(0,0,0,0.35)" strokeWidth={1.5}
                              style={{ cursor: 'col-resize', pointerEvents: 'all' }}
                              onPointerDown={e => onWarpEllipsePointerDown(e, wd.id, 'rx')}
                              onPointerMove={e => onWarpEllipsePointerMove(e, wd.id, 'rx')}
                              onPointerUp={e => onWarpEllipsePointerUp(e, wd.id)}
                            />
                            <circle cx={ryHx} cy={ryHy} r={5}
                              fill="white" stroke="rgba(0,0,0,0.35)" strokeWidth={1.5}
                              style={{ cursor: 'row-resize', pointerEvents: 'all' }}
                              onPointerDown={e => onWarpEllipsePointerDown(e, wd.id, 'ry')}
                              onPointerMove={e => onWarpEllipsePointerMove(e, wd.id, 'ry')}
                              onPointerUp={e => onWarpEllipsePointerUp(e, wd.id)}
                            />
                            <circle cx={rotHx} cy={rotHy} r={5}
                              fill="rgb(139,92,246)" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5}
                              style={{ cursor: 'grab', pointerEvents: 'all' }}
                              onPointerDown={e => onWarpEllipsePointerDown(e, wd.id, 'rot')}
                              onPointerMove={e => onWarpEllipsePointerMove(e, wd.id, 'rot')}
                              onPointerUp={e => onWarpEllipsePointerUp(e, wd.id)}
                            />
                          </>
                        )}
                      </g>
                    )
                  })}
                </svg>
              )
            })()}

            {/* Blur dots overlay */}
            {mode === 'blur' && (() => {
              const blurDots = present.blurDots ?? []
              const selDots = blurDots.filter(d => selectedBlurDotIds.has(d.id))
              const multiSel = selectedBlurDotIds.size > 1
              const minX = multiSel ? Math.min(...selDots.map(d => d.x)) : 0
              const maxX = multiSel ? Math.max(...selDots.map(d => d.x)) : 0
              const minY = multiSel ? Math.min(...selDots.map(d => d.y)) : 0
              const maxY = multiSel ? Math.max(...selDots.map(d => d.y)) : 0
              const bcx = (minX + maxX) / 2
              const GRP_ROT_DIST = 44
              return (
                <svg style={{ position: 'absolute', left: 0, top: 0, width: cW, height: cH, overflow: 'visible', pointerEvents: 'none' }}>
                  {multiSel && (
                    <>
                      <rect x={minX} y={minY} width={Math.max(1, maxX - minX)} height={Math.max(1, maxY - minY)}
                        fill="none" stroke="rgba(249,115,22,0.3)" strokeWidth={1} strokeDasharray="4 3"
                        pointerEvents="none"
                      />
                      <line x1={bcx} y1={minY} x2={bcx} y2={minY - GRP_ROT_DIST}
                        stroke="rgba(255,255,255,0.2)" strokeWidth={1} pointerEvents="none"
                      />
                      <circle cx={bcx} cy={minY - GRP_ROT_DIST} r={6}
                        fill="rgb(249,115,22)" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5}
                        style={{ cursor: 'grab', pointerEvents: 'all' }}
                        onPointerDown={e => startGroupRot(e, 'blur', selDots)}
                        onPointerMove={onGroupRotPointerMove}
                        onPointerUp={onGroupRotPointerUp}
                      />
                    </>
                  )}
                  {blurDots.map(bd => {
                    const sel = selectedBlurDotIds.has(bd.id)
                    const ax = bd.x + bd.dx, ay = bd.y + bd.dy
                    const hasDelta = bd.dx !== 0 || bd.dy !== 0
                    const theta = bd.theta ?? 0
                    const rx = bd.rx ?? DEFAULT_WARP_R
                    const ry = bd.ry ?? DEFAULT_WARP_R
                    const cosT = Math.cos(theta), sinT = Math.sin(theta)
                    const rxHx = bd.x + rx * cosT, rxHy = bd.y + rx * sinT
                    const ryHx = bd.x - ry * sinT, ryHy = bd.y + ry * cosT
                    const rotHx = bd.x + (rx + ROT_HANDLE_OFFSET) * cosT
                    const rotHy = bd.y + (rx + ROT_HANDLE_OFFSET) * sinT
                    return (
                      <g key={bd.id}>
                        <ellipse cx={bd.x} cy={bd.y} rx={rx} ry={ry}
                          fill={sel ? 'rgba(249,115,22,0.06)' : 'rgba(255,255,255,0.02)'}
                          stroke={sel ? 'rgba(249,115,22,0.4)' : 'rgba(255,255,255,0.12)'}
                          strokeWidth={1} strokeDasharray="4 3" pointerEvents="none"
                          transform={`rotate(${theta * 180 / Math.PI}, ${bd.x}, ${bd.y})`}
                        />
                        {hasDelta && (
                          <line x1={bd.x} y1={bd.y} x2={ax} y2={ay}
                            stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} pointerEvents="none"
                          />
                        )}
                        <circle cx={bd.x} cy={bd.y} r={6}
                          fill={sel ? 'rgb(249,115,22)' : 'rgba(255,255,255,0.8)'}
                          stroke={sel ? 'rgba(234,88,12,0.9)' : 'rgba(0,0,0,0.4)'}
                          strokeWidth={1.5}
                          style={{ cursor: 'move', pointerEvents: 'all' }}
                          onPointerDown={e => onBlurDotBodyPointerDown(e, bd.id)}
                          onPointerMove={e => onBlurDotBodyPointerMove(e, bd.id)}
                          onPointerUp={e => onBlurDotBodyPointerUp(e, bd.id)}
                        />
                        <circle cx={ax} cy={ay} r={5}
                          fill="rgba(251,191,36,0.9)" stroke="rgba(0,0,0,0.4)" strokeWidth={1.5}
                          style={{ cursor: 'grab', pointerEvents: 'all' }}
                          onPointerDown={e => onBlurArrowPointerDown(e, bd.id)}
                          onPointerMove={e => onBlurArrowPointerMove(e, bd.id)}
                          onPointerUp={e => onBlurArrowPointerUp(e, bd.id)}
                        />
                        {/* Per-dot ellipse handles — single selection only */}
                        {sel && !multiSel && (
                          <>
                            <line x1={rxHx} y1={rxHy} x2={rotHx} y2={rotHy}
                              stroke="rgba(255,255,255,0.2)" strokeWidth={1} pointerEvents="none"
                            />
                            <circle cx={rxHx} cy={rxHy} r={5}
                              fill="white" stroke="rgba(0,0,0,0.35)" strokeWidth={1.5}
                              style={{ cursor: 'col-resize', pointerEvents: 'all' }}
                              onPointerDown={e => onBlurEllipsePointerDown(e, bd.id, 'rx')}
                              onPointerMove={e => onBlurEllipsePointerMove(e, bd.id, 'rx')}
                              onPointerUp={e => onBlurEllipsePointerUp(e, bd.id)}
                            />
                            <circle cx={ryHx} cy={ryHy} r={5}
                              fill="white" stroke="rgba(0,0,0,0.35)" strokeWidth={1.5}
                              style={{ cursor: 'row-resize', pointerEvents: 'all' }}
                              onPointerDown={e => onBlurEllipsePointerDown(e, bd.id, 'ry')}
                              onPointerMove={e => onBlurEllipsePointerMove(e, bd.id, 'ry')}
                              onPointerUp={e => onBlurEllipsePointerUp(e, bd.id)}
                            />
                            <circle cx={rotHx} cy={rotHy} r={5}
                              fill="rgb(249,115,22)" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5}
                              style={{ cursor: 'grab', pointerEvents: 'all' }}
                              onPointerDown={e => onBlurEllipsePointerDown(e, bd.id, 'rot')}
                              onPointerMove={e => onBlurEllipsePointerMove(e, bd.id, 'rot')}
                              onPointerUp={e => onBlurEllipsePointerUp(e, bd.id)}
                            />
                          </>
                        )}
                      </g>
                    )
                  })}
                </svg>
              )
            })()}
          </div>

          {/* Canvas hint (hidden when contrast is active) */}
          {!contrastCheck && (
            <div style={{
              transform: `scale(${1 / view.zoom})`,
              transformOrigin: 'top center',
              marginTop: 14 / view.zoom,
              pointerEvents: 'none',
              display: 'flex',
              gap: 16,
              color: 'rgba(255,255,255,0.2)',
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
              userSelect: 'none',
              letterSpacing: '0.01em',
            }}>
              <span>Hold <b style={{ fontWeight: 500, color: 'rgba(255,255,255,0.32)' }}>Space</b> to pan</span>
              <span><b style={{ fontWeight: 500, color: 'rgba(255,255,255,0.32)' }}>⌘+</b> / <b style={{ fontWeight: 500, color: 'rgba(255,255,255,0.32)' }}>⌘−</b> to zoom</span>
            </div>
          )}

          {/* Contrast controls + legend below canvas */}
          {contrastCheck && (
            <div style={{
              transform: `scale(${1 / view.zoom})`,
              transformOrigin: 'top center',
              marginTop: 10 / view.zoom,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 2,
                background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)',
                border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, padding: '3px 4px',
                fontSize: 11,
              }}>
                {['AA', 'AAA'].map(lvl => (
                  <button key={lvl} data-no-pan="" onClick={() => setContrastLevel(lvl)} style={{
                    padding: '2px 6px', borderRadius: 4, border: 'none',
                    background: contrastLevel === lvl ? 'rgba(139,92,246,0.28)' : 'transparent',
                    color: contrastLevel === lvl ? 'rgba(196,181,253,1)' : 'rgba(255,255,255,0.4)',
                    cursor: 'pointer',
                  }}>{lvl}</button>
                ))}
                <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.1)', margin: '0 2px' }} />
                {[['normal', 'Normal'], ['large', 'Large']].map(([key, label]) => (
                  <button key={key} data-no-pan="" onClick={() => setContrastSize(key)} style={{
                    padding: '2px 6px', borderRadius: 4, border: 'none',
                    background: contrastSize === key ? 'rgba(139,92,246,0.28)' : 'transparent',
                    color: contrastSize === key ? 'rgba(196,181,253,1)' : 'rgba(255,255,255,0.4)',
                    cursor: 'pointer',
                  }}>{label}</button>
                ))}
              </div>
              <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)',
                border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, padding: '4px 8px',
                fontSize: 11, color: 'rgba(255,255,255,0.45)',
              }}>
                {[
                  ['rgb(34,197,94)', 'Both OK'],
                  ['rgb(59,130,246)', 'White OK'],
                  ['rgb(234,179,8)', 'Black OK'],
                  ['rgb(239,68,68)', 'Neither OK'],
                ].map(([color, label]) => (
                  <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block', flexShrink: 0 }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}
          </div>
        </div>

        {/* Ellipse + resize/rotate handles — only for single selection */}
        {selectedDotIds.size === 1 && selectedDot && mode === 'compose' && mainRef.current && canvasRef.current && (() => {
          const sc = canvasToViewport(selectedDot.x, selectedDot.y)
          const rx = selectedDot.rx ?? DEFAULT_RX
          const ry = selectedDot.ry ?? DEFAULT_RY
          const theta = selectedDot.theta ?? 0
          const sRx = rx * view.zoom
          const sRy = ry * view.zoom
          const cosT = Math.cos(theta)
          const sinT = Math.sin(theta)

          // Handle screen positions
          const rxHx = sc.x + sRx * cosT
          const rxHy = sc.y + sRx * sinT
          const ryHx = sc.x - sRy * sinT
          const ryHy = sc.y + sRy * cosT
          const rotHx = sc.x + (sRx + ROT_HANDLE_OFFSET) * cosT
          const rotHy = sc.y + (sRx + ROT_HANDLE_OFFSET) * sinT

          const handleBase = {
            position: 'absolute',
            width: 10, height: 10, borderRadius: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 22, touchAction: 'none',
            border: '1.5px solid rgba(0,0,0,0.35)',
          }

          return (
            <>
              {/* Dashed ellipse outline */}
              <div style={{
                position: 'absolute',
                left: sc.x - sRx, top: sc.y - sRy,
                width: sRx * 2, height: sRy * 2,
                transform: `rotate(${theta}rad)`,
                transformOrigin: 'center',
                border: '1px dashed rgba(255,255,255,0.35)',
                borderRadius: '50%',
                pointerEvents: 'none',
                zIndex: 20,
              }} />

              {/* Line from rx handle to rotation handle */}
              <div style={{
                position: 'absolute',
                left: rxHx, top: rxHy,
                width: ROT_HANDLE_OFFSET,
                height: 1,
                background: 'rgba(255,255,255,0.25)',
                transform: `translate(0, -50%) rotate(${theta}rad)`,
                transformOrigin: '0 50%',
                pointerEvents: 'none',
                zIndex: 21,
              }} />

              {/* rx resize handle (white) */}
              <div data-no-pan=""
                style={{ ...handleBase, left: rxHx, top: rxHy, background: 'white', cursor: 'col-resize' }}
                onPointerDown={e => onEllipseHandlePointerDown(e, 'rx')}
                onPointerMove={e => onEllipseHandlePointerMove(e, 'rx')}
                onPointerUp={e => onEllipseHandlePointerUp(e, 'rx')}
              />

              {/* ry resize handle (white) */}
              <div data-no-pan=""
                style={{ ...handleBase, left: ryHx, top: ryHy, background: 'white', cursor: 'row-resize' }}
                onPointerDown={e => onEllipseHandlePointerDown(e, 'ry')}
                onPointerMove={e => onEllipseHandlePointerMove(e, 'ry')}
                onPointerUp={e => onEllipseHandlePointerUp(e, 'ry')}
              />

              {/* Rotation handle (violet) */}
              <div data-no-pan=""
                style={{ ...handleBase, left: rotHx, top: rotHy, background: 'rgb(139,92,246)', border: '1.5px solid rgba(255,255,255,0.6)', cursor: 'grab' }}
                onPointerDown={e => onEllipseHandlePointerDown(e, 'rot')}
                onPointerMove={e => onEllipseHandlePointerMove(e, 'rot')}
                onPointerUp={e => onEllipseHandlePointerUp(e, 'rot')}
              />
            </>
          )
        })()}

        {/* Dot tooltip — single selection */}
        {selectedDotIds.size === 1 && selectedDot && mode === 'compose' && mainRef.current && canvasRef.current && (() => {
          const sc = canvasToViewport(selectedDot.x, selectedDot.y)
          const tx = sc.x, ty = sc.y
          return (
            <div style={{
              position: 'absolute',
              left: tx, top: ty,
              transform: `translate(-50%, calc(-100% - ${Math.round(14 * view.zoom)}px))`,
              zIndex: 30, pointerEvents: 'auto',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(18,18,22,0.97)',
                border: '1px solid rgba(255,255,255,0.11)',
                borderRadius: 10, padding: '6px 8px',
                backdropFilter: 'blur(14px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.3)',
              }}>
                {present.colors.map((color, i) => {
                  const active = selectedDot.colorId === color.id
                  return (
                    <button key={color.id}
                      onClick={e => { e.stopPropagation(); reassignDot(selectedDot.id, color.id) }}
                      style={{
                        width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                        background: color.hex, cursor: 'pointer', position: 'relative',
                        border: active ? '2.5px solid white' : '1.5px solid rgba(255,255,255,0.18)',
                        boxShadow: active ? '0 0 0 1.5px rgba(139,92,246,0.75)' : 'none',
                      }}
                    >
                      <span style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 800,
                        color: 'rgba(255,255,255,0.88)', textShadow: '0 0 4px rgba(0,0,0,0.7)',
                        pointerEvents: 'none',
                      }}>
                        {LABELS[i]}
                      </span>
                    </button>
                  )
                })}
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.09)', flexShrink: 0, margin: '0 1px' }} />
                <button onClick={e => { e.stopPropagation(); deleteSelectedDots() }}
                  style={{
                    width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'rgba(255,255,255,0.35)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.18)'; e.currentTarget.style.color = 'rgb(239,68,68)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
              {/* Arrow */}
              <div style={{
                position: 'absolute', bottom: -5, left: '50%', marginLeft: -5,
                width: 10, height: 10,
                background: 'rgba(18,18,22,0.97)',
                border: '1px solid rgba(255,255,255,0.11)',
                borderTop: 'none', borderLeft: 'none',
                transform: 'rotate(45deg)',
              }} />
            </div>
          )
        })()}

        {/* Multi-select tooltip */}
        {selectedDotIds.size > 1 && mode === 'compose' && mainRef.current && canvasRef.current && (() => {
          const selDots = present.dots.filter(d => selectedDotIds.has(d.id))
          const cx = selDots.reduce((s, d) => s + d.x, 0) / selDots.length
          const cy = selDots.reduce((s, d) => s + d.y, 0) / selDots.length
          const sc = canvasToViewport(cx, cy)
          return (
            <div style={{
              position: 'absolute',
              left: sc.x, top: sc.y,
              transform: `translate(-50%, calc(-100% - ${Math.round(14 * view.zoom)}px))`,
              zIndex: 30, pointerEvents: 'auto',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(18,18,22,0.97)',
                border: '1px solid rgba(255,255,255,0.11)',
                borderRadius: 10, padding: '6px 10px',
                backdropFilter: 'blur(14px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
              }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', userSelect: 'none' }}>
                  {selectedDotIds.size} dots
                </span>
                <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.09)' }} />
                <button onClick={e => { e.stopPropagation(); deleteSelectedDots() }}
                  style={{
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 6, padding: '3px 8px',
                    fontSize: 11, color: 'rgba(255,255,255,0.35)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.18)'; e.currentTarget.style.color = 'rgb(239,68,68)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
                >
                  <Trash2 size={11} /> Delete
                </button>
              </div>
              <div style={{
                position: 'absolute', bottom: -5, left: '50%', marginLeft: -5,
                width: 10, height: 10,
                background: 'rgba(18,18,22,0.97)',
                border: '1px solid rgba(255,255,255,0.11)',
                borderTop: 'none', borderLeft: 'none',
                transform: 'rotate(45deg)',
              }} />
            </div>
          )
        })()}

        {/* Box-select rectangle */}
        {boxSelect && mainRef.current && (() => {
          const rect = mainRef.current.getBoundingClientRect()
          const x1 = Math.min(boxSelect.startX, boxSelect.curX) - rect.left
          const y1 = Math.min(boxSelect.startY, boxSelect.curY) - rect.top
          const x2 = Math.max(boxSelect.startX, boxSelect.curX) - rect.left
          const y2 = Math.max(boxSelect.startY, boxSelect.curY) - rect.top
          const w = x2 - x1, h = y2 - y1
          if (w < 4 && h < 4) return null
          return (
            <div style={{
              position: 'absolute', left: x1, top: y1, width: w, height: h,
              border: '1px solid rgba(139,92,246,0.7)',
              background: 'rgba(139,92,246,0.08)',
              pointerEvents: 'none', zIndex: 15,
            }} />
          )
        })()}

        {/* Zoom badge */}
        <button
          data-tour="zoom-badge"
          onClick={() => setView({ zoom: 1, pan: { x: 0, y: 0 } })}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 select-none text-[11px] tabular-nums"
          style={{
            color: 'rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(6px)', padding: '3px 9px', borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.07)',
            cursor: 'pointer',
          }}
          title="Reset zoom (⌘0)"
        >
          {Math.round(view.zoom * 100)}%
        </button>

        {/* Contrast toggle — top-left */}
        <button
          data-tour="contrast-toggle"
          data-no-pan=""
          onClick={() => setContrastCheck(c => !c)}
          title="WCAG contrast heatmap"
          className="absolute top-3 left-3 z-20 flex items-center justify-center select-none"
          style={{
            width: 28, height: 28, borderRadius: 6,
            color: contrastCheck ? 'rgba(196,181,253,1)' : 'rgba(255,255,255,0.35)',
            background: contrastCheck ? 'rgba(139,92,246,0.28)' : 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(10px)',
            border: contrastCheck ? '1px solid rgba(139,92,246,0.4)' : '1px solid rgba(255,255,255,0.09)',
            cursor: 'pointer',
          }}
        >
          <Contrast size={13} />
        </button>
      </main>

    </div>
  )
}
