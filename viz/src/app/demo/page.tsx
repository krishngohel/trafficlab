import type { Metadata } from "next";

import DemoShell from "@/components/demo/DemoShell";

export const metadata: Metadata = {
  title: "One junction, two traffic lights — trafficlab",
  description:
    "The same ten minutes of traffic at one junction, run twice: a light on a fixed timer against a light that senses the cars waiting.",
};

export default function DemoPage() {
  return <DemoShell />;
}
