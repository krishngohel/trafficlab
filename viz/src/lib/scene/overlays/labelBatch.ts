import * as THREE from "three";

/**
 * Many in-scene text labels in ONE draw call.
 *
 * A `THREE.Sprite` per label is the obvious implementation and it is what this
 * replaces: a grid4x4 queue heatmap wants 128 of them, which on its own blew
 * the whole scene's draw-call budget. Instead every label is a cell in one
 * canvas atlas, drawn as one InstancedBufferGeometry of camera-facing quads.
 *
 * Only the cells whose text actually changed are repainted, and the atlas is
 * uploaded to the GPU at most every `UPLOAD_INTERVAL_MS` — a full re-upload is
 * megabytes, so doing it per frame would cost more than the sprites did.
 */

const UPLOAD_INTERVAL_MS = 180;

export interface LabelBatchOptions {
  /** Number of label slots. */
  count: number;
  /** Atlas cell size in pixels. */
  cellWidth?: number;
  cellHeight?: number;
  /** World-space label width in metres (height follows the cell aspect). */
  worldWidth: number;
  font?: string;
  background?: string;
}

export class LabelBatch {
  readonly mesh: THREE.Mesh;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly positions: THREE.InstancedBufferAttribute;
  private readonly sizes: THREE.InstancedBufferAttribute;
  private readonly cells: THREE.InstancedBufferAttribute;
  private readonly texts: string[];
  private readonly colors: string[];
  private readonly cellW: number;
  private readonly cellH: number;
  private readonly cols: number;
  private readonly worldWidth: number;
  private readonly worldHeight: number;
  private readonly font: string;
  private readonly background: string;
  private atlasDirty = false;
  private layoutDirty = false;
  private lastUpload = -Infinity;

  constructor(options: LabelBatchOptions) {
    const count = Math.max(options.count, 1);
    this.cellW = options.cellWidth ?? 128;
    this.cellH = options.cellHeight ?? 48;
    this.font = options.font ?? "600 30px ui-sans-serif, system-ui, sans-serif";
    this.background = options.background ?? "rgba(10, 13, 18, 0.72)";
    this.worldWidth = options.worldWidth;
    this.worldHeight = (options.worldWidth * this.cellH) / this.cellW;

    // Squarish atlas, power-of-two-ish columns, under any sane canvas limit.
    this.cols = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * (this.cellH / this.cellW)))));
    const rows = Math.ceil(count / this.cols);

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.cols * this.cellW;
    this.canvas.height = rows * this.cellH;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("LabelBatch: 2d canvas context unavailable");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    // Cell offsets are computed in canvas space (v grows downward), so the
    // default upload flip would mirror every label and shuffle the rows.
    this.texture.flipY = false;

    this.texts = new Array(count).fill("");
    this.colors = new Array(count).fill("");

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    // Atlas V grows downward in canvas space, so flip it here.
    this.geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.positions = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.sizes = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
    this.cells = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
    for (let i = 0; i < count; i++) {
      this.cells.setXY(i, (i % this.cols) / this.cols, Math.floor(i / this.cols) / rows);
    }
    this.geometry.setAttribute("iPos", this.positions);
    this.geometry.setAttribute("iSize", this.sizes);
    this.geometry.setAttribute("iCell", this.cells);
    this.geometry.instanceCount = count;
    // The quads are billboarded in the shader, so a normal bounding sphere is
    // meaningless; skip culling instead of inventing one.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.texture },
        uCell: { value: new THREE.Vector2(1 / this.cols, 1 / rows) },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec2 iSize;
        attribute vec2 iCell;
        uniform vec2 uCell;
        varying vec2 vUv;
        void main() {
          vUv = uv * uCell + iCell;
          vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );
          mv.xy += position.xy * iSize;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        varying vec2 vUv;
        void main() {
          vec4 texel = texture2D( uAtlas, vUv );
          if ( texel.a < 0.02 ) discard;
          // The atlas is an sRGB-encoded canvas; decode so the renderer's own
          // output encoding does not apply it twice.
          gl_FragColor = vec4( pow( texel.rgb, vec3( 2.2 ) ), texel.a );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "labels";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Anchor point of label `i` in scene space. */
  setPosition(i: number, x: number, y: number, z: number): void {
    this.positions.setXYZ(i, x, y, z);
    this.layoutDirty = true;
  }

  /** Set (or clear, with "") the text of label `i`. Repaints only on change. */
  setText(i: number, text: string, color = "#e8ecf2"): void {
    if (this.texts[i] === text && this.colors[i] === color) return;
    this.texts[i] = text;
    this.colors[i] = color;
    const col = i % this.cols;
    const row = Math.floor(i / this.cols);
    const x = col * this.cellW;
    const y = row * this.cellH;
    const { ctx } = this;
    ctx.clearRect(x, y, this.cellW, this.cellH);
    if (text !== "") {
      ctx.fillStyle = this.background;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, this.cellW - 2, this.cellH - 2, this.cellH * 0.28);
      ctx.fill();
      ctx.font = this.font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(text, x + this.cellW / 2, y + this.cellH / 2 + 1, this.cellW - 10);
    }
    this.sizes.setXY(
      i,
      text === "" ? 0 : this.worldWidth,
      text === "" ? 0 : this.worldHeight,
    );
    this.atlasDirty = true;
    this.layoutDirty = true;
  }

  /** Push pending changes to the GPU. Atlas uploads are rate limited. */
  flush(nowMs: number): void {
    if (this.layoutDirty) {
      this.positions.needsUpdate = true;
      this.sizes.needsUpdate = true;
      this.layoutDirty = false;
    }
    if (this.atlasDirty && nowMs - this.lastUpload >= UPLOAD_INTERVAL_MS) {
      this.texture.needsUpdate = true;
      this.atlasDirty = false;
      this.lastUpload = nowMs;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
