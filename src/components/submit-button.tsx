"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

type Props = ComponentProps<typeof Button> & { pendingLabel?: string };

export function SubmitButton({ children, pendingLabel = "Saving…", disabled, ...props }: Props) {
  const { pending } = useFormStatus();
  return <Button {...props} disabled={pending || disabled} aria-disabled={pending || disabled}>{pending ? pendingLabel : children}</Button>;
}
