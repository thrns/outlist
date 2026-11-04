"use client";
import {createContext,useContext,useEffect,useMemo,useState,type ReactNode} from "react";
import {initialSubmissions,seedProjects,type Project,type Submission} from "@/data/catalog";

type Theme = "light" | "dark";
type DirectoryState = {projects:Project[];submissions:Submission[];theme:Theme;syncRuns:number;lastSync:string};
export type SubmissionInput = Pick<Submission,"name"|"repo"|"description"|"category"|"language"|"license"|"website"|"tags">;
interface DirectoryContextValue extends DirectoryState {
  ready:boolean;
  visibleProjects:Project[];
  toggleTheme:()=>void;
  submit:(input:SubmissionInput)=>void;
  approve:(id:string)=>void;
  reject:(id:string)=>void;
  toggleFeature:(id:string)=>void;
  toggleVisibility:(id:string)=>void;
  sync:()=>void;
}
const STORAGE_KEY="outlist-directory-v1";
const initialState:DirectoryState={projects:seedProjects,submissions:initialSubmissions,theme:"light",syncRuns:0,lastSync:"Today, 02:00 UTC"};
const DirectoryContext=createContext<DirectoryContextValue|null>(null);
function isProject(x:unknown): x is Project {return typeof x === "object" && x !== null && typeof (x as Project).id === "string" && typeof (x as Project).repo === "string" && typeof (x as Project).name === "string";}
function isSubmission(x:unknown): x is Submission {return typeof x === "object" && x !== null && typeof (x as Submission).id === "string" && typeof (x as Submission).repo === "string" && typeof (x as Submission).status === "string";}
function readPersisted():DirectoryState {
  try {
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return initialState;
    const saved=JSON.parse(raw) as Partial<DirectoryState>;
    const statuses = new Map<string, Project>((Array.isArray(saved.projects)?saved.projects:[]).filter(isProject).map((p):[string, Project]=>[p.id,p]));
    const projects:Project[]=seedProjects.map(p=>({ ...p, featured:statuses.get(p.id)?.featured ?? p.featured, visible:statuses.get(p.id)?.visible ?? p.visible }));
    for(const p of statuses.values())if(p.userAdded && !projects.some(existing=>existing.id===p.id))projects.push(p);
    return {projects,submissions:Array.isArray(saved.submissions)?saved.submissions.filter(isSubmission):initialSubmissions,theme:saved.theme==="dark"?"dark":"light",syncRuns:typeof saved.syncRuns==="number"?saved.syncRuns:0,lastSync:typeof saved.lastSync==="string"?saved.lastSync:"Today, 02:00 UTC"};
  } catch {return initialState;}
}
export function DirectoryProvider({children}:{children:ReactNode}) {
  const [state,setState]=useState<DirectoryState>(initialState);
  const [ready,setReady]=useState(false);
  useEffect(()=>{
    // SSR renders the seed, then browser state is restored after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(readPersisted());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);
  },[]);
  useEffect(()=>{if(ready){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch{/* Private mode or disabled storage: the session still works. */}}},[state,ready]);
  useEffect(()=>{document.documentElement.classList.toggle("dark",state.theme==="dark");document.documentElement.style.colorScheme=state.theme;},[state.theme]);
  const value=useMemo<DirectoryContextValue>(()=>({
    ...state,ready,visibleProjects:state.projects.filter(p=>p.visible!==false),
    toggleTheme:()=>setState(s=>({...s,theme:s.theme==="light"?"dark":"light"})),
    submit:(input)=>setState(s=>({ ...s, submissions:[{...input,id:`P-${Date.now()}`,created:new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}),status:"pending"},...s.submissions] })),
    approve:(id)=>setState(s=>{
      const submission=s.submissions.find(p=>p.id===id&&p.status==="pending");
      if(!submission)return s;
      const base=submission.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"project";
      let slug=base;let i=2;
      while(s.projects.some(p=>p.id===slug))slug=`${base}-${i++}`;
      const created:Project={id:slug,name:submission.name,repo:submission.repo,description:submission.description,tagline:submission.description,category:submission.category,language:submission.language||"Other",license:submission.license||"Other / check repository",website:submission.website||`https://github.com/${submission.repo}`,tags:submission.tags||[],stars:0,forks:0,alternative:"Other",updated:new Date().toISOString().slice(0,10),featured:false,created:s.projects.length,visible:true,userAdded:true};
      return {...s,projects:[...s.projects,created],submissions:s.submissions.map(p=>p.id===id?{...p,status:"approved" as const}:p)};
    }),
    reject:(id)=>setState(s=>({...s,submissions:s.submissions.map(p=>p.id===id&&p.status==="pending"?{...p,status:"rejected" as const}:p)})),
    toggleFeature:(id)=>setState(s=>({...s,projects:s.projects.map(p=>p.id===id?{...p,featured:!p.featured}:p)})),
    toggleVisibility:(id)=>setState(s=>({...s,projects:s.projects.map(p=>p.id===id?{...p,visible:!p.visible}:p)})),
    sync:()=>setState(s=>({...s,syncRuns:s.syncRuns+1,lastSync:"Just now"})),
  }),[state,ready]);
  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>;
}
export function useDirectory():DirectoryContextValue {
  const context=useContext(DirectoryContext);
  if(!context)throw new Error("useDirectory must be used within DirectoryProvider");
  return context;
}
