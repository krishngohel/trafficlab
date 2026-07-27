import * as THREE from "three";

/**
 * A billboard sprite backed by a canvas texture, for in-scene text labels
 * (queue counts, signal phase timers). The canvas is only redrawn when the
 * text or color actually changes; callers throttle how often they try.
 */

export interface TextSpriteOptions {
  /** Canvas pixel size; keep small — these are tiny labels. */
  width?: number;
  height?: number;
  font?: string;
  /** World-space sprite width in meters (height follows the aspect). */
  worldWidth?: number;
  background?: string;
}

export class TextSprite {
  readonly sprite: THREE.Sprite;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private readonly font: string;
  private readonly background: string;
  private lastText = "";
  private lastColor = "";

  constructor(options: TextSpriteOptions = {}) {
    const width = options.width ?? 256;
    const height = options.height ?? 80;
    this.font = options.font ?? "600 42px ui-sans-serif, system-ui, sans-serif";
    this.background = options.background ?? "rgba(10, 13, 18, 0.72)";

    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("TextSprite: 2d canvas context unavailable");
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    const worldWidth = options.worldWidth ?? 10;
    this.sprite.scale.set(worldWidth, (worldWidth * height) / width, 1);
    this.sprite.visible = false;
  }

  /** Redraws only when (text, color) changed. Empty text hides the sprite. */
  setText(text: string, color = "#e8ecf2"): void {
    if (text === this.lastText && color === this.lastColor) return;
    this.lastText = text;
    this.lastColor = color;
    if (text === "") {
      this.sprite.visible = false;
      return;
    }
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.background;
    const r = h * 0.28;
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, r);
    ctx.fill();
    ctx.font = this.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h / 2 + 2, w - 16);
    this.texture.needsUpdate = true;
    this.sprite.visible = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }
}
