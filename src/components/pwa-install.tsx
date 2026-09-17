"use client";

import { useEffect, useState } from "react";
import { Download, Smartphone } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export function PwaInstall() {
  const pathname = usePathname();
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const displayMode = window.matchMedia("(display-mode: standalone)");
    const syncInstalled = () => setInstalled(displayMode.matches);
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    const markInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };

    syncInstalled();
    displayMode.addEventListener("change", syncInstalled);
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      displayMode.removeEventListener("change", syncInstalled);
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  if (pathname !== "/more" || installed) return null;

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setInstallPrompt(null);
  }

  return <section className="section card" aria-labelledby="install-compass">
    <div className="row plain" style={{ minHeight: 64 }}>
      <span className="cluster" style={{ gap: 12, flexWrap: "nowrap", minWidth: 0 }}>
        <span className="menu-icon"><Smartphone aria-hidden /></span>
        <span style={{ minWidth: 0 }}><span className="title" id="install-compass">Install on this phone</span><span className="meta">{installPrompt ? "Adds a Job Seeker icon to your home screen." : "In Chrome: menu → Install app, or Add to Home screen."}</span></span>
      </span>
      {installPrompt && <Button className="btn-primary btn-sm" type="button" onClick={install}><Download aria-hidden />Install</Button>}
    </div>
  </section>;
}
