import type { ReactNode } from "react";
import { Search } from "lucide-react";
export function EmptyState({title,description,children,icon}: {title:string;description:string;children?:ReactNode;icon?:ReactNode}) {
  return <div className="empty-state">{icon || <Search className="icon lg mx-auto" aria-hidden="true" />}<strong>{title}</strong><p>{description}</p>{children}</div>;
}
