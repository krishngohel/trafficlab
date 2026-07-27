import * as THREE from "three";

import { scatterEnvironment, type ScatterOptions } from "./scatter";
import type { TrajMeta } from "../traj";

/**
 * Static scenery between the roads: instanced low-poly trees and a few flat
 * building pads in the big empty blocks. Two draw calls total, both static —
 * matrices are written once at load and never touched again.
 *
 * Placement comes from `scatter.ts` (pure, seeded by the network name), so the
 * scenery is identical every time a file is opened and matches on both sides
 * of a comparison.
 */

/**
 * Vertex colours live in the renderer's linear working space, so authoring
 * them as sRGB hex (like every other colour in the scene) needs the same
 * conversion `THREE.Color` does for material colours.
 */
function linear(hex: number): readonly [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// Night palette: foliage sits just above the near-black ground (0x10141b) and
// below the asphalt (0x313848) so the roads stay the bright figures.
const TRUNK = linear(0x241d17);
const CANOPY_LOW = linear(0x1d3524);
const CANOPY_HIGH = linear(0x2a4a30);

/** Accumulates flat-shaded, vertex-coloured triangles. */
class PropBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];

  triangle(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    color: readonly number[],
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx, ny, nz);
      this.colors.push(color[0], color[1], color[2]);
    }
  }

  quad(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    color: readonly number[],
  ): void {
    this.triangle(a, b, c, color);
    this.triangle(a, c, d, color);
  }

  /** Vertical prism from y0 to y1 (trunk / building box). */
  prism(
    radius: number,
    y0: number,
    y1: number,
    segments: number,
    color: readonly number[],
    cap = false,
  ): void {
    const pt = (i: number, y: number) => {
      const a = (i / segments) * Math.PI * 2;
      return [Math.cos(a) * radius, y, Math.sin(a) * radius];
    };
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.quad(pt(i, y0), pt(i, y1), pt(j, y1), pt(j, y0), color);
      if (cap) this.triangle([0, y1, 0], pt(j, y1), pt(i, y1), color);
    }
  }

  /** Cone with its base at y0 and apex at y1. */
  cone(radius: number, y0: number, y1: number, segments: number, color: readonly number[]): void {
    const pt = (i: number) => {
      const a = (i / segments) * Math.PI * 2;
      return [Math.cos(a) * radius, y0, Math.sin(a) * radius];
    };
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.triangle(pt(j), pt(i), [0, y1, 0], color);
      this.triangle([0, y0, 0], pt(i), pt(j), color); // underside skirt
    }
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * One merged tree of unit height (scaled per instance): a 5-sided trunk and
 * three stacked cones. ~52 triangles.
 */
export function buildTreeGeometry(): THREE.BufferGeometry {
  const b = new PropBuilder();
  b.prism(0.035, 0, 0.3, 5, TRUNK);
  b.cone(0.3, 0.2, 0.56, 6, CANOPY_LOW);
  b.cone(0.24, 0.44, 0.78, 6, CANOPY_HIGH);
  b.cone(0.16, 0.66, 1.0, 6, CANOPY_HIGH);
  return b.build();
}

/**
 * A unit building pad: a 1x1x1 box with its base at y = 0 and a slightly
 * inset, lighter roof slab, scaled per instance.
 */
export function buildPadGeometry(): THREE.BufferGeometry {
  const b = new PropBuilder();
  const wall = linear(0x1c222d);
  const roof = linear(0x333c4d);
  const h = 0.5;
  const box = (hx: number, hz: number, y0: number, y1: number, color: readonly number[]) => {
    // Corner index = x + 2y + 4z, matching carModel's hexahedron convention.
    const c: number[][] = [];
    for (const z of [-hz, hz]) for (const y of [y0, y1]) for (const x of [-hx, hx]) c.push([x, y, z]);
    b.quad(c[1], c[3], c[7], c[5], color); // +X
    b.quad(c[0], c[4], c[6], c[2], color); // -X
    b.quad(c[2], c[6], c[7], c[3], color); // +Y
    b.quad(c[0], c[1], c[5], c[4], color); // -Y
    b.quad(c[4], c[5], c[7], c[6], color); // +Z
    b.quad(c[0], c[2], c[3], c[1], color); // -Z
  };
  box(h, h, 0, 1, wall);
  // Roof slab, inset and a shade lighter so the block reads as a building.
  box(h * 0.92, h * 0.92, 1, 1.035, roof);
  return b.build();
}

/**
 * Build the scenery group for one network. Returns a group holding at most two
 * InstancedMeshes; both are static and frustum-culled normally.
 */
export function buildEnvironment(meta: TrajMeta, options?: ScatterOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = "environment";
  const { trees, pads } = scatterEnvironment(meta, options);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  if (trees.length > 0) {
    const mesh = new THREE.InstancedMesh(
      buildTreeGeometry(),
      new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, vertexColors: true }),
      trees.length,
    );
    mesh.name = "trees";
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      // Sim (x, y) -> scene (x, -z); slight width jitter keeps rows from rhyming.
      dummy.position.set(t.x, 0, -t.y);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.set(t.height * 0.92, t.height, t.height * 0.92);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.setRGB(t.tintR, t.tintG, t.tintB));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }

  if (pads.length > 0) {
    const mesh = new THREE.InstancedMesh(
      buildPadGeometry(),
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05, vertexColors: true }),
      pads.length,
    );
    mesh.name = "pads";
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      dummy.position.set(p.x, 0, -p.y);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(p.width, p.height, p.depth);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.setRGB(p.tint, p.tint, p.tint * 1.06));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }

  return group;
}
