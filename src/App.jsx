import { useState, useRef, useEffect, useLayoutEffect } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────

const CANVAS_W = 800
const CANVAS_H = 600
const MIN_ZOOM = 0.05
const MAX_ZOOM = 10
const ZOOM_STEP = 1.08
const INTER_W = 160
const INTER_H = 120
const MAX_HISTORY = 50
const LS_KEY = 'hazy-palettes'
const DEFAULT_WARP_R = 150
const MIN_WARP_R = 20
const INIT_FILTERS = { grain: 0, blur: 0, contrast: 100, brightness: 100, hue: 0 }
const DEFAULT_RX = 280
const DEFAULT_RY = 280
const MIN_RADIUS = 20
const ROT_HANDLE_OFFSET = 28
const COLOR_DEFAULTS = ['#ff6b6b', '#4fc3f7', '#a29bfe', '#fdcb6e', '#55efc4', '#fd79a8', '#e17055', '#74b9ff']
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

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

function loadPalettes() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}
function writePalettes(p) { localStorage.setItem(LS_KEY, JSON.stringify(p)) }


function buildCSSFilter({ blur, contrast, brightness, hue }) {
  const parts = []
  if (blur > 0) parts.push(`blur(${(blur * 0.2).toFixed(1)}px)`)
  if (contrast !== 100) parts.push(`contrast(${contrast}%)`)
  if (brightness !== 100) parts.push(`brightness(${brightness}%)`)
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
  { id: 'da', colorId: 'ca', x: 200, y: 150, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
  { id: 'db', colorId: 'cb', x: 600, y: 150, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
  { id: 'dc', colorId: 'cc', x: 200, y: 450, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
  { id: 'dd', colorId: 'cd', x: 600, y: 450, rx: DEFAULT_RX, ry: DEFAULT_RY, theta: 0 },
]

const INIT_WARP = { warpDots: [], intensity: 100 }

const INIT_DOC = {
  background: { hex: '#050510', transparent: false },
  size: { w: 800, h: 600 },
  sharpness: 2,
  colors: INIT_COLORS,
  dots: INIT_DOTS,
  warp: INIT_WARP,
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

  const active = (warpDots).filter(d => d.dx !== 0 || d.dy !== 0)
  if (!active.length || scale === 0) {
    visCtx.clearRect(0, 0, W, H)
    visCtx.drawImage(offscreen, 0, 0)
    return
  }

  const offCtx = offscreen.getContext('2d')
  const src = offCtx.getImageData(0, 0, W, H).data
  const destImg = new ImageData(W, H)
  const dest = destImg.data

  const dots = active.map(d => ({
    x: d.x, y: d.y,
    dx: d.dx * scale, dy: d.dy * scale,
    r2: Math.max(1, d.r * d.r),
  }))
  const n = dots.length

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let dxSum = 0, dySum = 0
      for (let i = 0; i < n; i++) {
        const d = dots[i]
        const ex = px - d.x, ey = py - d.y
        const w = Math.exp(-(ex * ex + ey * ey) / d.r2)
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

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconChevron({ open }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: 'transform 0.18s ease', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
function IconUndo() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v6h6" /><path d="M3 13C5.4 7.8 11 4 17 5.3A9 9 0 0121 13" />
    </svg>
  )
}
function IconRedo() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 7v6h-6" /><path d="M21 13C18.6 7.8 13 4 7 5.3A9 9 0 003 13" />
    </svg>
  )
}
function IconTrash() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" />
    </svg>
  )
}
function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}
function IconShuffle() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  )
}
function IconGrid() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
  )
}

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-white/[0.07]">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35 hover:text-white/60 hover:bg-white/[0.04] transition-colors select-none"
      >
        {title}<IconChevron open={open} />
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
        <IconTrash />
      </button>
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

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {

  // ── History ─────────────────────────────────────────────────────────────────

  const [past, setPast] = useState([])
  const [present, _setPresent] = useState(INIT_DOC)
  const [future, setFuture] = useState([])
  const presentRef = useRef(INIT_DOC)

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

  const panDrag = useRef(false)
  const panLast = useRef({ x: 0, y: 0 })
  const dotDrag = useRef(null)
  const warpDotDrag = useRef(null)
  const ellipseDrag = useRef(null)
  const pinchDist = useRef(null)
  const spaceHeld = useRef(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [boxSelect, setBoxSelect] = useState(null)
  const boxSelectRef = useRef(null)

  // ── UI state ─────────────────────────────────────────────────────────────────

  const [smearActive, setSmearActive] = useState(false)
  const [activeColorId, setActiveColorId] = useState(INIT_COLORS[0].id)
  const [selectedDotIds, _setSelectedDotIds] = useState(() => new Set())
  const selectedDotIdsRef = useRef(new Set())
  function setSelectedDotIds(val) {
    const next = typeof val === 'function' ? val(selectedDotIdsRef.current) : val
    selectedDotIdsRef.current = next
    _setSelectedDotIds(next)
  }
  const [selectedWarpDotId, setSelectedWarpDotId] = useState(null)
  const [paletteName, setPaletteName] = useState('')
  const [savedPalettes, setSavedPalettes] = useState(loadPalettes)
  const [wDraft, setWDraft] = useState(String(CANVAS_W))
  const [hDraft, setHDraft] = useState(String(CANVAS_H))

  // ── Canvas render ─────────────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const offscreen = offscreenRef.current
    const inter = interRef.current
    if (!canvas || !offscreen || !inter) return
    const IW = Math.max(1, Math.round(cW / 5))
    const IH = Math.max(1, Math.round(cH / 5))
    if (offscreen.width !== cW || offscreen.height !== cH) {
      offscreen.width = cW; offscreen.height = cH
    }
    if (inter.width !== IW || inter.height !== IH) {
      inter.width = IW; inter.height = IH
    }
    const offCtx = offscreen.getContext('2d')
    renderMeshGradient(inter, offCtx, present)
    const ctx = canvas.getContext('2d')
    applyWarp(ctx, offscreen, present.warp)
  }, [present])

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
    const rect = mainRef.current.getBoundingClientRect()
    const { zoom, pan } = viewRef.current
    const W = presentRef.current.size?.w ?? CANVAS_W
    const H = presentRef.current.size?.h ?? CANVAS_H
    const ox = clientX - (rect.left + rect.width / 2) - pan.x
    const oy = clientY - (rect.top + rect.height / 2) - pan.y
    return { x: ox / zoom + W / 2, y: oy / zoom + H / 2 }
  }

  function canvasToViewport(cx, cy) {
    const { width, height } = mainRef.current.getBoundingClientRect()
    return {
      x: width / 2 + view.pan.x + (cx - cW / 2) * view.zoom,
      y: height / 2 + view.pan.y + (cy - cH / 2) * view.zoom,
    }
  }

  // ── Canvas pan + click-to-place ────────────────────────────────────────────────

  function onMainPointerDown(e) {
    if (e.target.closest('button, input, select, [data-no-pan]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (spaceHeld.current) {
      panDrag.current = true
      panLast.current = { x: e.clientX, y: e.clientY }
    } else if (!smearActive) {
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
    if (smearActive) {
      setSelectedWarpDotId(null)
      return
    }
    const bs = boxSelectRef.current
    if (!bs) return
    boxSelectRef.current = null
    setBoxSelect(null)
    const moved = Math.hypot(bs.curX - bs.startX, bs.curY - bs.startY) > 6
    if (!moved) {
      setSelectedDotIds(new Set())
      return
    }
    const p1 = viewportToCanvas(Math.min(bs.startX, bs.curX), Math.min(bs.startY, bs.curY))
    const p2 = viewportToCanvas(Math.max(bs.startX, bs.curX), Math.max(bs.startY, bs.curY))
    const inside = new Set(presentRef.current.dots
      .filter(d => d.x >= p1.x && d.x <= p2.x && d.y >= p1.y && d.y <= p2.y)
      .map(d => d.id))
    setSelectedDotIds(bs.shiftKey ? prev => new Set([...prev, ...inside]) : inside)
  }

  function onMainDoubleClick(e) {
    if (e.target.closest('button, input, select, [data-no-pan]')) return
    const pos = viewportToCanvas(e.clientX, e.clientY)
    if (smearActive) placeWarpDot(pos.x, pos.y)
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
    const dot = presentRef.current.dots.find(d => d.id === selectedDotId)
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
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedWarpDotId(id)
    const dot = presentRef.current.warp.warpDots.find(d => d.id === id)
    if (!dot) return
    warpDotDrag.current = { type: 'body', id, startX: dot.x, startY: dot.y, clientX: e.clientX, clientY: e.clientY, snapshot: presentRef.current }
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
        warpDots: presentRef.current.warp.warpDots.map(d =>
          d.id === id ? { ...d, x: wd.startX + dx, y: wd.startY + dy } : d
        ),
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
    setSelectedWarpDotId(id)
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

  function onWarpRadiusPointerDown(e, id) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedWarpDotId(id)
    warpDotDrag.current = { type: 'radius', id, snapshot: presentRef.current }
  }
  function onWarpRadiusPointerMove(e, id) {
    const wd = warpDotDrag.current
    if (!wd || wd.type !== 'radius' || wd.id !== id) return
    const dot = presentRef.current.warp.warpDots.find(d => d.id === id)
    if (!dot) return
    const cp = viewportToCanvas(e.clientX, e.clientY)
    const r = Math.max(MIN_WARP_R, Math.hypot(cp.x - dot.x, cp.y - dot.y))
    liveUpdate({
      ...presentRef.current,
      warp: {
        ...presentRef.current.warp,
        warpDots: presentRef.current.warp.warpDots.map(d => d.id === id ? { ...d, r } : d),
      },
    })
  }
  function onWarpRadiusPointerUp(e, id) {
    e.stopPropagation()
    const wd = warpDotDrag.current
    if (!wd || wd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), wd.snapshot])
    setFuture([])
    warpDotDrag.current = null
  }

  // ── Color operations ──────────────────────────────────────────────────────────

  function addColor() {
    const hex = COLOR_DEFAULTS[present.colors.length % COLOR_DEFAULTS.length]
    const newColor = { id: uid(), hex }
    commit({ ...present, colors: [...present.colors, newColor] })
    setActiveColorId(newColor.id)
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
    const dot = { id: uid(), x, y, dx: 0, dy: 0, r: DEFAULT_WARP_R }
    commit({ ...present, warp: { ...present.warp, warpDots: [...(present.warp.warpDots ?? []), dot] } })
    setSelectedWarpDotId(dot.id)
  }

  function deleteSelectedWarpDot() {
    if (!selectedWarpDotId) return
    commit({ ...present, warp: { ...present.warp, warpDots: present.warp.warpDots.filter(d => d.id !== selectedWarpDotId) } })
    setSelectedWarpDotId(null)
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
          r: d.r * Math.sqrt(sX * sY),
        })),
      },
    })
  }

  function exportPNG() {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'hazy-gradient.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  // ── Warp operations ───────────────────────────────────────────────────────────

  function updateWarpIntensity(v) {
    commit({ ...present, warp: { ...present.warp, intensity: v } })
  }
  function clearWarpDots() {
    commit({ ...present, warp: { ...present.warp, warpDots: [] } })
    setSelectedWarpDotId(null)
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

  // ── Keyboard ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && ellipseDrag.current) {
        e.preventDefault()
        syncPresent(ellipseDrag.current.snapshot)
        ellipseDrag.current = null
        return
      }
      if (e.target.tagName === 'INPUT') return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (smearActive && selectedWarpDotId) {
          e.preventDefault()
          deleteSelectedWarpDot()
        } else if (!smearActive && selectedDotIds.size > 0) {
          e.preventDefault()
          deleteSelectedDots()
        }
      }
      if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDotIds, selectedWarpDotId, smearActive, past, future])

  // ── Derived ───────────────────────────────────────────────────────────────────

  const paletteNames = Object.keys(savedPalettes)
  const canUndo = past.length > 0
  const canRedo = future.length > 0
  const selectedDot = selectedDotIds.size === 1
    ? present.dots.find(d => d.id === [...selectedDotIds][0]) ?? null
    : null
  const cssFilter = buildCSSFilter(present.filters)
  const canvasCSS = {
    display: 'block',
    filter: cssFilter,
    ...(present.background.transparent && {
      backgroundImage: 'repeating-conic-gradient(#666 0% 25%, #444 0% 50%)',
      backgroundSize: '16px 16px',
    }),
  }
  const bgPickerRef = useRef(null)
  const [bgHexDraft, setBgHexDraft] = useState(present.background.hex)
  useEffect(() => setBgHexDraft(present.background.hex), [present.background.hex])
  useEffect(() => { setWDraft(String(cW)); setHDraft(String(cH)) }, [cW, cH])

  function commitBgHex(val) {
    const c = /^#/.test(val) ? val : '#' + val
    if (/^#[0-9a-fA-F]{6}$/.test(c)) updateBackground({ ...present.background, hex: c.toLowerCase() })
    else setBgHexDraft(present.background.hex)
  }

  // ── JSX ───────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen overflow-hidden bg-[#111]">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-80 shrink-0 flex flex-col bg-[#181818] border-r border-white/[0.07]">

        <div className="h-12 flex items-center justify-between px-5 border-b border-white/[0.07] shrink-0">
          <span className="text-white text-[17px] font-semibold tracking-tight">Hazy</span>
          <button onClick={exportPNG}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-white/45 border border-white/[0.08] hover:text-white/80 hover:border-white/20 hover:bg-white/[0.06] transition-colors">
            Export PNG
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto min-h-0">

          {/* ── Colors ── */}
          <Section title="Colors" defaultOpen>

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

            {/* Sharpness */}
            <div className="mb-3 pb-3 border-b border-white/[0.06]">
              <FilterSlider label="Sharpness" value={present.sharpness} min={1} max={8} step={0.5} unit=""
                onChange={v => commit({ ...present, sharpness: v })} />
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
                <button onClick={addColor}
                  className="w-full mt-1 flex items-center justify-center gap-1.5 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                  <IconPlus /> Add color
                </button>
              )}
            </div>


            {/* Randomize + palette */}
            <div className="mt-3 pt-3 border-t border-white/[0.06]">
              <button onClick={randomizeColors}
                className="w-full mb-3 flex items-center justify-center gap-1.5 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <IconShuffle /> Randomize colors
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
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          {/* ── Warp ── */}
          <Section title="Warp">
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
          <Section title="Filters">
            <FilterSlider label="Grain" value={present.filters.grain} min={0} max={100} unit="%" onChange={v => updateFilter('grain', v)} />
            <FilterSlider label="Blur" value={present.filters.blur} min={0} max={100} unit="%" onChange={v => updateFilter('blur', v)} />
            <FilterSlider label="Contrast" value={present.filters.contrast} min={100} max={200} unit="%" onChange={v => updateFilter('contrast', v)} />
            <FilterSlider label="Brightness" value={present.filters.brightness} min={100} max={200} unit="%" onChange={v => updateFilter('brightness', v)} />
            <FilterSlider label="Hue rotate" value={present.filters.hue} min={0} max={360} unit="°" onChange={v => updateFilter('hue', v)} />
            <button onClick={resetFilters}
              className="w-full mt-1 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
              Reset filters
            </button>
          </Section>

          {/* ── Size ── */}
          <Section title="Size">
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
        <div className="shrink-0 p-3 border-t border-white/[0.07] flex gap-2">
          <button onClick={undo} disabled={!canUndo}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-colors disabled:opacity-20 disabled:cursor-not-allowed text-white/40 enabled:hover:text-white/70 enabled:hover:bg-white/[0.06]">
            <IconUndo /> Undo
          </button>
          <div className="w-px bg-white/[0.07]" />
          <button onClick={redo} disabled={!canRedo}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-colors disabled:opacity-20 disabled:cursor-not-allowed text-white/40 enabled:hover:text-white/70 enabled:hover:bg-white/[0.06]">
            Redo <IconRedo />
          </button>
        </div>
      </aside>

      {/* ── Canvas area ──────────────────────────────────────────────────── */}
      <main
        ref={mainRef}
        className="flex-1 relative overflow-hidden"
        style={{ cursor: spaceDown ? 'grab' : smearActive || activeColorId ? 'crosshair' : 'default' }}
        onPointerDown={onMainPointerDown}
        onPointerMove={onMainPointerMove}
        onPointerUp={onMainPointerUp}
        onPointerLeave={() => { panDrag.current = false; boxSelectRef.current = null; setBoxSelect(null) }}
        onDoubleClick={onMainDoubleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      >
        {/* Mode switcher */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 select-none" data-no-pan="">
          <div style={{
            display: 'flex', gap: 2, padding: 3,
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 10,
            backdropFilter: 'blur(10px)',
          }}>
            {[['Compose', false], ['Warp', true]].map(([label, isWarp]) => (
              <button key={label} data-no-pan=""
                onClick={() => {
                  setSmearActive(isWarp)
                  if (isWarp) setSelectedDotIds(new Set())
                  else setSelectedWarpDotId(null)
                }}
                style={{
                  padding: '4px 14px',
                  borderRadius: 7,
                  fontSize: 11, fontWeight: 500,
                  border: 'none', cursor: 'pointer',
                  transition: 'background 0.15s, color 0.15s',
                  background: smearActive === isWarp
                    ? 'rgba(139,92,246,0.28)'
                    : 'transparent',
                  color: smearActive === isWarp
                    ? 'rgba(196,181,253,1)'
                    : 'rgba(255,255,255,0.38)',
                  boxShadow: smearActive === isWarp
                    ? 'inset 0 0 0 1px rgba(139,92,246,0.4)'
                    : 'none',
                }}>
                {label}
              </button>
            ))}
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
            boxShadow: '0 24px 80px rgba(0,0,0,0.75), 0 8px 24px rgba(0,0,0,0.5)',
          }}>
            <canvas ref={canvasRef} width={cW} height={cH} style={canvasCSS} />

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
            {!smearActive && present.dots.map(dot => {
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
            {smearActive && (
              <svg style={{
                position: 'absolute', left: 0, top: 0,
                width: cW, height: cH,
                overflow: 'visible', pointerEvents: 'none',
              }}>
                {(present.warp.warpDots ?? []).map(wd => {
                  const sel = selectedWarpDotId === wd.id
                  const ax = wd.x + wd.dx, ay = wd.y + wd.dy
                  const hasDelta = wd.dx !== 0 || wd.dy !== 0
                  return (
                    <g key={wd.id}>
                      <circle cx={wd.x} cy={wd.y} r={wd.r}
                        fill={sel ? 'rgba(139,92,246,0.06)' : 'rgba(255,255,255,0.02)'}
                        stroke={sel ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.12)'}
                        strokeWidth={1} strokeDasharray="4 3" pointerEvents="none"
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
                      {sel && (
                        <circle cx={wd.x + wd.r} cy={wd.y} r={5}
                          fill="white" stroke="rgba(0,0,0,0.35)" strokeWidth={1.5}
                          style={{ cursor: 'ew-resize', pointerEvents: 'all' }}
                          onPointerDown={e => onWarpRadiusPointerDown(e, wd.id)}
                          onPointerMove={e => onWarpRadiusPointerMove(e, wd.id)}
                          onPointerUp={e => onWarpRadiusPointerUp(e, wd.id)}
                        />
                      )}
                    </g>
                  )
                })}
              </svg>
            )}
          </div>
        </div>

        {/* Ellipse + resize/rotate handles — only for single selection */}
        {selectedDotIds.size === 1 && selectedDot && !smearActive && mainRef.current && (() => {
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
        {selectedDotIds.size === 1 && selectedDot && !smearActive && mainRef.current && (() => {
          const { width, height } = mainRef.current.getBoundingClientRect()
          const tx = width / 2 + view.pan.x + (selectedDot.x - cW / 2) * view.zoom
          const ty = height / 2 + view.pan.y + (selectedDot.y - cH / 2) * view.zoom
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
                  <IconTrash />
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
        {selectedDotIds.size > 1 && !smearActive && mainRef.current && (() => {
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
                  <IconTrash /> Delete
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
        <div className="absolute bottom-4 right-4 select-none text-[11px] tabular-nums"
          style={{
            color: 'rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(6px)', padding: '3px 9px', borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.07)',
          }}>
          {Math.round(view.zoom * 100)}%
        </div>
      </main>

    </div>
  )
}
