"use client";
import {useState,type FormEvent} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {categories,categoryById,formatCount,sortProjects} from "@/data/catalog";
import {useDirectory} from "@/context/directory-provider";
import {Glyph} from "@/components/project/glyph";
import {ProjectCard,ProjectMini} from "@/components/project/project-card";
import {ProjectLogo} from "@/components/project/project-logo";
import {SectionHeading} from "@/components/layout/section-heading";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
export function HomePage() {
  const router=useRouter();const [q,setQ]=useState("");
  const {visibleProjects:projects}=useDirectory();
  const byId=(id:string)=>projects.find(p=>p.id===id);
  const visual=["ollama","supabase","penpot","immich","hoppscotch"].map(byId).filter(p=>p!==undefined);
  const featured=["supabase","appflowy","penpot","hoppscotch","ollama","umami"].map(byId).filter(p=>p!==undefined);
  const trending=sortProjects(projects,"stars").slice(0,5);
  const recent=sortProjects(projects,"newest").slice(0,5);
  function search(e:FormEvent<HTMLFormElement>){e.preventDefault();if(q.trim())router.push(`/explore?q=${encodeURIComponent(q.trim())}`);}
  return <><section className="hero"><div className="container hero-inner"><div><div className="eyebrow muted">The independent open-source directory <Badge variant="outline" style={{marginLeft:8}}>Discover · Build · Explore</Badge></div><h1>Discover great software.<br/><span>Built in the open.</span></h1><p className="hero-copy">Explore thoughtfully curated open-source tools, find alternatives to proprietary software, and discover what developers are building next.</p><form className="search-large" onSubmit={search}><Glyph name="search" size="lg"/><input type="search" value={q} onChange={e=>setQ(e.target.value)} aria-label="Search open-source projects" placeholder="Search projects, categories, or technologies..." autoComplete="off" required/><Button type="submit" size="lg">Explore <Glyph name="arrow"/></Button></form><div className="popular-row"><span className="muted fine">Popular:</span>{[categories[1],categories[0],categories[2]].map(c=><Link key={c.id} className="badge border" href={`/category/${c.id}`}>{c.name}</Link>)}</div><div className="hero-note">{projects.length} curated demo projects across {categories.length} categories</div></div><div><div className="hero-visual"><div className="mini-head"><div><div className="semibold">Trending in open source</div><div className="muted fine">Projects builders are exploring</div></div><Badge variant="dot">This week</Badge></div>{visual.map(p=><ProjectMini key={p.id} project={p}/>)}</div></div></div></section>
    <main className="container" style={{paddingBottom:75}}><section className="section"><SectionHeading title="Explore by category" subtitle="Find exactly the kind of tool you need." href="/explore" label="All projects"/><div className="category-grid">{categories.map(c=><Link className="category-tile" href={`/category/${c.id}`} key={c.id}><span className="category-icon"><Glyph name={c.icon}/></span><span><span className="category-name">{c.name}</span><span className="category-count block">{projects.filter(p=>p.category===c.id).length} projects <Glyph name="arrow" size="sm"/></span></span></Link>)}</div></section>
      <section className="section"><SectionHeading title="Featured open-source projects" subtitle="Handpicked tools worth a closer look." href="/explore" label="Browse directory"/><div className="cards-grid">{featured.map(p=><ProjectCard key={p.id} project={p}/>)}</div></section>
      <section className="section list-split"><div><SectionHeading title="Trending projects" subtitle="Popular across the developer ecosystem." href="/explore" label="Explore all"/><div>{trending.map((p,i)=><Link className="rank-row" key={p.id} href={`/project/${p.id}`}><span className="rank">{String(i+1).padStart(2,"0")}</span><ProjectLogo project={p} size="sm"/><span className="grow"><strong>{p.name}</strong><p>{p.tagline}</p></span><span className="meta muted fine"><Glyph name="star" size="sm"/> {formatCount(p.stars)}</span><Glyph name="chevron" size="sm"/></Link>)}</div></div><div><SectionHeading title="Recently updated" subtitle="Fresh activity from the directory." href="/explore" label="View all"/><div>{recent.map(p=><Link className="recent-row" href={`/project/${p.id}`} key={p.id}><ProjectLogo project={p} size="sm"/><span className="grow"><strong>{p.name}</strong><p>{categoryById(p.category)?.name}</p></span><span className="fine muted">{p.updated.slice(5)}</span></Link>)}</div></div></section>
      <section className="section"><div className="alt-banner"><div><div className="eyebrow muted">Make the switch</div><h3>There&apos;s an open-source alternative.</h3><p className="muted" style={{maxWidth:610,margin:0}}>From design tools to analytics, explore transparent, customizable alternatives to the software you already use.</p></div><Button asChild size="lg"><Link href="/alternatives">Explore alternatives <Glyph name="arrow"/></Link></Button></div></section></main></>;
}
