"use client";
import {useCallback,useEffect,useState} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {Button} from "@/components/ui/button";
import {Glyph} from "@/components/project/glyph";
import {CommandSearch} from "./command-search";
import {useDirectory} from "@/context/directory-provider";
const links=[{href:"/explore",name:"Explore"},{href:"/categories",name:"Categories"},{href:"/alternatives",name:"Alternatives"}];
export function Brand({small=false}:{small?:boolean}) {return <Link href="/" className="brand" aria-label="Outlist home"><span className="brand-mark" style={small?{width:24,height:24,borderRadius:6}:undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v16h4M16 4h4v16h-4M10 9h4v6h-4z"/></svg></span>outlist<span style={{opacity:.45}}>.</span></Link>;}
export function SiteHeader() {
  const pathname=usePathname();
  const {theme,toggleTheme}=useDirectory();
  const [commandOpen,setCommandOpen]=useState(false);
  const [mobileOpen,setMobileOpen]=useState(false);
  const onCommandOpen=useCallback((value:boolean)=>setCommandOpen(value),[]);
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setCommandOpen(v=>!v);}};window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler);},[]);
  return <><header className="navbar"><div className="container nav-inner"><Brand/><nav className="nav-links" aria-label="Main navigation">{links.map(link=><Link key={link.href} href={link.href} aria-current={pathname.startsWith(link.href.slice(0,8))?"page":undefined} className={`nav-link ${pathname.startsWith(link.href.slice(0,8))?"active":""}`}>{link.name}</Link>)}</nav>
    <div className="nav-actions"><button type="button" className="command-trigger" onClick={()=>setCommandOpen(true)} aria-label="Search projects, command K"><Glyph name="search" size="sm"/> Search projects <kbd>⌘ K</kbd></button><Button variant="outline" asChild className="nav-submit"><Link href="/submit"><Glyph name="plus" size="sm"/> Submit project</Link></Button><Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={`Switch to ${theme==="light"?"dark":"light"} theme`} title="Toggle theme"><Glyph name={theme==="light"?"moon":"sun"}/></Button><Button variant="ghost" size="icon" className="mobile-toggle" onClick={()=>setMobileOpen(v=>!v)} aria-label="Toggle navigation" aria-expanded={mobileOpen}><Glyph name={mobileOpen?"close":"menu"}/></Button></div></div>
    <nav className={`mobile-nav ${mobileOpen?"open":""}`} aria-label="Mobile navigation"><button type="button" onClick={()=>{setMobileOpen(false);setCommandOpen(true);}}><Glyph name="search" size="sm"/> Search published projects</button>{[...links,{href:"/submit",name:"Submit a project"}].map(link=><Link href={link.href} key={link.href} onClick={()=>setMobileOpen(false)}>{link.name}</Link>)}</nav>
  </header><CommandSearch key={commandOpen?"open":"closed"} open={commandOpen} onOpenChange={onCommandOpen}/></>;
}
