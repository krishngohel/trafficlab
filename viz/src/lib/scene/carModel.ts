import * as THREE from "three";

/**
 * A low-poly car silhouette as ONE merged, non-indexed BufferGeometry so every
 * vehicle stays a single InstancedMesh (one draw call for all traffic).
 *
 * Local frame: +X forward (the heading axis), +Y up, +Z left, origin on the
 * ground between the wheels — the same convention `VehicleLayer` positions
 * instances in.
 *
 * Windows, wheels and the roof highlight ride on a per-vertex `color`
 * attribute that acts as a *multiplier*: three multiplies the vertex color and
 * the per-instance color together, so a tint of 0.1 reads as smoked glass on a
 * red car and on a blue car alike, with no second material and no second mesh.
 */

export const CAR_LENGTH = 4.4;
export const CAR_WIDTH = 1.86;
export const CAR_HEIGHT = 1.44;

/** Vertex-color multipliers applied on top of the per-instance body color. */
const BODY = 1.0;
const ROOF = 1.22; // subtle highlight along the roof panel
const GLASS = 0.1; // smoked windows
const TIRE = 0.07; // near-black rubber
const SKIRT = 0.35; // darkened rocker panel / wheel-arch shadow

type Vec3 = readonly [number, number, number];

/**
 * Accumulates flat-shaded triangles with a per-vertex tint. Non-indexed: at
 * ~160 triangles the duplicate vertices cost nothing and flat normals keep the
 * faceted low-poly read.
 */
class CarBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];

  triangle(a: Vec3, b: Vec3, c: Vec3, tint: number): void {
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
      this.colors.push(tint, tint, tint);
    }
  }

  /** Quad a-b-c-d (CCW seen from outside). */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, tint: number): void {
    this.triangle(a, b, c, tint);
    this.triangle(a, c, d, tint);
  }

  /**
   * A hexahedron from 8 corners indexed `x + 2y + 4z` (x: rear/front,
   * y: bottom/top, z: -Z/+Z), so each end can be tapered independently.
   * `faces` tints [+X, -X, +Y, -Y, +Z, -Z].
   */
  hex(c: readonly Vec3[], faces: readonly number[]): void {
    this.quad(c[1], c[3], c[7], c[5], faces[0]); // +X (front)
    this.quad(c[0], c[4], c[6], c[2], faces[1]); // -X (rear)
    this.quad(c[2], c[6], c[7], c[3], faces[2]); // +Y (top)
    this.quad(c[0], c[1], c[5], c[4], faces[3]); // -Y (bottom)
    this.quad(c[4], c[5], c[7], c[6], faces[4]); // +Z
    this.quad(c[0], c[2], c[3], c[1], faces[5]); // -Z
  }

  /** A prism (wheel) whose axis runs along Z, centred at (cx, cy, cz). */
  wheel(cx: number, cy: number, cz: number, radius: number, halfWidth: number, segments: number): void {
    const z0 = cz - halfWidth;
    const z1 = cz + halfWidth;
    const pt = (i: number, z: number): Vec3 => {
      const a = (i / segments) * Math.PI * 2;
      return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, z];
    };
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      // Tread band.
      this.quad(pt(i, z0), pt(j, z0), pt(j, z1), pt(i, z1), TIRE);
      // Caps as triangle fans (outer faces slightly lighter to catch the light).
      this.triangle([cx, cy, z1], pt(i, z1), pt(j, z1), TIRE * 1.6);
      this.triangle([cx, cy, z0], pt(j, z0), pt(i, z0), TIRE * 1.6);
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

/** Corner list for `hex`, from independent front/rear/bottom/top dimensions. */
function corners(
  rearX: number,
  frontX: number,
  bottomY: number,
  topY: number,
  rearBottomZ: number,
  rearTopZ: number,
  frontBottomZ: number,
  frontTopZ: number,
  rearTopX = rearX,
  frontTopX = frontX,
): Vec3[] {
  return [
    [rearX, bottomY, -rearBottomZ],
    [frontX, bottomY, -frontBottomZ],
    [rearTopX, topY, -rearTopZ],
    [frontTopX, topY, -frontTopZ],
    [rearX, bottomY, rearBottomZ],
    [frontX, bottomY, frontBottomZ],
    [rearTopX, topY, rearTopZ],
    [frontTopX, topY, frontTopZ],
  ];
}

/**
 * Build the shared car geometry: tapered lower body, darkened rocker skirt,
 * belt band, raked glasshouse with a highlighted roof panel, and four wheels.
 * ~164 triangles, well under the 300 budget.
 */
export function buildCarGeometry(): THREE.BufferGeometry {
  const b = new CarBuilder();

  // --- lower body -----------------------------------------------------------
  // Slight nose-down wedge (hood lower than the trunk) and narrower at both
  // ends than at the waist, so the silhouette reads as a car from above.
  b.hex(
    corners(
      -2.1, // rear x
      2.2, // front x
      0.34, // bottom y
      0.88, // top y (waistline)
      0.78, // rear bottom half-width
      0.9, // rear top
      0.7, // front bottom
      0.84, // front top
      -2.16, // rear overhangs slightly at the waist
      2.14, // hood tucks in at the waist
    ),
    [BODY, BODY, BODY, BODY * 0.6, BODY, BODY],
  );

  // Rocker skirt: a shallow dark band under the doors that reads as the shadow
  // line between wheel arches at any zoom.
  b.hex(corners(-1.85, 1.95, 0.2, 0.4, 0.72, 0.79, 0.66, 0.72), [
    SKIRT,
    SKIRT,
    SKIRT,
    SKIRT,
    SKIRT,
    SKIRT,
  ]);

  // --- cabin ----------------------------------------------------------------
  // Body-coloured belt band, so the glasshouse floats above a painted shoulder.
  b.hex(corners(-1.6, 0.95, 0.88, 1.0, 0.86, 0.84, 0.8, 0.78), [
    BODY,
    BODY,
    BODY,
    BODY,
    BODY,
    BODY,
  ]);

  // Glasshouse: raked windshield (top face pulled 0.55 m back at the front),
  // slight rear slope, tumblehome, roof panel highlighted.
  b.hex(
    corners(
      -1.5, // rear x at the belt
      0.9, // front x at the belt
      1.0, // belt y
      1.44, // roof y
      0.84, // rear bottom half-width
      0.66, // rear top
      0.78, // front bottom
      0.62, // front top
      -1.24, // rear window slope
      0.32, // windshield rake
    ),
    [GLASS, GLASS, ROOF, GLASS, GLASS, GLASS],
  );

  // --- wheels ---------------------------------------------------------------
  const R = 0.34;
  const HW = 0.11;
  for (const x of [-1.35, 1.42]) {
    for (const z of [-0.79, 0.79]) {
      b.wheel(x, R, z, R, HW, 8);
    }
  }

  return b.build();
}

/** Triangle count of the shared car geometry (exposed for the budget test). */
export function carTriangleCount(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute("position");
  return pos.count / 3;
}
