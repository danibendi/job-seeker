import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { BriefcaseBusiness } from "lucide-react";
import { LoginForm } from "@/components/login-form";
import { isOpenAccess } from "@/lib/open-access";

export const metadata: Metadata = { title: "Log in" };
export const dynamic = "force-dynamic";

export default function LoginPage() {
  if (isOpenAccess()) redirect("/");
  return <div className="login-wrap"><div className="card login-card"><div className="login-mark"><BriefcaseBusiness aria-hidden /></div><h1>Job Seeker</h1><p className="sub">Your self-hosted job-search workspace.</p><Suspense><LoginForm /></Suspense></div></div>;
}
