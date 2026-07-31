import DemoShell from "@/components/demo/DemoShell";

/**
 * The public landing page is the guided demo. The full research instrument is
 * unchanged and lives at /studio — someone arriving at the root should meet
 * something they can understand, not a file-drop target.
 */
export default function Home() {
  return <DemoShell />;
}
