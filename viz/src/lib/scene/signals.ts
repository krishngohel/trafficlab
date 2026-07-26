import * as THREE from "three";
import type { TrajFrame, TrajMeta } from "../traj";

/**
 * One small emissive sphere at the end of each approach lane (a lane that is
 * `from_lane` of at least one connection). Color is derived per frame from
 * the signal state of the connections leaving that lane:
 *   green  — some connection is in the active phase and the signal is green
 *   yellow — some connection is in the outgoing phase and the signal is yellow
 *   red    — otherwise (including all-red)
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
  mesh: THREE.Mesh;
  /** Connections leaving this lane. */
  conns: HeadConn[];
  last: HeadState | -1;
}

const HEAD_RADIUS = 0.65;
const HEAD_HEIGHT = 1.4;

const STATE_COLORS: Record<HeadState, number> = {
  0: 0x36d97b, // green
  1: 0xf5c542, // yellow
  2: 0xef5350, // red
};

export class SignalLayer {
  readonly group: THREE.Group;

  private readonly heads: Head[] = [];
  private readonly geometry: THREE.SphereGeometry;
  private readonly materials: Record<HeadState, THREE.MeshStandardMaterial>;

  constructor(meta: TrajMeta) {
    this.group = new THREE.Group();
    this.group.name = "signals";
    this.geometry = new THREE.SphereGeometry(HEAD_RADIUS, 16, 12);
    this.materials = {
      0: SignalLayer.makeMaterial(STATE_COLORS[0]),
      1: SignalLayer.makeMaterial(STATE_COLORS[1]),
      2: SignalLayer.makeMaterial(STATE_COLORS[2]),
    };

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

      const mesh = new THREE.Mesh(this.geometry, this.materials[2]);
      mesh.position.set(end[0], HEAD_HEIGHT, -end[1]);
      this.group.add(mesh);
      this.heads.push({ mesh, conns: headConns, last: -1 });
    }
  }

  private static makeMaterial(color: number): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      emissive: color,
      emissiveIntensity: 1.6,
      roughness: 0.4,
      metalness: 0,
    });
  }

  /** Recolor every head from the frame's per-intersection signal records. */
  update(frame: TrajFrame): void {
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
        head.mesh.material = this.materials[state];
        head.last = state;
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
