// frames.js — build an axis triad per link frame, nested so world transforms
// come for free, plus connection lines and neighbor highlighting.

import * as THREE from "three"
import { Line2 } from "https://esm.sh/three@0.160.0/examples/jsm/lines/Line2.js?external=three"
import { LineMaterial } from "https://esm.sh/three@0.160.0/examples/jsm/lines/LineMaterial.js?external=three"
import { LineGeometry } from "https://esm.sh/three@0.160.0/examples/jsm/lines/LineGeometry.js?external=three"

// A text label as an in-scene sprite, so 3D geometry (the arrows) occludes it.
function makeLabelSprite(text) {
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    const font = "32px ui-monospace, monospace"
    context.font = font
    const padding = 14
    const width = Math.ceil(context.measureText(text).width) + padding * 2
    const height = 48
    canvas.width = width
    canvas.height = height

    function draw(background, foreground) {
        context.clearRect(0, 0, width, height)
        context.fillStyle = background
        context.fillRect(0, 0, width, height)
        context.font = font
        context.textAlign = "center"
        context.textBaseline = "middle"
        context.fillStyle = foreground
        context.fillText(text, width / 2, height / 2)
    }

    const texture = new THREE.CanvasTexture(canvas)
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false, transparent: true })
    const sprite = new THREE.Sprite(material)
    const aspect = width / height

    function setState(state) {
        if (state === "selected") {
            draw("rgba(255,255,255,0.95)", "#14171c")
        } else if (state === "neighbor") {
            draw("rgba(255,212,93,0.95)", "#14171c")
        } else {
            draw("rgba(20,23,28,0.7)", "#cdd3da")
        }
        material.opacity = state === "dim" ? 0.2 : 1
        texture.needsUpdate = true
    }
    setState("default")
    return { sprite, setState, aspect }
}

const AXIS_LENGTH = 0.08
const SHAFT_RADIUS = 0.0035
const HEAD_LENGTH = 0.022
const LABEL_MARGIN = 0.014
const LABEL_SCREEN_K = 0.02 // label world-height per unit camera distance (constant on-screen size)
const SELECTED_ARROW_BOOST = 1.6 // selected frame's arrows grow so they stand out among overlapping nodes
const COLORS = { x: 0xff5d5d, y: 0x5dff8a, z: 0x5d9bff }
const AXIS_DIR = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
const scratchHSL = { h: 0, s: 0, l: 0 }

function quaternionFromRpy(rpy) {
    const [roll, pitch, yaw] = rpy
    const qx = new THREE.Quaternion().setFromAxisAngle(AXIS_DIR.x, roll)
    const qy = new THREE.Quaternion().setFromAxisAngle(AXIS_DIR.y, pitch)
    const qz = new THREE.Quaternion().setFromAxisAngle(AXIS_DIR.z, yaw)
    return qz.multiply(qy).multiply(qx) // URDF: R = Rz * Ry * Rx
}

function makeAxis(name, linkName) {
    const group = new THREE.Group()
    const color = COLORS[name]
    const shaftLength = AXIS_LENGTH - HEAD_LENGTH

    const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, shaftLength, 8),
        new THREE.MeshBasicMaterial({ color }),
    )
    shaft.position.y = shaftLength / 2
    const head = new THREE.Mesh(
        new THREE.ConeGeometry(SHAFT_RADIUS * 2.6, HEAD_LENGTH, 10),
        new THREE.MeshBasicMaterial({ color }),
    )
    head.position.y = shaftLength + HEAD_LENGTH / 2
    group.add(shaft, head)
    // remember the full-saturation color so styleFrame can desaturate non-focused frames
    shaft.material.userData.baseColor = new THREE.Color(color)
    head.material.userData.baseColor = new THREE.Color(color)

    // geometry points up +Y by default; rotate so it points along the named axis
    if (name === "x") {
        group.rotation.z = -Math.PI / 2
    } else if (name === "z") {
        group.rotation.x = Math.PI / 2
    }

    const meta = { linkName, kind: "axis", axis: name }
    group.userData = meta
    shaft.userData = meta
    head.userData = meta
    return group
}

const VISUAL_OPACITY = 0.25

function makeVisualMesh(visual) {
    let geometry
    if (visual.shape.type === "box") {
        geometry = new THREE.BoxGeometry(...visual.shape.size)
    } else if (visual.shape.type === "cylinder") {
        geometry = new THREE.CylinderGeometry(visual.shape.radius, visual.shape.radius, visual.shape.length, 24)
        geometry.rotateX(Math.PI / 2) // URDF cylinders run along local Z
    } else {
        geometry = new THREE.SphereGeometry(visual.shape.radius, 24, 16)
    }

    const [r, g, b] = visual.color
    const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, g, b),
        transparent: true,
        opacity: VISUAL_OPACITY,
        depthWrite: false,
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(...visual.origin.xyz)
    mesh.quaternion.copy(quaternionFromRpy(visual.origin.rpy))

    // outline so the translucent shape reads clearly
    if (visual.shape.type !== "sphere") {
        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: new THREE.Color(r, g, b), transparent: true, opacity: 0.5 }),
        )
        mesh.add(edges)
    }
    return mesh
}

export function buildFrames(viewer, model) {
    const scene = viewer.scene
    const framesByLink = new Map()
    const pickables = []
    const axisGroups = []

    function makeFrame(linkName) {
        const group = new THREE.Group()

        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.008, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x9aa7b4 }),
        )
        sphere.userData = { linkName, kind: "sphere" }
        group.add(sphere)
        pickables.push(sphere)

        const markerMaterials = [sphere.material]
        const axes = []
        for (const name of ["x", "y", "z"]) {
            const axis = makeAxis(name, linkName)
            group.add(axis)
            axisGroups.push(axis)
            axes.push(axis)
            pickables.push(...axis.children)
            markerMaterials.push(...axis.children.map((child) => child.material))
        }

        const label = makeLabelSprite(linkName)
        label.sprite.position.set(0, AXIS_LENGTH + LABEL_MARGIN, 0) // tip of the y axis
        group.add(label.sprite)

        for (const visual of model.visualsByLink.get(linkName) ?? []) {
            group.add(makeVisualMesh(visual))
        }

        framesByLink.set(linkName, { group, sphere, label, markerMaterials, axes, name: linkName })
        return group
    }

    // place root at the scene origin, then attach each child under its parent
    const rootGroup = makeFrame(model.root)
    scene.add(rootGroup)

    const queue = [model.root]
    while (queue.length) {
        const parent = queue.shift()
        for (const child of model.childrenOf.get(parent) ?? []) {
            const joint = model.jointByChild.get(child)
            const childGroup = makeFrame(child)
            childGroup.position.set(...joint.xyz)
            childGroup.quaternion.copy(quaternionFromRpy(joint.rpy))
            framesByLink.get(parent).group.add(childGroup)
            queue.push(child)
        }
    }

    // connection lines between parent and child frame origins (world space).
    // Fat lines (Line2) so width is controllable — a selected frame's lines thicken.
    const normalLineMaterial = new LineMaterial({ color: 0x3a4350, linewidth: 1.5 })
    const highlightLineMaterial = new LineMaterial({ color: 0xffd45d, linewidth: 3.5 })
    function syncLineResolution() {
        const size = new THREE.Vector2()
        viewer.renderer.getDrawingBufferSize(size)
        normalLineMaterial.resolution.set(size.x, size.y)
        highlightLineMaterial.resolution.set(size.x, size.y)
    }
    syncLineResolution()
    window.addEventListener("resize", syncLineResolution)

    const lines = new Map() // childLink -> Line2
    scene.updateMatrixWorld(true)
    for (const joint of model.joints) {
        if (!framesByLink.get(joint.parent) || !framesByLink.get(joint.child)) {
            continue
        }
        const geometry = new LineGeometry()
        geometry.setPositions([0, 0, 0, 0, 0, 0])
        const line = new Line2(geometry, normalLineMaterial)
        line.userData = { parent: joint.parent, child: joint.child }
        scene.add(line)
        lines.set(joint.child, line)
    }

    function refreshLines() {
        scene.updateMatrixWorld(true)
        const a = new THREE.Vector3()
        const b = new THREE.Vector3()
        for (const [child, line] of lines) {
            framesByLink.get(line.userData.parent).group.getWorldPosition(a)
            framesByLink.get(child).group.getWorldPosition(b)
            line.geometry.setPositions([a.x, a.y, a.z, b.x, b.y, b.z])
        }
    }
    refreshLines()

    function neighborsOf(linkName) {
        const result = []
        const incoming = model.jointByChild.get(linkName)
        if (incoming) {
            result.push(incoming.parent)
        }
        for (const child of model.childrenOf.get(linkName) ?? []) {
            result.push(child)
        }
        return result
    }

    let selected = null
    let hovered = null

    function styleFrame(name) {
        const frame = framesByLink.get(name)
        if (!frame) {
            return
        }
        const neighbors = selected ? new Set(neighborsOf(selected)) : new Set()
        const isSelected = name === selected
        const isNeighbor = neighbors.has(name)
        const isHovered = name === hovered
        // when something is selected, every other frame's markers go translucent and
        // drop to half saturation, so the focused frame reads as the vivid one
        const dim = selected && !isSelected && !isHovered
        const opacity = dim ? (isNeighbor ? 0.5 : 0.22) : 1
        const saturation = dim ? 0.5 : 1
        for (const material of frame.markerMaterials) {
            material.transparent = opacity < 1
            material.opacity = opacity
            const base = material.userData.baseColor
            if (base) {
                material.color.copy(base).getHSL(scratchHSL)
                material.color.setHSL(scratchHSL.h, scratchHSL.s * saturation, scratchHSL.l)
            }
        }
        frame.sphere.material.color.set(
            isHovered ? 0x5fe3ff : isSelected ? 0xffffff : isNeighbor ? 0xffd45d : 0x9aa7b4,
        )
        frame.sphere.scale.setScalar(isHovered ? 2.4 : isSelected ? 1.8 : 1)
        frame.label.setState(
            isHovered || isSelected ? "selected" : isNeighbor ? "neighbor" : dim ? "dim" : "default",
        )
        applyArrowScaleToFrame(name)
    }

    function setSelected(linkName) {
        selected = linkName
        for (const name of framesByLink.keys()) {
            styleFrame(name)
        }
        const neighbors = linkName ? new Set(neighborsOf(linkName)) : new Set()
        for (const [child, line] of lines) {
            const touches = child === linkName || line.userData.parent === linkName || neighbors.has(child)
            line.material = touches && linkName ? highlightLineMaterial : normalLineMaterial
        }
    }

    function setHovered(linkName) {
        const previous = hovered
        hovered = linkName
        styleFrame(previous)
        styleFrame(linkName)
    }

    let globalArrowScale = 1
    function arrowFactorFor(name) {
        return globalArrowScale * (name === selected ? SELECTED_ARROW_BOOST : 1)
    }
    function applyArrowScaleToFrame(name) {
        const frame = framesByLink.get(name)
        if (!frame) {
            return
        }
        const factor = arrowFactorFor(name)
        for (const axis of frame.axes) {
            axis.scale.setScalar(factor)
        }
        frame.label.sprite.position.set(0, AXIS_LENGTH * factor + LABEL_MARGIN, 0)
    }
    function setArrowScale(factor) {
        globalArrowScale = factor
        for (const name of framesByLink.keys()) {
            applyArrowScaleToFrame(name)
        }
    }

    // Keep labels a constant on-screen size by scaling them with camera distance.
    const labelWorldPos = new THREE.Vector3()
    function updateLabelScales(camera) {
        for (const frame of framesByLink.values()) {
            frame.label.sprite.getWorldPosition(labelWorldPos)
            const distance = camera.position.distanceTo(labelWorldPos)
            const height = LABEL_SCREEN_K * distance
            frame.label.sprite.scale.set(height * frame.label.aspect, height, 1)
        }
    }

    // Screen-space circle (pixels) of a frame's origin sphere, or null if behind the camera.
    const SPHERE_WORLD_RADIUS = 0.008 // matches makeFrame's sphere geometry
    const overlapWorldPos = new THREE.Vector3()
    function frameScreenCircle(frame, width, height) {
        frame.group.getWorldPosition(overlapWorldPos)
        const ndc = overlapWorldPos.clone().project(viewer.camera)
        if (ndc.z > 1) {
            return null
        }
        const distance = viewer.camera.position.distanceTo(overlapWorldPos)
        const fovY = (viewer.camera.fov * Math.PI) / 180
        return {
            cx: (ndc.x * 0.5 + 0.5) * width,
            cy: (-ndc.y * 0.5 + 0.5) * height,
            r: (SPHERE_WORLD_RADIUS * (height / 2)) / (Math.tan(fovY / 2) * distance),
        }
    }

    // Fraction of the smaller circle's area covered by the intersection of two circles.
    function circleOverlapFraction(a, b) {
        const d = Math.hypot(a.cx - b.cx, a.cy - b.cy)
        const ra = a.r
        const rb = b.r
        if (d >= ra + rb) {
            return 0
        }
        if (d <= Math.abs(ra - rb)) {
            return 1 // one fully inside the other
        }
        const p1 = ra * ra * Math.acos((d * d + ra * ra - rb * rb) / (2 * d * ra))
        const p2 = rb * rb * Math.acos((d * d + rb * rb - ra * ra) / (2 * d * rb))
        const p3 = 0.5 * Math.sqrt((-d + ra + rb) * (d + ra - rb) * (d - ra + rb) * (d + ra + rb))
        return (p1 + p2 - p3) / (Math.PI * Math.min(ra, rb) ** 2)
    }

    // True when the pointer sits over two frame spheres that overlap >= 80% on screen —
    // i.e. the "which node am I clicking?" situation.
    const POINTER_SLACK = 6
    const OVERLAP_THRESHOLD = 0.8
    function overlapAtPointer(clientX, clientY) {
        const rect = viewer.renderer.domElement.getBoundingClientRect()
        const px = clientX - rect.left
        const py = clientY - rect.top
        const under = []
        for (const frame of framesByLink.values()) {
            const circle = frameScreenCircle(frame, rect.width, rect.height)
            if (circle && Math.hypot(px - circle.cx, py - circle.cy) <= circle.r + POINTER_SLACK) {
                under.push(circle)
            }
        }
        for (let i = 0; i < under.length; i++) {
            for (let j = i + 1; j < under.length; j++) {
                if (circleOverlapFraction(under[i], under[j]) >= OVERLAP_THRESHOLD) {
                    return true
                }
            }
        }
        return false
    }

    // Re-apply a joint's current xyz/rpy (e.g. after editing via the panel inputs).
    function applyJointToFrame(linkName) {
        const joint = model.jointByChild.get(linkName)
        const frame = framesByLink.get(linkName)
        if (!joint || !frame) {
            return
        }
        frame.group.position.set(...joint.xyz)
        frame.group.quaternion.copy(quaternionFromRpy(joint.rpy))
        refreshLines()
    }

    // Tear down everything this build added to the scene, so the app can rebuild
    // frames in place after the model changes (add/remove a frame, load a file).
    function dispose() {
        scene.remove(rootGroup)
        for (const line of lines.values()) {
            scene.remove(line)
            line.geometry.dispose()
        }
        normalLineMaterial.dispose()
        highlightLineMaterial.dispose()
        window.removeEventListener("resize", syncLineResolution)
    }

    return {
        framesByLink, pickables, refreshLines, setSelected, setHovered, neighborsOf,
        setArrowScale, applyJointToFrame, updateLabelScales, overlapAtPointer, getSelected: () => selected, dispose,
    }
}
