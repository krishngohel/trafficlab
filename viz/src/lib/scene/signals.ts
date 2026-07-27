import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { TrajFrame, TrajMeta } from "../traj";
import { networkBounds } from "./roads";

/**
 * One signal indicator at the end of each approach lane (a lane that is
 * `from_lane` of at least one connection): a short dark pole, a bright
 * emissive head sphere, and a billboarded additive glow so the state reads
 * from far away without postprocessing. State is derived per frame from the
 * signal records of the connections leaving that lane:
 *   green  — some connection is in the active phase and the signal is green
 *   yellow — some connection is in the outgoing phase and the signal is yellow
 *   red    — otherwise (including all-red)
 *
 * Draw calls: 1 merged pole mesh + 1 instanced head mesh + 1 glow Points.
 */

type HeadState = 0 | 1 | 2; // green | yellow | red

interface HeadConn {
  connId: number;
  /** Index of the controlling intersection in meta.intersections_order. */
  kIndex: number;
  /** Per-phase connection-id sets for that intersection. */
  intersectionPhases: Set<number>[];
}

interface Head {
  /** Instance index in the head mesh / glow attribute. */
  index: number;
  /** Connections leaving this lane. */
  conns: HeadConn[];
  last: HeadState | -1;
}

const HEAD_RADIUS = 1.2;
const HEAD_HEIGHT = 4.6;
const POLE_SIDE = 0.26;
/** Head color multiplier (>1 so ACES rolls it off like a bright emitter). */
const HEAD_INTENSITY = 1.7;
/** Glow color multiplier (additive blend, so >1 reads as bloom). */
const GLOW_INTENSITY = 1.15;
/**
 * PointsMaterial size for a glow of apparent world height S: with
 * sizeAttenuation the point covers size*(h/2)/dist pixels while a
 * world-space object of height S covers S*(h/2)/(dist*tan(fov/2)); at
 * fov 50 that means size ≈ S / tan(25°) ≈ S / 0.466.
 */
function glowPointSize(extent: number): number {
  // ≥4 m halo, growing with the network so it stays visible at the default fit.
  const worldSize = THREE.MathUtils.clamp(extent * 0.0085, 4, 12);
  return worldSize / 0.466;
}

const STATE_COLORS: Record<HeadState, THREE.Color> = {
  0: new THREE.Color(0x22e07c), // green
  1: new THREE.Color(0xffcc33), // yellow
  2: new THREE.Color(0xff4444), // red
};

function makeGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.4)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class SignalLayer {
  readonly group: THREE.Group;

  private readonly heads: Head[] = [];
  private readonly headMesh: THREE.InstancedMesh;
  private readonly poleMesh: THREE.Mesh;
  private readonly glow: THREE.Points;
  private readonly glowColors: Float32Array;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly color = new THREE.Color();

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "signals";

    const { network, intersections_order } = meta;
    const kIndexByIntersection = new Map<number, number>();
    intersections_order.forEach((id, k) => kIndexByIntersection.set(id, k));

    const intersectionById = new Map(network.intersections.map((i) => [i.id, i]));
    const laneById = new Map(network.lanes.map((l) => [l.id, l]));

    // Group connections by their from_lane.
    const connsByLane = new Map<number, typeof network.connections>();
    for (const conn of network.connections) {
      const list = connsByLane.get(conn.from_lane);
      if (list) list.push(conn);
      else connsByLane.set(conn.from_lane, [conn]);
    }

    const positions: [number, number][] = []; // sim coords per head
    for (const [laneId, conns] of connsByLane) {
      const lane = laneById.get(laneId);
      if (!lane || lane.polyline.length === 0) continue;
      const end = lane.polyline[lane.polyline.length - 1];

      const headConns: HeadConn[] = [];
      for (const conn of conns) {
        const kIndex = kIndexByIntersection.get(conn.intersection);
        const intersection = intersectionById.get(conn.intersection);
        if (kIndex === undefined || intersection === undefined) continue;
        headConns.push({
          connId: conn.id,
          kIndex,
          intersectionPhases: intersection.phases.map((p) => new Set(p.connections)),
        });
      }
      if (headConns.length === 0) continue;

      this.heads.push({ index: positions.length, conns: headConns, last: -1 });
      positions.push([end[0], end[1]]);
    }
    const n = positions.length;

    // Poles: one merged static mesh.
    const poleGeos: THREE.BufferGeometry[] = [];
    const poleProto = new THREE.BoxGeometry(POLE_SIDE, HEAD_HEIGHT, POLE_SIDE);
    poleProto.translate(0, HEAD_HEIGHT / 2, 0);
    for (const [x, y] of positions) {
      const g = poleProto.clone();
      g.translate(x, 0, -y);
      poleGeos.push(g);
    }
    const poleGeo = poleGeos.length > 0 ? mergeGeometries(poleGeos) : new THREE.BufferGeometry();
    poleProto.dispose();
    this.poleMesh = new THREE.Mesh(
      poleGeo,
      new THREE.MeshStandardMaterial({ color: 0x1c212b, roughness: 0.85, metalness: 0.2 }),
    );
    this.group.add(this.poleMesh);

    // Heads: one InstancedMesh with per-instance (super-bright) color.
    this.headMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(HEAD_RADIUS, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      Math.max(n, 1),
    );
    this.headMesh.frustumCulled = false;
    const dummy = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const [x, y] = positions[i];
      dummy.makeTranslation(x, HEAD_HEIGHT, -y);
      this.headMesh.setMatrixAt(i, dummy);
      this.headMesh.setColorAt(i, this.color.copy(STATE_COLORS[2]).multiplyScalar(HEAD_INTENSITY));
    }
    this.headMesh.count = n;
    this.headMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.headMesh);

    // Glow halos: one additive Points draw, billboarded for free.
    const glowPositions = new Float32Array(n * 3);
    this.glowColors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      glowPositions[i * 3] = positions[i][0];
      glowPositions[i * 3 + 1] = HEAD_HEIGHT;
      glowPositions[i * 3 + 2] = -positions[i][1];
      this.glowColors[i * 3] = STATE_COLORS[2].r * GLOW_INTENSITY;
      this.glowColors[i * 3 + 1] = STATE_COLORS[2].g * GLOW_INTENSITY;
      this.glowColors[i * 3 + 2] = STATE_COLORS[2].b * GLOW_INTENSITY;
    }
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
    const colorAttr = new THREE.BufferAttribute(this.glowColors, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    glowGeo.setAttribute("color", colorAttr);
    this.glowTexture = makeGlowTexture();
    this.glow = new THREE.Points(
      glowGeo,
      new THREE.PointsMaterial({
        size: glowPointSize(networkBounds(meta).extent),
        sizeAttenuation: true,
        map: this.glowTexture,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.glow.frustumCulled = false;
    this.glow.visible = n > 0;
    this.group.add(this.glow);
  }

  /** Recolor every head from the frame's per-intersection signal records. */
  update(frame: TrajFrame): void {
    let dirty = false;
    for (const head of this.heads) {
      let state: HeadState = 2;
      for (const c of head.conns) {
        const sig = frame.signals[c.kIndex];
        if (!sig) continue;
        const phaseConns = c.intersectionPhases[sig.phase];
        const inPhase = phaseConns !== undefined && phaseConns.has(c.connId);
        if (inPhase && sig.state === 0) {
          state = 0;
          break; // green wins
        }
        if (inPhase && sig.state === 1 && state === 2) {
          state = 1;
        }
      }
      if (state !== head.last) {
        head.last = state;
        const tint = STATE_COLORS[state];
        this.headMesh.setColorAt(head.index, this.color.copy(tint).multiplyScalar(HEAD_INTENSITY));
        this.glowColors[head.index * 3] = tint.r * GLOW_INTENSITY;
        this.glowColors[head.index * 3 + 1] = tint.g * GLOW_INTENSITY;
        this.glowColors[head.index * 3 + 2] = tint.b * GLOW_INTENSITY;
        dirty = true;
      }
    }
    if (dirty) {
      if (this.headMesh.instanceColor) this.headMesh.instanceColor.needsUpdate = true;
      (this.glow.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.poleMesh.geometry.dispose();
    (this.poleMesh.material as THREE.Material).dispose();
    this.headMesh.geometry.dispose();
    (this.headMesh.material as THREE.Material).dispose();
    this.headMesh.dispose();
    this.glow.geometry.dispose();
    (this.glow.material as THREE.Material).dispose();
    this.glowTexture.dispose();
  }
}
