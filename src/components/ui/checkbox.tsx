"use client";
import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
function Checkbox({className,...props}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return <CheckboxPrimitive.Root data-slot="checkbox" className={cn("peer size-[15px] shrink-0 rounded-[3px] border border-input bg-background shadow-xs outline-offset-2 data-[state=checked]:bg-foreground data-[state=checked]:text-background focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50", className)} {...props}>
    <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center text-current"><Check className="size-3.5" strokeWidth={2.2} /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}
export { Checkbox };
