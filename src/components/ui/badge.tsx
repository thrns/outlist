import * as React from "react";
import { cn } from "@/lib/utils";
function Badge({ className, variant = "default", ...props }: React.ComponentProps<"span"> & {variant?: "default" | "outline" | "dot"}) {
  return <span data-slot="badge" className={cn("badge", variant === "outline" && "border", variant === "dot" && "dot", className)} {...props} />;
}
export { Badge };
