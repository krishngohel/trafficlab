import { chromium } from "playwright";
const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu",
         "--autoplay-policy=no-user-gesture-required", "--window-size=1680,980"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://localhost:3199", { waitUntil: "domcontentloaded" });
console.log(await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown",
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : "unknown",
  };
}));
const gpu = await (await browser.newContext()).newPage();
await gpu.goto("chrome://gpu", { waitUntil: "domcontentloaded" }).catch((e) => console.log("gpu page:", String(e).slice(0, 100)));
const txt = await gpu.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => "n/a");
console.log(txt.split("\n").filter((l) => /Video Encode|Video Decode|Canvas|WebGL|Rasterization|GPU compositing/i.test(l)).join("\n"));
await browser.close();
