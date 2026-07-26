import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "trafficlab viz",
  description: "WebGL trajectory visualizer for trafficlab .traj replays",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
