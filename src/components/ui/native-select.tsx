import * as React from "react";
import { cn } from "@/lib/utils";
// shadcn-compatible native select: ideal for the original compact directory design.
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn("select", className)} {...props}>{children}</select>;
}
export { NativeSelect };
