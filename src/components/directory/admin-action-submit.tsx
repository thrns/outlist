"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

type Props = Omit<ComponentProps<typeof Button>, "children" | "type" | "disabled"> & {
  children: ReactNode;
  pendingLabel: string;
  disabled?: boolean;
};

export function AdminActionSubmit({ children, pendingLabel, disabled, ...buttonProps }: Props) {
  const { pending } = useFormStatus();
  return <Button
    {...buttonProps}
    type="submit"
    disabled={pending || disabled}
    aria-busy={pending}
  >{pending ? pendingLabel : children}</Button>;
}
