import Link from "next/link";
import { Glyph } from "@/components/project/glyph";
export function SectionHeading({title,subtitle,href,label="View all"}:{title:string;subtitle?:string;href?:string;label?:string}) {
  return <div className="section-head"><div><h2 className="section-title">{title}</h2>{subtitle && <p className="section-subtitle">{subtitle}</p>}</div>{href && <Link href={href} className="text-link">{label}<Glyph name="arrow" size="sm"/></Link>}</div>;
}
