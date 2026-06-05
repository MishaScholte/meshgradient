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
const MESH_DENSITIES = [[2, 2], [3, 3], [4, 4], [5, 5]]
const INIT_FILTERS = { grain: 0, blur: 0, contrast: 100, brightness: 100, hue: 0 }

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

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v =>
    Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  ).join('')
}

function seededRand(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000 }
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

// Bilinearly interpolate default corner colors across the grid
function defaultMeshColors(rows, cols) {
  const tl = hexToRgb('#ff6b6b'), tr = hexToRgb('#4fc3f7')
  const bl = hexToRgb('#a29bfe'), br = hexToRgb('#fdcb6e')
  const result = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = cols > 0 ? c / cols : 0
      const v = rows > 0 ? r / rows : 0
      result.push(rgbToHex({
        r: tl.r*(1-u)*(1-v) + tr.r*u*(1-v) + bl.r*(1-u)*v + br.r*u*v,
        g: tl.g*(1-u)*(1-v) + tr.g*u*(1-v) + bl.g*(1-u)*v + br.g*u*v,
        b: tl.b*(1-u)*(1-v) + tr.b*u*(1-v) + bl.b*(1-u)*v + br.b*u*v,
      }))
    }
  }
  return result
}

function makeMeshPoints(rows, cols, colors) {
  const defs = colors || defaultMeshColors(rows, cols)
  const pts = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      pts.push({ id: `r${r}c${c}`, color: defs[r * (cols + 1) + c] || '#888888', opacity: 100 })
    }
  }
  return pts
}

function makeMeshPositions(rows, cols) {
  const pos = {}
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      pos[`r${r}c${c}`] = { x: (c / cols) * CANVAS_W, y: (r / rows) * CANVAS_H }
    }
  }
  return pos
}

// ─── Initial document ─────────────────────────────────────────────────────────

const INIT_ROWS = 3, INIT_COLS = 3

const INIT_MESH = {
  rows: INIT_ROWS, cols: INIT_COLS,
  points: makeMeshPoints(INIT_ROWS, INIT_COLS),
  positions: makeMeshPositions(INIT_ROWS, INIT_COLS),
}

const INIT_WARP = { N: 5, displacements: makeDisplacements(5), intensity: 100 }

const INIT_DOC = {
  background: { hex: '#050510', transparent: false },
  mesh: INIT_MESH,
  warp: INIT_WARP,
  filters: INIT_FILTERS,
}

// ─── Render pipeline ──────────────────────────────────────────────────────────

// IDW (Inverse Distance Weighting) mesh gradient.
// Renders at INTER_W×INTER_H then scales up to the offscreen canvas via drawImage.
function renderMeshGradient(interCanvas, offCtx, { background, mesh }) {
  const { points, positions } = mesh
  const W = CANVAS_W, H = CANVAS_H
  const IW = INTER_W, IH = INTER_H
  const scaleX = W / IW, scaleY = H / IH

  // Map control points to inter-canvas coordinate space
  const cpts = points.map(pt => {
    const pos = positions[pt.id] || { x: W / 2, y: H / 2 }
    const { r, g, b } = hexToRgb(pt.color)
    return { x: pos.x / scaleX, y: pos.y / scaleY, r, g, b, a: pt.opacity / 100 }
  })

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
        const w = pt.a / d2
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

  offCtx.clearRect(0, 0, W, H)
  if (!background.transparent) {
    offCtx.fillStyle = background.hex
    offCtx.fillRect(0, 0, W, H)
  }
  offCtx.save()
  offCtx.imageSmoothingEnabled = true
  offCtx.imageSmoothingQuality = 'high'
  offCtx.drawImage(interCanvas, 0, 0, W, H)
  offCtx.restore()
}

// Inverse-map bilinear warp: for each output pixel, interpolate the displacement
// at its grid cell and sample the source at (px - dx, py - dy).
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
    const lv = vf - cj
    const lv1 = 1 - lv
    const r0 = cj * N
    const r1 = r0 + N

    for (let px = 0; px < W; px++) {
      const uf = px / W * Nm1
      const ci = uf < Nm1 ? uf | 0 : Nm1 - 1
      const lu = uf - ci
      const lu1 = 1 - lu

      const i00 = r0 + ci, i10 = i00 + 1
      const i01 = r1 + ci, i11 = i01 + 1

      const w00 = lu1 * lv1, w10 = lu * lv1
      const w01 = lu1 * lv,  w11 = lu * lv

      const dx = dxArr[i00]*w00 + dxArr[i10]*w10 + dxArr[i01]*w01 + dxArr[i11]*w11
      const dy = dyArr[i00]*w00 + dyArr[i10]*w10 + dyArr[i01]*w01 + dyArr[i11]*w11

      let sx = (px - dx + 0.5) | 0
      let sy = (py - dy + 0.5) | 0
      if (sx < 0) sx = 0; else if (sx >= W) sx = W - 1
      if (sy < 0) sy = 0; else if (sy >= H) sy = H - 1

      const si = (sy * W + sx) << 2
      const di = (py * W + px) << 2
      dest[di]   = src[si]
      dest[di+1] = src[si+1]
      dest[di+2] = src[si+2]
      dest[di+3] = src[si+3]
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
function IconReset() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
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

// ─── MiniColorPicker ──────────────────────────────────────────────────────────

function MiniColorPicker({ hex, opacity, onChangeHex, onChangeOpacity, showOpacity = true }) {
  const pickerRef = useRef(null)
  const [draft, setDraft] = useState(hex)
  useEffect(() => setDraft(hex), [hex])

  function commitHex(val) {
    const c = /^#/.test(val) ? val : '#' + val
    if (/^#[0-9a-fA-F]{6}$/.test(c)) onChangeHex(c.toLowerCase())
    else setDraft(hex)
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <div onClick={() => pickerRef.current?.click()} style={{
          width: 22, height: 22, borderRadius: 5, flexShrink: 0,
          background: hex, border: '1.5px solid rgba(255,255,255,0.12)', cursor: 'pointer',
        }} />
        <input ref={pickerRef} type="color" value={hex}
          onChange={e => onChangeHex(e.target.value)}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }} />
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={e => commitHex(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && commitHex(draft)}
          maxLength={7}
          className="font-mono text-[11px] text-white/60 bg-white/[0.05] border border-white/[0.08] rounded px-1.5 py-0.5 outline-none focus:border-white/20 w-[68px] shrink-0"
          spellCheck={false}
        />
      </div>
      {showOpacity && (
        <div className="flex items-center gap-1.5">
          <input type="range" min={0} max={100} value={opacity}
            onChange={e => onChangeOpacity(+e.target.value)}
            className="flex-1 accent-violet-400 h-px" style={{ cursor: 'pointer' }} />
          <span className="text-[10px] text-white/25 w-6 text-right shrink-0 tabular-nums">{opacity}</span>
        </div>
      )}
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

  // Offscreen canvas: receives the mesh gradient, fed into warp
  const offscreenRef = useRef(null)
  if (!offscreenRef.current) {
    const c = document.createElement('canvas')
    c.width = CANVAS_W; c.height = CANVAS_H
    offscreenRef.current = c
  }

  // Intermediate canvas: IDW rendered at low res, then scaled up to offscreen
  const interRef = useRef(null)
  if (!interRef.current) {
    const c = document.createElement('canvas')
    c.width = INTER_W; c.height = INTER_H
    interRef.current = c
  }

  const panDrag = useRef(false)
  const panLast = useRef({ x: 0, y: 0 })
  const meshDrag = useRef(null)
  const gridDrag = useRef(null)
  const pinchDist = useRef(null)

  // ── UI state ─────────────────────────────────────────────────────────────────

  const [paletteName, setPaletteName] = useState('')
  const [savedPalettes, setSavedPalettes] = useState(loadPalettes)
  const [smearActive, setSmearActive] = useState(false)
  const [selectedPointId, setSelectedPointId] = useState(null)

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

  // ── Canvas pan ────────────────────────────────────────────────────────────────

  function onMainPointerDown(e) {
    if (e.target.closest('button, input, select, [data-no-pan]')) return
    panDrag.current = true
    panLast.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onMainPointerMove(e) {
    if (!panDrag.current) return
    const dx = e.clientX - panLast.current.x
    const dy = e.clientY - panLast.current.y
    panLast.current = { x: e.clientX, y: e.clientY }
    const v = viewRef.current
    setView({ ...v, pan: { x: v.pan.x + dx, y: v.pan.y + dy } })
  }
  function onMainPointerUp() { panDrag.current = false }

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

  // ── Mesh point drag ───────────────────────────────────────────────────────────

  function onMeshPointerDown(e, id) {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const pos = presentRef.current.mesh.positions[id]
    meshDrag.current = { id, startX: pos.x, startY: pos.y, clientX: e.clientX, clientY: e.clientY, snapshot: presentRef.current }
    setSelectedPointId(id)
  }
  function onMeshPointerMove(e, id) {
    const md = meshDrag.current
    if (!md || md.id !== id) return
    const dx = (e.clientX - md.clientX) / viewRef.current.zoom
    const dy = (e.clientY - md.clientY) / viewRef.current.zoom
    liveUpdate({
      ...presentRef.current,
      mesh: {
        ...presentRef.current.mesh,
        positions: { ...presentRef.current.mesh.positions, [id]: { x: md.startX + dx, y: md.startY + dy } },
      },
    })
  }
  function onMeshPointerUp(e, id) {
    const md = meshDrag.current
    if (!md || md.id !== id) return
    setPast(p => [...p.slice(-(MAX_HISTORY - 1)), md.snapshot])
    setFuture([])
    meshDrag.current = null
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

  // ── Background operations ─────────────────────────────────────────────────────

  function updateBackground(bg) { commit({ ...present, background: bg }) }

  // ── Mesh operations ───────────────────────────────────────────────────────────

  function updateMeshPoint(id, update) {
    commit({
      ...present,
      mesh: {
        ...present.mesh,
        points: present.mesh.points.map(pt => pt.id === id ? { ...pt, ...update } : pt),
      },
    })
  }

  function setMeshDensity(rows, cols) {
    commit({
      ...present,
      mesh: {
        rows, cols,
        points: makeMeshPoints(rows, cols),
        positions: makeMeshPositions(rows, cols),
      },
    })
    setSelectedPointId(null)
  }

  function randomizeMeshColors() {
    const rand = seededRand(Date.now())
    commit({
      ...present,
      mesh: {
        ...present.mesh,
        points: present.mesh.points.map(pt => ({
          ...pt,
          color: rgbToHex({ r: rand() * 255, g: rand() * 255, b: rand() * 255 }),
        })),
      },
    })
  }

  function resetMeshPositions() {
    const { rows, cols } = present.mesh
    commit({ ...present, mesh: { ...present.mesh, positions: makeMeshPositions(rows, cols) } })
  }

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
    all[name] = { mesh: present.mesh, background: present.background, warp: present.warp, filters: present.filters }
    writePalettes(all)
    setSavedPalettes({ ...all })
    setPaletteName('')
  }
  function loadPaletteByName(name) {
    const all = loadPalettes(); const p = all[name]; if (!p) return
    commit({
      ...present,
      mesh: p.mesh ?? present.mesh,
      background: p.background ?? present.background,
      warp: p.warp ?? present.warp,
      filters: p.filters ?? INIT_FILTERS,
    })
    setSelectedPointId(null)
  }

  // ── Derived ───────────────────────────────────────────────────────────────────

  const paletteNames = Object.keys(savedPalettes)
  const canUndo = past.length > 0
  const canRedo = future.length > 0
  const selectedPoint = selectedPointId ? present.mesh.points.find(p => p.id === selectedPointId) : null
  const cssFilter = buildCSSFilter(present.filters)
  const canvasCSS = {
    display: 'block',
    filter: cssFilter,
    ...(present.background.transparent && {
      backgroundImage: 'repeating-conic-gradient(#666 0% 25%, #444 0% 50%)',
      backgroundSize: '16px 16px',
    }),
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

          {/* Colors */}
          <Section title="Colors" defaultOpen>

            {/* Background */}
            <div className="mb-3 pb-3 border-b border-white/[0.06]">
              <div className="text-[10px] text-white/30 mb-2 uppercase tracking-wide">Background</div>
              <MiniColorPicker
                hex={present.background.hex}
                opacity={100}
                onChangeHex={hex => updateBackground({ ...present.background, hex })}
                showOpacity={false}
              />
              <div className="mt-2">
                <Toggle on={present.background.transparent}
                  onChange={v => updateBackground({ ...present.background, transparent: v })}
                  label="Transparent" />
              </div>
            </div>

            {/* Grid density */}
            <div className="mb-3">
              <div className="text-[10px] text-white/30 mb-1.5 uppercase tracking-wide">Grid</div>
              <div className="flex gap-1">
                {MESH_DENSITIES.map(([r, c]) => (
                  <button key={`${r}x${c}`} onClick={() => setMeshDensity(r, c)}
                    className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors border ${
                      present.mesh.rows === r && present.mesh.cols === c
                        ? 'bg-violet-500/20 border-violet-500/40 text-violet-300'
                        : 'bg-white/[0.04] border-white/[0.08] text-white/35 hover:text-white/65 hover:bg-white/[0.08]'
                    }`}>
                    {r}×{c}
                  </button>
                ))}
              </div>
            </div>

            {/* Mesh point grid */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-white/30 uppercase tracking-wide">Points</span>
                <span className="text-[10px] text-white/20">{present.mesh.cols+1}×{present.mesh.rows+1}</span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${present.mesh.cols + 1}, 1fr)`,
                gap: 3,
              }}>
                {present.mesh.points.map(pt => (
                  <div key={pt.id}
                    onClick={() => setSelectedPointId(id => id === pt.id ? null : pt.id)}
                    title={pt.id}
                    style={{
                      aspectRatio: '1',
                      borderRadius: 4,
                      background: pt.color,
                      cursor: 'pointer',
                      outline: pt.id === selectedPointId ? '2px solid white' : '1.5px solid rgba(255,255,255,0.08)',
                      outlineOffset: pt.id === selectedPointId ? 1 : 0,
                      opacity: pt.opacity / 100,
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Selected point editor */}
            {selectedPoint && (
              <div className="mb-3 p-2.5 rounded-md bg-white/[0.04] border border-white/[0.06]">
                <div className="text-[10px] text-white/30 mb-2 uppercase tracking-wide">
                  {selectedPointId}
                </div>
                <MiniColorPicker
                  hex={selectedPoint.color}
                  opacity={selectedPoint.opacity}
                  onChangeHex={color => updateMeshPoint(selectedPointId, { color })}
                  onChangeOpacity={opacity => updateMeshPoint(selectedPointId, { opacity })}
                  showOpacity
                />
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-1.5 mb-4">
              <button onClick={randomizeMeshColors}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <IconShuffle /> Randomize
              </button>
              <button onClick={resetMeshPositions}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border border-white/[0.08] text-white/35 text-xs hover:text-white/60 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <IconReset /> Reset pos
              </button>
            </div>

            {/* Palette save/load */}
            <div className="pt-3 border-t border-white/[0.06] space-y-2">
              <div className="flex gap-1.5">
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
                  {paletteNames.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              )}
            </div>
          </Section>

          {/* Warp / Smear */}
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

          {/* Filters */}
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

          {/* Export */}
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
        className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
        onPointerDown={onMainPointerDown}
        onPointerMove={onMainPointerMove}
        onPointerUp={onMainPointerUp}
        onPointerLeave={onMainPointerUp}
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

            {/* Mesh gradient handles */}
            {!smearActive && present.mesh.points.map(pt => {
              const pos = present.mesh.positions[pt.id]
              if (!pos) return null
              const selected = pt.id === selectedPointId
              return (
                <div key={pt.id} data-no-pan=""
                  onPointerDown={e => onMeshPointerDown(e, pt.id)}
                  onPointerMove={e => onMeshPointerMove(e, pt.id)}
                  onPointerUp={e => onMeshPointerUp(e, pt.id)}
                  style={{
                    position: 'absolute', left: pos.x, top: pos.y,
                    transform: 'translate(-50%, -50%)',
                    width: selected ? 18 : 12,
                    height: selected ? 18 : 12,
                    borderRadius: '50%',
                    background: pt.color,
                    border: selected ? '2.5px solid white' : '1.5px solid rgba(255,255,255,0.75)',
                    boxShadow: selected
                      ? '0 0 0 2.5px rgba(139,92,246,0.85), 0 2px 8px rgba(0,0,0,0.5)'
                      : '0 1px 4px rgba(0,0,0,0.45)',
                    cursor: 'move', touchAction: 'none', zIndex: 10,
                    transition: 'width 0.12s, height 0.12s, box-shadow 0.12s',
                  }}
                />
              )
            })}

            {/* Warp grid overlay */}
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
