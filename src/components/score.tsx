import { scoreTone } from "@/lib/format";

export function Score({ value, size = "md", label }: { value: number | null | undefined; size?: "sm" | "md" | "lg"; label?: string }) {
  const tone = scoreTone(value);
  const classes = ["score", tone, size === "md" ? "" : size].filter(Boolean).join(" ");
  return <span className={classes} aria-label={label ?? (value == null ? "Not scored" : `Fit ${value} out of 100`)} title={value == null ? "Not scored yet" : `Fit ${value}/100`}>{value ?? "–"}</span>;
}
