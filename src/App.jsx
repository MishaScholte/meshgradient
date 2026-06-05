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
const WARP_DENSITIES = [3, 5, 8, 10]
const INIT_FILTERS = { grain: 0, blur: 0, contrast: 100, brightness: 100, hue: 0 }
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

function makeDisplacements(N) {
  return Array.from({ length: N * N }, () => ({ dx: 0, dy: 0 }))
}

function getOrigPos(row, col, N) {
  return { x: col * CANVAS_W / (N - 1), y: row * CANVAS_H / (N - 1) }
}

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
  { id: 'da', colorId: 'ca', x: 200, y: 150 },
  { id: 'db', colorId: 'cb', x: 600, y: 150 },
  { id: 'dc', colorId: 'cc', x: 200, y: 450 },
  { id: 'dd', colorId: 'cd', x: 600, y: 450 },
]

const INIT_WARP = { N: 5, displacements: makeDisplacements(5), intensity: 100 }

const INIT_DOC = {
  background: { hex: '#050510', transparent: false },
  colors: INIT_COLORS,
  dots: INIT_DOTS,
  warp: INIT_WARP,
  filters: INIT_FILTERS,
}

// ─── Render pipeline ──────────────────────────────────────────────────────────

function renderMeshGradient(interCanvas, offCtx, { background, colors, dots }) {
  const W = CANVAS_W, H = CANVAS_H
  const IW = INTER_W, IH = INTER_H
  const scaleX = W / IW, scaleY = H / IH

  const colorMap = {}
  colors.forEach(c => { colorMap[c.id] = c })

  const cpts = dots.map(dot => {
    const color = colorMap[dot.colorId]
    if (!color) return null
    const { r, g, b } = hexToRgb(color.hex)
    return { x: dot.x / scaleX, y: dot.y / scaleY, r, g, b }
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
        if (d2 < 1) { rSum = pt.r; gSum = pt.g; bSum = pt.b; wSum = 1; break }
        const w = 1 / d2
        rSum += pt.r * w; gSum += pt.g * w; bSum += pt.b * w; wSum += w
      }

      const idx = (py * IW + px) << 2
      data[idx]   = (rSum / wSum + 0.5) | 0
      data[idx+1] = (gSum / wSum + 0.5) | 0
      data[idx+2] = (bSum / wSum + 0.5) | 0
      data[idx+3] = 255
    }
  }

  interCtx.putImageData(imgData, 0, 0)
  offCtx.save()
  offCtx.imageSmoothingEnabled = true
  offCtx.imageSmoothingQuality = 'high'
  offCtx.drawImage(interCanvas, 0, 0, W, H)
  offCtx.restore()
}

function applyWarp(visCtx, offscreen, { N, displacements, intensity }) {
  const scale = intensity / 100
  const W = CANVAS_W, H = CANVAS_H

  const dxArr = new Float32Array(N * N)
  const dyArr = new Float32Array(N * N)
  let anyDisplaced = false
  for (let k = 0; k < N * N; k++) {
    const d = displacements[k]
    dxArr[k] = d.dx * scale
    dyArr[k] = d.dy * scale
    if (d.dx !== 0 || d.dy !== 0) anyDisplaced = true
  }

  if (!anyDisplaced || scale === 0) {
    visCtx.clearRect(0, 0, W, H)
    visCtx.drawImage(offscreen, 0, 0)
    return
  }

  const offCtx = offscreen.getContext('2d')
  const src = offCtx.getImageData(0, 0, W, H).data
  const destImg = new ImageData(W, H)
  const dest = destImg.data
  const Nm1 = N - 1

  for (let py = 0; py < H; py++) {
    const vf = py / H * Nm1
    const cj = vf < Nm1 ? vf | 0 : Nm1 - 1
    const lv = vf - cj, lv1 = 1 - lv
    const r0 = cj * N, r1 = r0 + N

    for (let px = 0; px < W; px++) {
      const uf = px / W * Nm1
      const ci = uf < Nm1 ? uf | 0 : Nm1 - 1
      const lu = uf - ci, lu1 = 1 - lu

      const i00 = r0+ci, i10 = i00+1, i01 = r1+ci, i11 = i01+1
      const w00 = lu1*lv1, w10 = lu*lv1, w01 = lu1*lv, w11 = lu*lv

      const dx = dxArr[i00]*w00 + dxArr[i10]*w10 + dxArr[i01]*w01 + dxArr[i11]*w11
      const dy = dyArr[i00]*w00 + dyArr[i10]*w10 + dyArr[i01]*w01 + dyArr[i11]*w11

      let sx = (px - dx + 0.5) | 0, sy = (py - dy + 0.5) | 0
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

// ─── WarpGrid overlay ─────────────────────────────────────────────────────────

function WarpGrid({ N, displacements, onPointerDown, onPointerMove, onPointerUp }) {
  function dp(row, col) {
    const orig = getOrigPos(row, col, N)
    const d = displacements[row * N + col]
    return { x: orig.x + d.dx, y: orig.y + d.dy }
  }

  const lines = []
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N - 1; col++) {
      const a = dp(row, col), b = dp(row, col + 1)
      lines.push(<line key={`h${row}-${col}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
        stroke="rgba(255,255,255,0.22)" strokeWidth="0.75" />)
    }
  }
  for (let row = 0; row < N - 1; row++) {
    for (let col = 0; col < N; col++) {
      const a = dp(row, col), b = dp(row + 1, col)
      lines.push(<line key={`v${row}-${col}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
        stroke="rgba(255,255,255,0.22)" strokeWidth="0.75" />)
    }
  }

  const handles = []
  for (let k = 0; k < N * N; k++) {
    const row = (k / N) | 0, col = k % N
    const p = dp(row, col)
    const moved = displacements[k].dx !== 0 || displacements[k].dy !== 0
    handles.push(
      <circle key={k} cx={p.x} cy={p.y} r={5}
        fill={moved ? '#a78bfa' : 'rgba(255,255,255,0.5)'}
        stroke={moved ? 'rgba(109,40,217,0.9)' : 'rgba(0,0,0,0.45)'}
        strokeWidth="1.5"
        style={{ cursor: 'move', pointerEvents: 'all' }}
        onPointerDown={e => onPointerDown(e, k)}
        onPointerMove={e => onPointerMove(e, k)}
        onPointerUp={e => onPointerUp(e, k)}
      />
    )
  }

  return (
    <svg style={{
      position: 'absolute', left: 0, top: 0,
      width: CANVAS_W, height: CANVAS_H,
      overflow: 'visible', pointerEvents: 'none',
    }}>
      {lines}
      {handles}
    </svg>
  )
}

// ─── FilterSlider ─────────────────────────────────────────────────────────────

function FilterSlider({ label, value, min, max, unit, onChange }) {
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-[10px] text-white/40 uppercase tracking-wide">{label}</span>
        <span className="text-[10px] text-white/35 tabular-nums">{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={value}
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
  const panStart = useRef({ x: 0, y: 0 })
  const panMoved = useRef(false)
  const dotDrag = useRef(null)
  const gridDrag = useRef(null)
  const pinchDist = useRef(null)

  // ── UI state ─────────────────────────────────────────────────────────────────

  const [smearActive, setSmearActive] = useState(false)
  const [activeColorId, setActiveColorId] = useState(INIT_COLORS[0].id)
  const [selectedDotId, setSelectedDotId] = useState(null)
  const [paletteName, setPaletteName] = useState('')
  const [savedPalettes, setSavedPalettes] = useState(loadPalettes)

  // ── Canvas render ─────────────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const offscreen = offscreenRef.current
    const inter = interRef.current
    if (!canvas || !offscreen || !inter) return
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

  // ── Canvas coordinate conversion ──────────────────────────────────────────────

  function viewportToCanvas(clientX, clientY) {
    const rect = mainRef.current.getBoundingClientRect()
    const { zoom, pan } = viewRef.current
    const ox = clientX - (rect.left + rect.width / 2) - pan.x
    const oy = clientY - (rect.top + rect.height / 2) - pan.y
    return { x: ox / zoom + CANVAS_W / 2, y: oy / zoom + CANVAS_H / 2 }
  }

  // ── Canvas pan + click-to-place ────────────────────────────────────────────────

  function onMainPointerDown(e) {
    if (e.target.closest('button, input, select, [data-no-pan]')) return
    panDrag.current = true
    panMoved.current = false
    panLast.current = { x: e.clientX, y: e.clientY }
    panStart.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onMainPointerMove(e) {
    if (!panDrag.current) return
    const dx = e.clientX - panStart.current.x
    const dy = e.clientY - panStart.current.y
    if (Math.hypot(dx, dy) > 4) panMoved.current = true
    const mdx = e.clientX - panLast.current.x
    const mdy = e.clientY - panLast.current.y
    panLast.current = { x: e.clientX, y: e.clientY }
    const v = viewRef.current
    setView({ ...v, pan: { x: v.pan.x + mdx, y: v.pan.y + mdy } })
  }
  function onMainPointerUp(e) {
    if (panDrag.current && !panMoved.current && !smearActive) {
      // Click on canvas → place a dot
      const pos = viewportToCanvas(e.clientX, e.clientY)
      placeDot(pos.x, pos.y)
    }
    panDrag.current = false
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
    e.currentTarget.setPointerCapture(e.pointerId)
    const dot = presentRef.current.dots.find(d => d.id === id)
    dotDrag.current = { id, startX: dot.x, startY: dot.y, clientX: e.clientX, clientY: e.clientY, snapshot: presentRef.current }
    setSelectedDotId(id)
    panMoved.current = true // prevent click-to-place on pointer up
  }
  function onDotPointerMove(e, id) {
    const dd = dotDrag.current
    if (!dd || dd.id !== id) return
    const dx = (e.clientX - dd.clientX) / viewRef.current.zoom
    const dy = (e.clientY - dd.clientY) / viewRef.current.zoom
    liveUpdate({
      ...presentRef.current,
      dots: presentRef.current.dots.map(d =>
        d.id === id ? { ...d, x: dd.startX + dx, y: dd.startY + dy } : d
      ),
    })
  }
  function onDotPointerUp(e, id) {
    const dd = dotDrag.current
    if (!dd || dd.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), dd.snapshot])
    setFuture([])
    dotDrag.current = null
  }

  // ── Warp handle drag ──────────────────────────────────────────────────────────

  function onGridPointerDown(e, k) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const d = presentRef.current.warp.displacements[k]
    gridDrag.current = { k, startDx: d.dx, startDy: d.dy, clientX: e.clientX, clientY: e.clientY, snapshot: presentRef.current }
  }
  function onGridPointerMove(e, k) {
    const gd = gridDrag.current
    if (!gd || gd.k !== k) return
    const ddx = (e.clientX - gd.clientX) / viewRef.current.zoom
    const ddy = (e.clientY - gd.clientY) / viewRef.current.zoom
    const newDisp = [...presentRef.current.warp.displacements]
    newDisp[k] = { dx: gd.startDx + ddx, dy: gd.startDy + ddy }
    liveUpdate({ ...presentRef.current, warp: { ...presentRef.current.warp, displacements: newDisp } })
  }
  function onGridPointerUp(e, k) {
    const gd = gridDrag.current
    if (!gd || gd.k !== k) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), gd.snapshot])
    setFuture([])
    gridDrag.current = null
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
    if (selectedDotId) {
      const dot = present.dots.find(d => d.id === selectedDotId)
      if (dot?.colorId === id) setSelectedDotId(null)
    }
  }

  // ── Dot operations ────────────────────────────────────────────────────────────

  function placeDot(x, y) {
    if (!activeColorId || !present.colors.find(c => c.id === activeColorId)) return
    const dot = { id: uid(), colorId: activeColorId, x, y }
    commit({ ...present, dots: [...present.dots, dot] })
    setSelectedDotId(dot.id)
  }

  function reassignDot(dotId, colorId) {
    commit({ ...present, dots: present.dots.map(d => d.id === dotId ? { ...d, colorId } : d) })
  }

  function deleteSelectedDot() {
    if (!selectedDotId) return
    commit({ ...present, dots: present.dots.filter(d => d.id !== selectedDotId) })
    setSelectedDotId(null)
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

  // ── Warp operations ───────────────────────────────────────────────────────────

  function setGridDensity(n) {
    commit({ ...present, warp: { ...present.warp, N: n, displacements: makeDisplacements(n) } })
  }
  function updateWarpIntensity(v) {
    commit({ ...present, warp: { ...present.warp, intensity: v } })
  }
  function resetWarp() {
    commit({ ...present, warp: { ...present.warp, displacements: makeDisplacements(present.warp.N) } })
  }
  function randomizeWarp() {
    const { N } = present.warp
    const rand = seededRand(Date.now())
    const maxDisp = Math.min(CANVAS_W, CANVAS_H) / (N - 1) * 0.45
    commit({
      ...present,
      warp: {
        ...present.warp,
        displacements: Array.from({ length: N * N }, () => ({
          dx: (rand() - 0.5) * 2 * maxDisp,
          dy: (rand() - 0.5) * 2 * maxDisp,
        })),
      },
    })
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
    setSelectedDotId(null)
    if (p.colors?.length) setActiveColorId(p.colors[0].id)
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDotId) {
        e.preventDefault()
        deleteSelectedDot()
      }
      if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDotId, past, future])

  // ── Derived ───────────────────────────────────────────────────────────────────

  const paletteNames = Object.keys(savedPalettes)
  const canUndo = past.length > 0
  const canRedo = future.length > 0
  const selectedDot = selectedDotId ? present.dots.find(d => d.id === selectedDotId) : null
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

        <div className="h-12 flex items-center px-5 border-b border-white/[0.07] shrink-0">
          <span className="text-white text-[17px] font-semibold tracking-tight">Hazy</span>
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
                <select defaultValue="" key={paletteNames.join(',')}
                  onChange={e => { if (e.target.value) loadPaletteByName(e.target.value) }}
                  className="w-full bg-white/[0.05] border border-white/[0.08] rounded px-2 py-1 text-[11px] text-white/45 outline-none focus:border-white/20 cursor-pointer"
                  style={{ colorScheme: 'dark' }}>
                  <option value="" disabled>Load palette…</option>
                  {paletteNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
            </div>
          </Section>

          {/* ── Warp ── */}
          <Section title="Warp">
            <div className="mb-3">
              <div className="text-[10px] text-white/30 mb-1.5 uppercase tracking-wide">Grid density</div>
              <div className="flex gap-1">
                {WARP_DENSITIES.map(n => (
                  <button key={n} onClick={() => setGridDensity(n)}
                    className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors border ${
                      present.warp.N === n
                        ? 'bg-violet-500/20 border-violet-500/40 text-violet-300'
                        : 'bg-white/[0.04] border-white/[0.08] text-white/35 hover:text-white/65 hover:bg-white/[0.08]'
                    }`}>
                    {n}×{n}
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-3">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[10px] text-white/30 uppercase tracking-wide">Intensity</span>
                <span className="text-[10px] text-white/40 tabular-nums">{present.warp.intensity}%</span>
              </div>
              <input type="range" min={0} max={100} value={present.warp.intensity}
                onChange={e => updateWarpIntensity(+e.target.value)}
                className="w-full accent-violet-400" style={{ cursor: 'pointer' }} />
            </div>
            <div className="flex gap-1.5">
              <button onClick={resetWarp}
                className="flex-1 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                Reset warp
              </button>
              <button onClick={randomizeWarp}
                className="flex-1 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                Randomize
              </button>
            </div>
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

          {/* ── Export ── */}
          <Section title="Export">
            <p className="text-white/25 text-xs">PNG, SVG, and CSS export options will appear here.</p>
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
        style={{ cursor: smearActive ? 'grab' : activeColorId ? 'crosshair' : 'grab' }}
        onPointerDown={onMainPointerDown}
        onPointerMove={onMainPointerMove}
        onPointerUp={onMainPointerUp}
        onPointerLeave={() => { panDrag.current = false }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      >
        {/* Smear toggle */}
        <div className="absolute top-3 left-3 z-20">
          <button
            data-no-pan=""
            onClick={() => setSmearActive(a => !a)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all select-none ${
              smearActive
                ? 'bg-violet-500/25 border border-violet-400/40 text-violet-300 shadow-lg shadow-violet-900/20'
                : 'bg-black/40 border border-white/10 text-white/45 hover:text-white/75 hover:bg-black/55'
            }`}
            style={{ backdropFilter: 'blur(8px)' }}
          >
            <IconGrid />
            {smearActive ? 'Smear: ON' : 'Smear'}
          </button>
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
            <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={canvasCSS} />

            {/* Grain overlay */}
            {present.filters.grain > 0 && (
              <svg style={{
                position: 'absolute', left: 0, top: 0,
                width: CANVAS_W, height: CANVAS_H,
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
                <rect width={CANVAS_W} height={CANVAS_H} filter="url(#hazy-grain)" />
              </svg>
            )}

            {/* Dots */}
            {!smearActive && present.dots.map(dot => {
              const color = present.colors.find(c => c.id === dot.colorId)
              if (!color) return null
              const colorIndex = present.colors.indexOf(color)
              const label = LABELS[colorIndex] ?? ''
              const selected = dot.id === selectedDotId
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

            {/* Warp grid */}
            {smearActive && (
              <WarpGrid
                N={present.warp.N}
                displacements={present.warp.displacements}
                onPointerDown={onGridPointerDown}
                onPointerMove={onGridPointerMove}
                onPointerUp={onGridPointerUp}
              />
            )}
          </div>
        </div>

        {/* Dot tooltip */}
        {selectedDot && mainRef.current && (() => {
          const { width, height } = mainRef.current.getBoundingClientRect()
          const tx = width / 2 + view.pan.x + (selectedDot.x - CANVAS_W / 2) * view.zoom
          const ty = height / 2 + view.pan.y + (selectedDot.y - CANVAS_H / 2) * view.zoom
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
                <button onClick={e => { e.stopPropagation(); deleteSelectedDot() }}
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
