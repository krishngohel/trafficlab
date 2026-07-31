"use client";

import dynamic from "next/dynamic";

// three.js must never run on the server: load the demo client-side only, so the
// route still prerenders to static HTML under `output: "export"`.
const Demo = dynamic(() => import("./Demo"), { ssr: false });

export default function DemoShell() {
  return <Demo />;
}
