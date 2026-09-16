// main.js — wire the URDF viewer/editor together as a self-contained app.
//
// One persistent viewer/controls/editor. `model` and `frames` are STABLE objects
// (mutated in place / Object.assign-repopulated) so the editor's captured
// references stay valid while we rebuild the frame graph after add/remove/load.

import { parseUrdf, setJointXyz, setJointRpy, addChildFrame, removeFrame, serializeUrdf } from "./urdf-model.js"
import { DimAppFrontend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/frontend.js"
import { createViewer } from "./viewer.js"
import { buildFrames } from "./frames.js"
import { installKeyboardControls } from "./controls.js"
import { installEditor } from "./editor.js"

const RAD_TO_DEG = 180 / Math.PI
const DEG_TO_RAD = Math.PI / 180

// Default sample: a Spot-like quadruped (body + 4 three-segment legs). Uses
// primitive box/cylinder/sphere visuals so it renders self-contained (no meshes),
// with revolute joints so every frame is poseable.
const SPOT_URDF = `<?xml version="1.0"?>
<robot name="spot">
  <material name="body_yellow"><color rgba="0.98 0.82 0.12 1"/></material>
  <material name="hip_dark"><color rgba="0.20 0.20 0.22 1"/></material>
  <material name="leg_gray"><color rgba="0.30 0.31 0.34 1"/></material>
  <material name="foot"><color rgba="0.10 0.10 0.11 1"/></material>

  <link name="body">
    <visual><origin xyz="0 0 0"/><geometry><box size="0.9 0.2 0.16"/></geometry><material name="body_yellow"/></visual>
  </link>

  <link name="front_left_hip">
    <visual><origin xyz="0 0 0"/><geometry><box size="0.10 0.08 0.10"/></geometry><material name="hip_dark"/></visual>
  </link>
  <joint name="front_left_hip_roll" type="revolute">
    <parent link="body"/><child link="front_left_hip"/>
    <origin xyz="0.32 0.115 0"/><axis xyz="1 0 0"/>
    <limit lower="-0.6" upper="0.6" effort="30" velocity="10"/>
  </joint>
  <link name="front_left_upper">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.05 0.05 0.3"/></geometry><material name="leg_gray"/></visual>
  </link>
  <joint name="front_left_upper_pitch" type="revolute">
    <parent link="front_left_hip"/><child link="front_left_upper"/>
    <origin xyz="0 0.06 0"/><axis xyz="0 1 0"/>
    <limit lower="-2.0" upper="2.0" effort="30" velocity="10"/>
  </joint>
  <link name="front_left_lower">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.035 0.035 0.3"/></geometry><material name="leg_gray"/></visual>
    <visual><origin xyz="0 0 -0.3"/><geometry><sphere radius="0.03"/></geometry><material name="foot"/></visual>
  </link>
  <joint name="front_left_lower_knee" type="revolute">
    <parent link="front_left_upper"/><child link="front_left_lower"/>
    <origin xyz="0 0 -0.3"/><axis xyz="0 1 0"/>
    <limit lower="0.0" upper="2.4" effort="30" velocity="10"/>
  </joint>

  <link name="front_right_hip">
    <visual><origin xyz="0 0 0"/><geometry><box size="0.10 0.08 0.10"/></geometry><material name="hip_dark"/></visual>
  </link>
  <joint name="front_right_hip_roll" type="revolute">
    <parent link="body"/><child link="front_right_hip"/>
    <origin xyz="0.32 -0.115 0"/><axis xyz="1 0 0"/>
    <limit lower="-0.6" upper="0.6" effort="30" velocity="10"/>
  </joint>
  <link name="front_right_upper">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.05 0.05 0.3"/></geometry><material name="leg_gray"/></visual>
  </link>
  <joint name="front_right_upper_pitch" type="revolute">
    <parent link="front_right_hip"/><child link="front_right_upper"/>
    <origin xyz="0 -0.06 0"/><axis xyz="0 1 0"/>
    <limit lower="-2.0" upper="2.0" effort="30" velocity="10"/>
  </joint>
  <link name="front_right_lower">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.035 0.035 0.3"/></geometry><material name="leg_gray"/></visual>
    <visual><origin xyz="0 0 -0.3"/><geometry><sphere radius="0.03"/></geometry><material name="foot"/></visual>
  </link>
  <joint name="front_right_lower_knee" type="revolute">
    <parent link="front_right_upper"/><child link="front_right_lower"/>
    <origin xyz="0 0 -0.3"/><axis xyz="0 1 0"/>
    <limit lower="0.0" upper="2.4" effort="30" velocity="10"/>
  </joint>

  <link name="rear_left_hip">
    <visual><origin xyz="0 0 0"/><geometry><box size="0.10 0.08 0.10"/></geometry><material name="hip_dark"/></visual>
  </link>
  <joint name="rear_left_hip_roll" type="revolute">
    <parent link="body"/><child link="rear_left_hip"/>
    <origin xyz="-0.32 0.115 0"/><axis xyz="1 0 0"/>
    <limit lower="-0.6" upper="0.6" effort="30" velocity="10"/>
  </joint>
  <link name="rear_left_upper">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.05 0.05 0.3"/></geometry><material name="leg_gray"/></visual>
  </link>
  <joint name="rear_left_upper_pitch" type="revolute">
    <parent link="rear_left_hip"/><child link="rear_left_upper"/>
    <origin xyz="0 0.06 0"/><axis xyz="0 1 0"/>
    <limit lower="-2.0" upper="2.0" effort="30" velocity="10"/>
  </joint>
  <link name="rear_left_lower">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.035 0.035 0.3"/></geometry><material name="leg_gray"/></visual>
    <visual><origin xyz="0 0 -0.3"/><geometry><sphere radius="0.03"/></geometry><material name="foot"/></visual>
  </link>
  <joint name="rear_left_lower_knee" type="revolute">
    <parent link="rear_left_upper"/><child link="rear_left_lower"/>
    <origin xyz="0 0 -0.3"/><axis xyz="0 1 0"/>
    <limit lower="0.0" upper="2.4" effort="30" velocity="10"/>
  </joint>

  <link name="rear_right_hip">
    <visual><origin xyz="0 0 0"/><geometry><box size="0.10 0.08 0.10"/></geometry><material name="hip_dark"/></visual>
  </link>
  <joint name="rear_right_hip_roll" type="revolute">
    <parent link="body"/><child link="rear_right_hip"/>
    <origin xyz="-0.32 -0.115 0"/><axis xyz="1 0 0"/>
    <limit lower="-0.6" upper="0.6" effort="30" velocity="10"/>
  </joint>
  <link name="rear_right_upper">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.05 0.05 0.3"/></geometry><material name="leg_gray"/></visual>
  </link>
  <joint name="rear_right_upper_pitch" type="revolute">
    <parent link="rear_right_hip"/><child link="rear_right_upper"/>
    <origin xyz="0 -0.06 0"/><axis xyz="0 1 0"/>
    <limit lower="-2.0" upper="2.0" effort="30" velocity="10"/>
  </joint>
  <link name="rear_right_lower">
    <visual><origin xyz="0 0 -0.15"/><geometry><box size="0.035 0.035 0.3"/></geometry><material name="leg_gray"/></visual>
    <visual><origin xyz="0 0 -0.3"/><geometry><sphere radius="0.03"/></geometry><material name="foot"/></visual>
  </link>
  <joint name="rear_right_lower_knee" type="revolute">
    <parent link="rear_right_upper"/><child link="rear_right_lower"/>
    <origin xyz="0 0 -0.3"/><axis xyz="0 1 0"/>
    <limit lower="0.0" upper="2.4" effort="30" velocity="10"/>
  </joint>
</robot>`

const app = document.getElementById("app")
const viewer = createViewer(app)
installKeyboardControls(viewer)

// ── stable model + frames ─────────────────────────────────────────────────────
const model = {}
const frames = {}

function setModel(text) {
  const parsed = parseUrdf(text)
  for (const k of Object.keys(model)) delete model[k]
  Object.assign(model, parsed)
}
function rebuildFrames() {
  if (frames.dispose) frames.dispose()
  const built = buildFrames(viewer, model)
  for (const k of Object.keys(frames)) delete frames[k]
  Object.assign(frames, built)
}

viewer.onFrame(() => frames.updateLabelScales && frames.updateLabelScales(viewer.camera))

// ── selected-frame panel ──────────────────────────────────────────────────────
const selectedEl = document.getElementById("selected")
const neighborsEl = document.getElementById("neighbors")
const treeEl = document.getElementById("tree-list")
const addBtn = document.getElementById("add-child")
const removeBtn = document.getElementById("remove-frame")
const treeNodes = new Map()
const inputs = {
  px: document.getElementById("px"), py: document.getElementById("py"), pz: document.getElementById("pz"),
  rx: document.getElementById("rx"), ry: document.getElementById("ry"), rz: document.getElementById("rz"),
}
const allInputs = Object.values(inputs)
let currentLink = null

function renderPanel(linkName) {
  currentLink = linkName
  selectedEl.textContent = linkName ?? "(none)"
  const neighbors = linkName ? frames.neighborsOf(linkName) : []
  neighborsEl.textContent = linkName ? (neighbors.length ? "→ " + neighbors.join(", ") : "(no connections)") : ""

  const neighborSet = new Set(neighbors)
  for (const [name, node] of treeNodes) {
    node.classList.toggle("sel", name === linkName)
    node.classList.toggle("nbr", name !== linkName && neighborSet.has(name))
  }

  addBtn.disabled = !linkName
  removeBtn.disabled = !linkName || linkName === model.root

  const joint = linkName ? model.jointByChild.get(linkName) : null
  if (!joint) {
    for (const input of allInputs) { input.value = ""; input.disabled = true }
    return
  }
  for (const input of allInputs) input.disabled = false
  inputs.px.value = joint.xyz[0].toFixed(4)
  inputs.py.value = joint.xyz[1].toFixed(4)
  inputs.pz.value = joint.xyz[2].toFixed(4)
  inputs.rx.value = (joint.rpy[0] * RAD_TO_DEG).toFixed(2)
  inputs.ry.value = (joint.rpy[1] * RAD_TO_DEG).toFixed(2)
  inputs.rz.value = (joint.rpy[2] * RAD_TO_DEG).toFixed(2)
}

function applyInputs() {
  const joint = currentLink ? model.jointByChild.get(currentLink) : null
  if (!joint) return
  const values = allInputs.map((i) => parseFloat(i.value))
  if (values.some(Number.isNaN)) return
  const [px, py, pz, rx, ry, rz] = values
  setJointXyz(joint, [px, py, pz])
  setJointRpy(joint, [rx * DEG_TO_RAD, ry * DEG_TO_RAD, rz * DEG_TO_RAD])
  frames.applyJointToFrame(currentLink)
}
for (const input of allInputs) input.addEventListener("input", applyInputs)

function selectFrame(linkName) {
  frames.setSelected(linkName)
  renderPanel(linkName)
}

// ── tree (with per-node remove) ───────────────────────────────────────────────
function rebuildTree() {
  treeEl.innerHTML = ""
  treeNodes.clear()
  const addNode = (linkName, depth) => {
    const node = document.createElement("div")
    node.className = "treenode"
    node.style.paddingLeft = `${depth * 14 + 6}px`
    const nm = document.createElement("span")
    nm.className = "nm"
    nm.textContent = linkName
    node.appendChild(nm)
    if (linkName !== model.root) {
      const rm = document.createElement("span")
      rm.className = "rm"
      rm.textContent = "✕"
      rm.title = "remove frame"
      rm.addEventListener("click", (e) => { e.stopPropagation(); doRemove(linkName) })
      node.appendChild(rm)
    }
    node.addEventListener("click", () => selectFrame(linkName))
    node.addEventListener("mouseenter", () => frames.setHovered(linkName))
    node.addEventListener("mouseleave", () => frames.setHovered(null))
    treeEl.appendChild(node)
    treeNodes.set(linkName, node)
    for (const child of model.childrenOf.get(linkName) ?? []) addNode(child, depth + 1)
  }
  addNode(model.root, 0)
  document.getElementById("frame-count").textContent = String(model.links.length)
}

// ── add / remove frame ────────────────────────────────────────────────────────
function doAdd() {
  if (!currentLink) return
  const name = addChildFrame(model, currentLink)
  rebuildFrames()
  rebuildTree()
  selectFrame(name)
}
function doRemove(name) {
  if (!removeFrame(model, name)) return
  rebuildFrames()
  rebuildTree()
  renderPanel(null)
  frames.setSelected(null)
}
addBtn.addEventListener("click", doAdd)
removeBtn.addEventListener("click", () => currentLink && doRemove(currentLink))

// ── load a URDF (sample on boot, file picker after) ───────────────────────────
function loadUrdf(text, label) {
  try {
    setModel(text)
  } catch (err) {
    alert("Could not parse URDF:\n" + err.message)
    return
  }
  rebuildFrames()
  rebuildTree()
  renderPanel(null)
  document.getElementById("urdf-name").textContent = label
  applyArrowScale()
}
async function openFile(file) {
  if (!file) return
  const text = await file.text()
  loadUrdf(text, file.name)
  // Opening a file should put it in Recent. The browser hides the real path, so we
  // cache a copy on disk via the same "save" the backend already handles. It's a
  // silent side effect of opening, so swallow the resulting "saved" status flash.
  suppressSavedFlash = true
  try { dimApp.send("save", { name: file.name.replace(/\.urdf$/i, ""), text }) } catch { suppressSavedFlash = false }
}
document.getElementById("urdf-file").addEventListener("change", (e) => openFile(e.target.files[0]))

// Drag-and-drop a URDF anywhere onto the window to open it (same as Load URDF).
// dragover must preventDefault so the drop is allowed and the browser doesn't just
// navigate to the file.
window.addEventListener("dragover", (e) => e.preventDefault())
window.addEventListener("drop", (e) => {
  e.preventDefault()
  const file = e.dataTransfer && e.dataTransfer.files[0]
  if (file) openFile(file)
})

// ── disk backend: save the edited URDF + reload recently-saved ones ────────────
const dimApp = new DimAppFrontend()
const saveBtn = document.getElementById("save")
const recentEl = document.getElementById("recent")
const saveStatusEl = document.getElementById("save-status")
let statusTimer = null

function robotName() {
  return model.dom?.querySelector("robot")?.getAttribute("name") || "robot"
}
function flashStatus(text) {
  saveStatusEl.textContent = text
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => { saveStatusEl.textContent = "" }, 4000)
}

saveBtn.addEventListener("click", () => {
  dimApp.send("save", { name: robotName(), text: serializeUrdf(model) })
  flashStatus("saving…")
})
recentEl.addEventListener("change", () => {
  const file = recentEl.value
  if (file) dimApp.send("load", { file })
})

let gotRecent = false
let suppressSavedFlash = false // set when a "save" is an open-triggered cache, not a user Save
dimApp.receiveRequest((kind, payload) => {
  if (kind === "recent") {
    gotRecent = true
    const selected = recentEl.value
    recentEl.innerHTML = '<option value="">Recent…</option>'
    for (const entry of payload?.files ?? []) {
      const option = document.createElement("option")
      option.value = entry.file
      option.textContent = entry.name
      recentEl.appendChild(option)
    }
    recentEl.value = [...recentEl.options].some((o) => o.value === selected) ? selected : ""
  } else if (kind === "saved") {
    if (suppressSavedFlash) {
      suppressSavedFlash = false
    } else {
      flashStatus(payload?.ok ? `saved ${payload.name}` : `save failed: ${payload?.error ?? "error"}`)
    }
  } else if (kind === "loaded") {
    if (payload?.ok) {
      loadUrdf(payload.text, payload.name)
    } else {
      flashStatus(`load failed: ${payload?.error ?? "error"}`)
      recentEl.value = ""
    }
  }
})
// Ask the backend for the recent-files list. The backend registers on the bus a
// moment after the desktop starts, so a single request sent before it's up gets
// dropped (the broker has no backend peer yet) and would never be retried —
// leaving "Recent" mysteriously empty. So retry until the first reply arrives,
// and also refresh whenever the user opens the dropdown.
function requestRecent() {
  try { dimApp.send("hello") } catch { /* socket closing */ }
}
requestRecent()
const recentRetry = setInterval(() => {
  if (gotRecent) { clearInterval(recentRetry); return }
  requestRecent()
}, 1000)
setTimeout(() => clearInterval(recentRetry), 15000)
recentEl.addEventListener("mousedown", requestRecent)

// ── arrow density ─────────────────────────────────────────────────────────────
let arrowScale = 0.5
const ARROW_STEP = 1.25
function applyArrowScale() {
  arrowScale = Math.min(5, Math.max(0.25, arrowScale))
  frames.setArrowScale(arrowScale)
}
document.getElementById("thicker").addEventListener("click", () => { arrowScale *= ARROW_STEP; applyArrowScale() })
document.getElementById("thinner").addEventListener("click", () => { arrowScale /= ARROW_STEP; applyArrowScale() })

// ── overlapping-node hint toast ───────────────────────────────────────────────
// When the pointer hovers a spot where two frame origins overlap >=80% on screen,
// clicking is ambiguous — nudge the user toward the tree panel to pick precisely.
const overlapTip = document.getElementById("overlap-tip")
let overlapDwellTimer = null
let overlapHideTimer = null
let overlapTipShown = false
function showOverlapTip() {
  overlapTip.classList.add("show")
  overlapTipShown = true
  clearTimeout(overlapHideTimer)
  overlapHideTimer = setTimeout(() => {
    overlapTip.classList.remove("show")
    overlapTipShown = false
  }, 6000)
}
viewer.renderer.domElement.addEventListener("pointermove", (event) => {
  const over = frames.overlapAtPointer && frames.overlapAtPointer(event.clientX, event.clientY)
  if (over) {
    // require a 500ms dwell before showing, so brushing past overlaps doesn't trigger it
    if (!overlapTipShown && overlapDwellTimer === null) {
      overlapDwellTimer = setTimeout(() => {
        overlapDwellTimer = null
        showOverlapTip()
      }, 500)
    }
  } else if (overlapDwellTimer !== null) {
    clearTimeout(overlapDwellTimer)
    overlapDwellTimer = null
  }
})

// ── boot: build the sample, then install the editor once ──────────────────────
setModel(SPOT_URDF)
document.getElementById("urdf-name").textContent = "spot"
rebuildFrames()
rebuildTree()
applyArrowScale()
installEditor(viewer, model, frames, { onSelect: renderPanel, onChange: renderPanel })
renderPanel(null)

globalThis.urdfView = { model, frames, viewer }
console.log(`urdf-view app: ${model.links.length} links, root = ${model.root}`)

// `dtk urdf_edit <robot.urdf>` serves the file it was given at /urdf.xml. Inside
// the dim desktop there is no such route, the fetch 404s, and the sample above
// stays -- which is the behaviour there already.
fetch("/urdf.xml").then(async (response) => {
  if (!response.ok) {
    return
  }
  const text = await response.text()
  const name = response.headers.get("x-urdf-name") || "urdf"
  suppressSavedFlash = true
  loadUrdf(text, name)
}).catch(() => {
  // no host serving one; the sample stands
})
