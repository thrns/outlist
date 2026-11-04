"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
function DialogContent({className,children,showCloseButton=true,...props}:React.ComponentProps<typeof DialogPrimitive.Content> & {showCloseButton?:boolean}) {
  return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/55 data-[state=open]:animate-in" />
    <DialogPrimitive.Content data-slot="dialog-content" className={cn("command-modal fixed left-1/2 top-[12vh] z-[61] max-h-[75vh] w-[calc(100%-32px)] -translate-x-1/2",className)} {...props}>
      {children}{showCloseButton && <DialogPrimitive.Close className="sr-only"><X />Close</DialogPrimitive.Close>}
    </DialogPrimitive.Content></DialogPrimitive.Portal>;
}
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;
export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription };
