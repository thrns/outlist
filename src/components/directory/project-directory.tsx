"use client";
import {useMemo,useState} from "react";
import Link from "next/link";
import {useDirectory} from "@/context/directory-provider";
import {categories,categoryById,sortProjects,searchProjects,type SortKey} from "@/data/catalog";
import {Glyph} from "@/components/project/glyph";
import {ProjectCard} from "@/components/project/project-card";
import {Breadcrumb} from "@/components/layout/breadcrumb";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {Checkbox} from "@/components/ui/checkbox";
import {NativeSelect} from "@/components/ui/native-select";
import {EmptyState} from "@/components/ui/empty-state";
const PAGE_SIZE=9;
type FilterField="category"|"license"|"language";
export function ProjectDirectory({categoryId,initialQuery=""}:{categoryId?:string;initialQuery?:string}) {
  const isCategory=Boolean(categoryId),category=categoryById(categoryId||"");
  const {visibleProjects}=useDirectory();
  const [query,setQuery]=useState(initialQuery);
  const [sort,setSort]=useState<SortKey>("trending");
  const [selected,setSelected]=useState<Record<FilterField,string[]>>({category:[],license:[],language:[]});
  const [page,setPage]=useState(1),[filtersOpen,setFiltersOpen]=useState(false);
  const base=useMemo(()=>visibleProjects.filter(p=>!categoryId || p.category===categoryId),[visibleProjects,categoryId]);
  const filtered=useMemo(()=>sortProjects(searchProjects(base,query).filter(p=>selected.category.length===0||selected.category.includes(p.category)).filter(p=>selected.license.length===0||selected.license.includes(p.license)).filter(p=>selected.language.length===0||selected.language.includes(p.language)),sort),[base,query,selected,sort]);
  const totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)),current=Math.min(page,totalPages);
  const paged=filtered.slice((current-1)*PAGE_SIZE,current*PAGE_SIZE);
  function reset(){setSelected({category:[],license:[],language:[]});setQuery("");setPage(1);}
  function choose(field:FilterField,value:string,checked:boolean){setSelected(s=>({...s,[field]:checked?[...s[field],value]:s[field].filter(v=>v!==value)}));setPage(1);}
  const distinct=(field:"license"|"language")=>[...new Set(base.map(p=>p[field]))].sort();
  function filterRows(field:FilterField,items:{id:string;name:string}[]) {return items.map(item=>{
    const id=`filter-${categoryId||"all"}-${field}-${item.id}`;
    const count=base.filter(p=>p[field]===item.id).length;
    return <label className="check-row" htmlFor={id} key={item.id}><Checkbox id={id} checked={selected[field].includes(item.id)} onCheckedChange={v=>choose(field,item.id,v===true)} aria-label={`Filter ${field} by ${item.name}`}/><span>{item.name}</span><strong>{count}</strong></label>;
  });}
  const selectionCounts=selected.category.length+selected.license.length+selected.language.length;
  return <main className="container page">{isCategory&&category?<><Breadcrumb items={[{label:"Home",href:"/"},{label:"Explore",href:"/explore"},{label:category.name}]}/><div className="category-hero"><span className="category-icon" style={{height:56,width:56}}><Glyph name={category.icon} size="lg"/></span><div><h1>{category.name}</h1><p>{category.description}</p><Badge variant="outline">{base.length} projects in this category</Badge></div></div></>:<div className="page-head"><div><div className="eyebrow muted">Open-source directory</div><h1 className="page-title">Explore projects</h1><p className="muted" style={{margin:0}}>Discover and compare {visibleProjects.length} open-source tools across {categories.length} categories.</p></div><Button asChild variant="outline"><Link href="/submit"><Glyph name="plus"/> Submit project</Link></Button></div>}
    <div className="filter-layout"><aside className={`filters ${filtersOpen?"open":""}`} aria-label="Directory filters"><div className="filter-top"><strong>Filters {selectionCounts>0&&<Badge>{selectionCounts}</Badge>}</strong><Button type="button" variant="ghost" size="sm" onClick={reset}>Clear all</Button></div>{!isCategory&&<div className="filter-group"><h3>Categories</h3>{filterRows("category",categories.map(c=>({id:c.id,name:c.name})))}</div>}<div className="filter-group"><h3>License</h3>{filterRows("license",distinct("license").map(id=>({id,name:id})))}</div><div className="filter-group"><h3>Language</h3>{filterRows("language",distinct("language").map(id=>({id,name:id})))}</div><div className="fine muted">Results are filtered locally from demo data.</div></aside>
    <div><div className="results-toolbar"><label className="filter-search"><Glyph name="search"/><input type="search" aria-label="Search directory projects" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}} placeholder="Search projects..."/></label><div className="results-controls"><Button variant="outline" className="filters-mobile-button" onClick={()=>setFiltersOpen(v=>!v)} aria-expanded={filtersOpen}><Glyph name="filter"/> Filters{selectionCounts>0&&` (${selectionCounts})`}</Button><label className="muted fine" htmlFor="directory-sort">Sort by</label><NativeSelect id="directory-sort" value={sort} onChange={e=>{setSort(e.target.value as SortKey);setPage(1);}}><option value="trending">Trending</option><option value="stars">Most starred</option><option value="newest">Recently updated</option><option value="name">Name A–Z</option></NativeSelect></div></div>
      <div className="small muted" style={{margin:"0 0 17px"}}>Showing {filtered.length?(current-1)*PAGE_SIZE+1:0}–{Math.min(current*PAGE_SIZE,filtered.length)} of {filtered.length} projects{query&&` matching “${query}”`}</div>
      {paged.length>0?<><div className="cards-grid">{paged.map(p=><ProjectCard key={p.id} project={p}/>)}</div><nav className="pagination" aria-label="Project pages"><button disabled={current===1} aria-label="Previous page" onClick={()=>{setPage(current-1);window.scrollTo({top:0,behavior:"smooth"});}}>‹</button>{Array.from({length:totalPages},(_,i)=><button key={i} aria-label={`Page ${i+1}`} aria-current={current===i+1?"page":undefined} onClick={()=>{setPage(i+1);window.scrollTo({top:0,behavior:"smooth"});}}>{i+1}</button>)}<button disabled={current===totalPages} aria-label="Next page" onClick={()=>{setPage(current+1);window.scrollTo({top:0,behavior:"smooth"});}}>›</button></nav></>:<EmptyState title="No projects match your filters" description="Try a different search or clear your filters to see more results."><Button variant="outline" onClick={reset}>Clear filters</Button></EmptyState>}
    </div></div></main>;
}
