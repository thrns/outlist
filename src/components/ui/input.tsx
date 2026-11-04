import * as React from "react";
import { cn } from "@/lib/utils";
function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn("input", className)} {...props} />;
}
export { Input };
