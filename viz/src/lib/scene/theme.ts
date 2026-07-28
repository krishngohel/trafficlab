/**
 * The two lighting looks. Everything the scene needs to switch between a sunny
 * afternoon and a moonlit night lives here, so `SceneView` stays a wiring layer
 * and both sides of a comparison are guaranteed to match.
 *
 * Colours are authored as sRGB hex (three converts material/light colours for
 * us); intensities are physical-ish and tuned against ACES tone mapping.
 */

export type Theme = "day" | "night";

export interface ThemeSpec {
  /** Renderer exposure for this look. */
  exposure: number;
  /** Environment (IBL) intensity applied to every standard material. */
  envIntensity: number;
  /** Brightness of the HDRI drawn as the sky itself. */
  backgroundIntensity: number;
  /** Background/fog tint used before the HDRI arrives. */
  skyColor: number;
  /** Fog start / end as multiples of the network diagonal. */
  fogNear: number;
  fogFar: number;
  fogColor: number;
  /** Opacity of the horizon haze band that hides the HDRI's busy skyline. */
  hazeStrength: number;
  /** Key light (sun or moon). */
  keyColor: number;
  keyIntensity: number;
  /** Key direction, normalized-ish (x, y, z) in scene space. */
  keyDirection: readonly [number, number, number];
  /** Hemisphere fill on top of the IBL. */
  skyFill: number;
  groundFill: number;
  fillIntensity: number;
  /** Shadow darkness comes from the light; this scales the shadow map bias. */
  shadowBias: number;
  /** Painted road markings (unlit, so they need a per-theme value). */
  markingColor: number;
  centerLineColor: number;
  /** Multiplier on the ground/grass albedo, to keep it from screaming green. */
  groundTint: number;
  /** Multiplier on the asphalt albedo. */
  asphaltTint: number;
  /** Emissive floor on vehicles so none reads as a black speck. */
  vehicleEmissive: number;
  /** Signal lens brightness multiplier (ACES rolls the excess off). */
  lensIntensity: number;
  /** Signal glow sprite brightness. */
  glowIntensity: number;
  /** Street-lamp lens emissive strength (0 = lamps off). */
  lampIntensity: number;
}

export const THEMES: Record<Theme, ThemeSpec> = {
  day: {
    exposure: 0.9,
    envIntensity: 1.0,
    backgroundIntensity: 1.0,
    skyColor: 0x9fb8d4,
    fogNear: 1.4,
    fogFar: 3.4,
    fogColor: 0xb3c4d6,
    hazeStrength: 0.8,
    keyColor: 0xfff1da,
    keyIntensity: 2.6,
    keyDirection: [0.55, 0.72, 0.42],
    skyFill: 0xa9c2e0,
    groundFill: 0x6d6656,
    fillIntensity: 0.35,
    shadowBias: -0.0006,
    markingColor: 0xe7eaee,
    centerLineColor: 0xe8c35d,
    groundTint: 0.86,
    asphaltTint: 1.0,
    vehicleEmissive: 0x000000,
    lensIntensity: 2.6,
    glowIntensity: 0.85,
    lampIntensity: 0,
  },
  night: {
    exposure: 1.3,
    envIntensity: 0.85,
    backgroundIntensity: 0.32,
    skyColor: 0x0a0e17,
    fogNear: 1.0,
    fogFar: 2.6,
    fogColor: 0x1b1620,
    hazeStrength: 0.96,
    keyColor: 0x9fb6ee,
    keyIntensity: 0.5,
    keyDirection: [-0.4, 0.68, -0.55],
    skyFill: 0x2a3444,
    groundFill: 0x0d1017,
    fillIntensity: 0.28,
    shadowBias: -0.0009,
    markingColor: 0x767f8c,
    centerLineColor: 0x9b8452,
    groundTint: 0.34,
    asphaltTint: 0.52,
    vehicleEmissive: 0x0b0d12,
    lensIntensity: 3.8,
    glowIntensity: 1.7,
    lampIntensity: 3.2,
  },
};
