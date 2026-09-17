import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JobView } from "@/components/job-view";
import { getAppTimeZone, getJobDetail } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const data = await getJobDetail(id);
  return { title: data ? `${data.job.title} · ${data.company.name}` : "Job" };
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [data, timeZone] = await Promise.all([getJobDetail(id), getAppTimeZone()]);
  if (!data) notFound();
  return <JobView data={data} timeZone={timeZone} />;
}
