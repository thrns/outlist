"use client";
import {useState} from "react";
import Link from "next/link";
import {useDirectory} from "@/context/directory-provider";
import {alternativeGroups} from "@/data/catalog";
import {Glyph} from "@/components/project/glyph";
import {NativeSelect} from "@/components/ui/native-select";
import {Button} from "@/components/ui/button";
import {EmptyState} from "@/components/ui/empty-state";
export function AlternativesPage(){
  const {visibleProjects}=useDirectory();const [query,setQuery]=useState(""),[selected,setSelected]=useState("");
  const groups=alternativeGroups.map(g=>({...g,projects:g.ids.map(id=>visibleProjects.find(p=>p.id===id)).filter(p=>p!==undefined)})).filter(g=>g.projects.length>0).filter(g=>(!selected||g.name===selected)&&(!query||[g.name,g.desc,...g.projects.map(p=>p.name)].join(" ").toLowerCase().includes(query.toLowerCase().trim())));
  return <main className="container page"><div className="eyebrow muted">Open-source alternatives</div><h1 className="page-title" style={{maxWidth:750,fontSize:36}}>Great software. More freedom.</h1><p style={{maxWidth:650,margin:"0 0 28px",fontSize:15,color:"var(--muted-foreground)"}}>Find open-source options for the proprietary tools you already know. Compare by use case and explore the projects behind them.</p>
    <div className="results-toolbar" style={{justifyContent:"flex-start",maxWidth:780,marginBottom:26}}><label className="filter-search" style={{maxWidth:480}}><Glyph name="search"/><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search software or alternatives..." aria-label="Search alternative groups"/></label><NativeSelect value={selected} onChange={e=>setSelected(e.target.value)} style={{width:"auto",minWidth:190}} aria-label="Filter proprietary software"><option value="">All software</option>{alternativeGroups.map(g=><option key={g.name} value={g.name}>{g.name}</option>)}</NativeSelect></div><div className="small muted" style={{marginBottom:15}}>{groups.length} software categories</div>
    {groups.length?<div className="alt-grid">{groups.map(g=><div className="alt-card" key={g.name}><div className="topline"><span className="project-logo sm">{g.name[0]}</span><div><h3>Alternatives to {g.name}</h3><div className="fine muted">{g.desc}</div></div></div><p>Explore {g.projects.length} open-source {g.projects.length===1?"project":"projects"} you can evaluate instead.</p><div className="equiv">{g.projects.map(p=><Link key={p.id} href={`/project/${p.id}`} className="badge border">{p.name} <Glyph name="chevron" size="sm"/></Link>)}</div></div>)}</div>:<EmptyState title="No alternatives found" description="Try a broader search or return to all software categories."><Button variant="outline" onClick={()=>{setQuery("");setSelected("");}}>Show all</Button></EmptyState>}
    <section className="section"><div className="alt-banner"><div><h3>Know a great open-source alternative?</h3><p className="muted" style={{margin:0}}>Help others discover quality projects by submitting one for review.</p></div><Button asChild><Link href="/submit">Submit a project <Glyph name="arrow"/></Link></Button></div></section></main>;
}
