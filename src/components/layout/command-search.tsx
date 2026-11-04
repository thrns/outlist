"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {useRouter} from "next/navigation";
import {Dialog,DialogContent,DialogDescription,DialogTitle} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Glyph} from "@/components/project/glyph";
import {ProjectLogo} from "@/components/project/project-logo";
import {useDirectory} from "@/context/directory-provider";
import {categories,categoryById,searchProjects} from "@/data/catalog";
export function CommandSearch({open,onOpenChange}:{open:boolean;onOpenChange:(open:boolean)=>void}) {
  const router=useRouter();
  const {visibleProjects}=useDirectory();
  const [query,setQuery]=useState("");
  const inputRef=useRef<HTMLInputElement>(null);
  const projects=useMemo(()=>searchProjects(visibleProjects,query).slice(0,7),[visibleProjects,query]);
  const cats=categories.filter(c=>c.name.toLowerCase().includes(query.toLowerCase().trim())).slice(0,3);
  useEffect(()=>{if(!open)return;function onKey(e:KeyboardEvent){if(e.key==="Enter" && document.activeElement===inputRef.current){const target=projects[0]?`/project/${projects[0].id}`:cats[0]?`/category/${cats[0].id}`:null;if(target){e.preventDefault();onOpenChange(false);router.push(target);}}}window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);},[open,projects,cats,onOpenChange,router]);
  function go(path:string){onOpenChange(false);router.push(path);setQuery("");}
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent showCloseButton={false} onOpenAutoFocus={e=>{e.preventDefault();inputRef.current?.focus();}}>
    <DialogTitle className="sr-only">Search Outlist</DialogTitle><DialogDescription className="sr-only">Search projects and categories; press Enter to open the first matching item.</DialogDescription>
    <div className="command-input-row"><Glyph name="search" size="lg"/><input ref={inputRef} value={query} onChange={e=>setQuery(e.target.value)} aria-label="Search projects and categories" placeholder="Search projects and categories..." autoComplete="off" type="search"/><Button variant="ghost" size="icon" onClick={()=>onOpenChange(false)} aria-label="Close search"><Glyph name="close"/></Button></div>
    <div className="command-results">{projects.length>0&&<><div className="eyebrow muted" style={{padding:"8px 10px"}}>Projects</div>{projects.map(p=><button className="command-result" key={p.id} onClick={()=>go(`/project/${p.id}`)}><ProjectLogo project={p} size="sm"/><span className="grow"><strong>{p.name}</strong><small>{p.tagline} · {categoryById(p.category)?.name}</small></span><Glyph name="chevron" size="sm"/></button>)}</>}
      {cats.length>0&&<><div className="eyebrow muted" style={{padding:"10px 10px 6px"}}>Categories</div>{cats.map(c=><button className="command-result" key={c.id} onClick={()=>go(`/category/${c.id}`)}><span className="category-icon" style={{height:34,width:34}}><Glyph name={c.icon} size="sm"/></span><span className="grow"><strong>{c.name}</strong><small>Explore projects</small></span><Glyph name="chevron" size="sm"/></button>)}</>}
      {projects.length===0&&cats.length===0&&<div className="empty-state" style={{border:0,padding:24}}>No matching projects or categories</div>}</div>
    <div className="command-footer">Enter to open first result · Esc to close · <span className="kbd">⌘ K</span> to search</div>
  </DialogContent></Dialog>;
}
