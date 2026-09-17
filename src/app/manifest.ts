import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Job Seeker",
    short_name: "Job Seeker",
    description: "A calm control centre for the next great role.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f3f4f7",
    theme_color: "#4f46e5",
    categories: ["productivity", "business"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Today", url: "/", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Pipeline", url: "/pipeline", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Interviews", url: "/interviews", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
