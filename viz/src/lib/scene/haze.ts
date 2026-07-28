import * as THREE from "three";
import type { ThemeSpec } from "./theme";

/**
 * A band of atmospheric haze sitting on the horizon.
 *
 * Both HDRIs are photographs, and the few degrees just above their horizon are
 * the busiest part of the image — kloofendal goes to blown-out white glare, and
 * satara_night is a row of bright orange lamps that reads as a wall of blobs
 * rather than a sky. A cylinder of fog-coloured geometry, opaque at the horizon
 * and fading out a dozen degrees up, hides both and gives the ground plane's
 * far edge somewhere to disappear into. One draw call, no depth writes, drawn
 * before everything else.
 */

/** How far up the haze reaches, as a fraction of its radius (~14 degrees). */
const RISE = 0.25;
/** How far below the horizon it extends (the ground covers most of this). */
const DROP = 0.12;

export class HorizonHaze {
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.MeshBasicMaterial;
  private readonly alpha: Float32Array;
  private readonly colorAttr: THREE.BufferAttribute;

  constructor(radius: number) {
    const segments = 64;
    const rings = [
      { y: -DROP * radius, a: 1 },
      { y: 0, a: 1 },
      { y: RISE * radius * 0.35, a: 0.72 },
      { y: RISE * radius, a: 0 },
    ];
    const positions = new Float32Array(segments * rings.length * 3);
    const colors = new Float32Array(segments * rings.length * 4);
    const indices: number[] = [];
    for (let r = 0; r < rings.length; r++) {
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        const i = r * segments + s;
        positions[i * 3] = Math.cos(angle) * radius;
        positions[i * 3 + 1] = rings[r].y;
        positions[i * 3 + 2] = Math.sin(angle) * radius;
        // Only alpha varies; RGB is a multiplier on the material colour and
        // must stay at 1 or the band renders black.
        colors[i * 4] = 1;
        colors[i * 4 + 1] = 1;
        colors[i * 4 + 2] = 1;
        colors[i * 4 + 3] = rings[r].a;
      }
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let s = 0; s < segments; s++) {
        const next = (s + 1) % segments;
        const a = r * segments + s;
        const b = r * segments + next;
        const c = (r + 1) * segments + s;
        const d = (r + 1) * segments + next;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this.colorAttr = new THREE.BufferAttribute(colors, 4);
    geometry.setAttribute("color", this.colorAttr);
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    this.alpha = colors;

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "horizonHaze";
    this.mesh.frustumCulled = false;
    // Behind everything: it is background, not geometry.
    this.mesh.renderOrder = -1;
  }

  setTheme(spec: ThemeSpec): void {
    this.material.color.setHex(spec.fogColor);
    const scale = spec.hazeStrength;
    // Ring alphas were authored at full strength; rescale in place.
    const rings = [1, 1, 0.72, 0];
    const perRing = this.alpha.length / 4 / rings.length;
    for (let r = 0; r < rings.length; r++) {
      for (let s = 0; s < perRing; s++) {
        this.alpha[(r * perRing + s) * 4 + 3] = rings[r] * scale;
      }
    }
    this.colorAttr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
