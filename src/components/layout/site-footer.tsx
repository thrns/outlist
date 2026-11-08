import Link from "next/link";
import { Brand } from "./site-header";
export function SiteFooter() {return <footer className="footer"><div className="container"><div><div style={{fontSize:16}}><Brand small/></div><div style={{marginTop:9}}>Discover projects published in the Outlist catalog.</div></div><div><Link href="/explore">Directory</Link><Link href="/alternatives">Alternatives</Link><Link href="/submit">Submissions</Link></div></div></footer>;}
