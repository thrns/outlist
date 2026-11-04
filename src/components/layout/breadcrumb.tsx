import Link from "next/link";
import { Glyph } from "@/components/project/glyph";
export function Breadcrumb({items}:{items:{label:string;href?:string}[]}) {
  return <nav className="crumb" aria-label="Breadcrumb">{items.map((item,index)=><span key={`${item.label}-${index}`} className="inline-flex items-center gap-2">{index>0&&<Glyph name="chevron"/>}{item.href?<Link href={item.href}>{item.label}</Link>:<span aria-current="page">{item.label}</span>}</span>)}</nav>;
}
