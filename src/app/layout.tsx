import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Manrope } from "next/font/google";
import { Navigation } from "@/components/navigation";
import { PwaInstall } from "@/components/pwa-install";
import { isOpenAccess } from "@/lib/open-access";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap", axes: ["opsz", "wdth"] });

export const metadata: Metadata = {
  title: { default: "Job Seeker", template: "%s · Job Seeker" },
  description: "A focused, self-hosted job-search workspace.",
  applicationName: "Job Seeker",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#4f46e5", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} ${bricolage.variable}`}>
      <body>
        <div className="shell">
          <Navigation showLogout={!isOpenAccess()} />
          <main className="main">{children}<PwaInstall /></main>
        </div>
      </body>
    </html>
  );
}
