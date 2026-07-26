"use client";

import dynamic from "next/dynamic";

// three.js must never run on the server: load the Viewer client-side only.
const Viewer = dynamic(() => import("./Viewer"), { ssr: false });

export default function ViewerShell() {
  return <Viewer />;
}
