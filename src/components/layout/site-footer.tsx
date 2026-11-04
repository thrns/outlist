import Link from "next/link";
import { Brand } from "./site-header";
export function SiteFooter() {return <footer className="footer"><div className="container"><div><div style={{fontSize:16}}><Brand small/></div><div style={{marginTop:9}}>Discover what the open source world is building.</div><div style={{marginTop:6}}>Demo content and repository metrics are illustrative, not live data.</div></div><div><Link href="/explore">Directory</Link><Link href="/alternatives">Alternatives</Link><Link href="/submit">Submit</Link><Link href="/admin">Admin demo</Link></div></div></footer>;}
