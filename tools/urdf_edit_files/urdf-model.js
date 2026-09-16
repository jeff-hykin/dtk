// urdf-model.js — parse a URDF into a frame graph and keep the XML DOM editable.
//
// The XML DOM is the source of truth for editing: dragging a frame mutates the
// matching <joint><origin> attributes, so downloading just re-serializes the DOM
// and preserves every untouched tag, comment, and attribute.

/**
 * @typedef {Object} Joint
 * @property {string} name
 * @property {string} type
 * @property {string} parent   parent link name
 * @property {string} child    child link name
 * @property {number[]} xyz     origin translation (parent frame)
 * @property {number[]} rpy     origin rotation (roll, pitch, yaw)
 * @property {Element} originEl the <origin> element (created if missing)
 */

/**
 * @typedef {Object} UrdfModel
 * @property {Document} dom
 * @property {string[]} links               all link names
 * @property {Joint[]} joints
 * @property {Map<string, Joint>} jointByChild   incoming joint for a link (null for root)
 * @property {Map<string, string[]>} childrenOf  child link names for a link
 * @property {string} root                  the root link name
 * @property {Map<string, Visual[]>} visualsByLink   primitive visuals per link
 */

/**
 * @typedef {Object} Visual
 * @property {Object} shape   {type:"box",size} | {type:"cylinder",radius,length} | {type:"sphere",radius}
 * @property {{xyz:number[], rpy:number[]}} origin
 * @property {number[]} color  rgba
 */

const DEFAULT_COLOR = [0.6, 0.6, 0.65, 1]

function parseVisuals(dom) {
    const namedMaterials = new Map()
    for (const materialEl of dom.querySelectorAll("robot > material")) {
        const colorEl = materialEl.querySelector("color")
        const name = materialEl.getAttribute("name")
        if (name && colorEl) {
            namedMaterials.set(name, parseTriple4(colorEl.getAttribute("rgba")))
        }
    }

    const visualsByLink = new Map()
    for (const linkEl of dom.querySelectorAll("robot > link")) {
        const visuals = []
        for (const visualEl of linkEl.querySelectorAll("visual")) {
            const geometryEl = visualEl.querySelector("geometry")
            const shape = geometryEl && parseShape(geometryEl)
            if (!shape) {
                continue // mesh or unsupported geometry
            }
            const originEl = visualEl.querySelector("origin")
            const origin = {
                xyz: parseTriple(originEl?.getAttribute("xyz"), [0, 0, 0]),
                rpy: parseTriple(originEl?.getAttribute("rpy"), [0, 0, 0]),
            }
            const materialEl = visualEl.querySelector("material")
            const inlineColor = materialEl?.querySelector("color")
            const color = inlineColor
                ? parseTriple4(inlineColor.getAttribute("rgba"))
                : (namedMaterials.get(materialEl?.getAttribute("name")) ?? DEFAULT_COLOR)
            visuals.push({ shape, origin, color })
        }
        visualsByLink.set(linkEl.getAttribute("name"), visuals)
    }
    return visualsByLink
}

function parseShape(geometryEl) {
    const box = geometryEl.querySelector("box")
    if (box) {
        return { type: "box", size: parseTriple(box.getAttribute("size"), [0.1, 0.1, 0.1]) }
    }
    const cylinder = geometryEl.querySelector("cylinder")
    if (cylinder) {
        return { type: "cylinder", radius: Number(cylinder.getAttribute("radius")), length: Number(cylinder.getAttribute("length")) }
    }
    const sphere = geometryEl.querySelector("sphere")
    if (sphere) {
        return { type: "sphere", radius: Number(sphere.getAttribute("radius")) }
    }
    return null
}

function parseTriple4(text) {
    if (!text) {
        return DEFAULT_COLOR
    }
    const parts = text.trim().split(/\s+/).map(Number)
    return parts.length === 4 ? parts : DEFAULT_COLOR
}

function parseTriple(text, fallback) {
    if (!text) {
        return fallback
    }
    const parts = text.trim().split(/\s+/).map(Number)
    return parts.length === 3 ? parts : fallback
}

/**
 * @param {string} xmlText
 * @returns {UrdfModel}
 */
export function parseUrdf(xmlText) {
    const dom = new DOMParser().parseFromString(xmlText, "application/xml")
    const error = dom.querySelector("parsererror")
    if (error) {
        throw new Error("URDF parse error: " + error.textContent)
    }

    const links = [...dom.querySelectorAll("robot > link")].map((element) => element.getAttribute("name"))
    const joints = []
    const jointByChild = new Map()
    const childrenOf = new Map()
    for (const name of links) {
        childrenOf.set(name, [])
    }

    for (const jointEl of dom.querySelectorAll("robot > joint")) {
        const parent = jointEl.querySelector("parent")?.getAttribute("link")
        const child = jointEl.querySelector("child")?.getAttribute("link")
        if (!parent || !child) {
            continue
        }
        let originEl = jointEl.querySelector("origin")
        if (!originEl) {
            originEl = dom.createElement("origin")
            jointEl.appendChild(originEl)
        }
        const joint = {
            name: jointEl.getAttribute("name"),
            type: jointEl.getAttribute("type") ?? "fixed",
            parent,
            child,
            xyz: parseTriple(originEl.getAttribute("xyz"), [0, 0, 0]),
            rpy: parseTriple(originEl.getAttribute("rpy"), [0, 0, 0]),
            originEl,
        }
        joints.push(joint)
        jointByChild.set(child, joint)
        childrenOf.get(parent)?.push(child)
    }

    const childSet = new Set(joints.map((joint) => joint.child))
    const root = links.find((name) => !childSet.has(name)) ?? links[0]

    return { dom, links, joints, jointByChild, childrenOf, root, visualsByLink: parseVisuals(dom) }
}

/**
 * Write a frame's translation back into the XML origin and the in-memory joint.
 * @param {Joint} joint
 * @param {number[]} xyz
 */
export function setJointXyz(joint, xyz) {
    joint.xyz = xyz
    const rounded = xyz.map((value) => Number(value.toFixed(6)))
    joint.originEl.setAttribute("xyz", rounded.join(" "))
}

/**
 * Write a frame's rotation back into the XML origin and the in-memory joint.
 * @param {Joint} joint
 * @param {number[]} rpy   radians (roll, pitch, yaw)
 */
export function setJointRpy(joint, rpy) {
    joint.rpy = rpy
    const rounded = rpy.map((value) => Number(value.toFixed(6)))
    joint.originEl.setAttribute("rpy", rounded.join(" "))
}

/** @param {UrdfModel} model */
export function serializeUrdf(model) {
    return new XMLSerializer().serializeToString(model.dom)
}

/**
 * Add a new fixed child frame under `parentName`. Mutates the DOM + the model
 * maps in place (so a stable model reference stays valid). Returns the new name.
 */
export function addChildFrame(model, parentName) {
    let n = 1
    let linkName = `frame_${n}`
    while (model.links.includes(linkName)) {
        linkName = `frame_${++n}`
    }
    const robot = model.dom.querySelector("robot")
    const linkEl = model.dom.createElement("link")
    linkEl.setAttribute("name", linkName)
    robot.appendChild(linkEl)

    const jointEl = model.dom.createElement("joint")
    jointEl.setAttribute("name", `${linkName}_joint`)
    jointEl.setAttribute("type", "fixed")
    const parentEl = model.dom.createElement("parent")
    parentEl.setAttribute("link", parentName)
    const childEl = model.dom.createElement("child")
    childEl.setAttribute("link", linkName)
    const originEl = model.dom.createElement("origin")
    originEl.setAttribute("xyz", "0 0 0")
    originEl.setAttribute("rpy", "0 0 0")
    jointEl.append(parentEl, childEl, originEl)
    robot.appendChild(jointEl)

    const joint = { name: `${linkName}_joint`, type: "fixed", parent: parentName, child: linkName, xyz: [0, 0, 0], rpy: [0, 0, 0], originEl }
    model.links.push(linkName)
    model.joints.push(joint)
    model.jointByChild.set(linkName, joint)
    model.childrenOf.set(linkName, [])
    model.childrenOf.get(parentName)?.push(linkName)
    model.visualsByLink.set(linkName, [])
    return linkName
}

/**
 * Remove a frame. Its children are re-parented to the removed frame's parent so
 * the tree stays connected. Refuses to remove the root. Returns true if removed.
 */
export function removeFrame(model, name) {
    if (name === model.root || !model.links.includes(name)) {
        return false
    }
    const incoming = model.jointByChild.get(name)
    const parent = incoming ? incoming.parent : null

    for (const child of [...(model.childrenOf.get(name) ?? [])]) {
        const cj = model.jointByChild.get(child)
        if (!cj || !parent) {
            continue
        }
        cj.parent = parent
        cj.originEl.parentElement.querySelector("parent")?.setAttribute("link", parent)
        model.childrenOf.get(parent)?.push(child)
    }
    if (parent) {
        const siblings = model.childrenOf.get(parent)
        const i = siblings.indexOf(name)
        if (i >= 0) siblings.splice(i, 1)
    }

    for (const linkEl of model.dom.querySelectorAll("robot > link")) {
        if (linkEl.getAttribute("name") === name) linkEl.remove()
    }
    incoming?.originEl.parentElement.remove()

    model.links = model.links.filter((nm) => nm !== name)
    model.joints = model.joints.filter((j) => j.child !== name)
    model.jointByChild.delete(name)
    model.childrenOf.delete(name)
    model.visualsByLink.delete(name)
    return true
}
