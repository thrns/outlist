import type {Metadata} from "next";
import {seedProjects} from "@/data/catalog";
import {ProjectDetails} from "@/components/project/project-details";
export async function generateMetadata({params}:{params:Promise<{id:string}>}):Promise<Metadata>{const {id}=await params;const p=seedProjects.find(p=>p.id===id);return {title:p?.name||"Project",description:p?.description||"Explore an open-source project on Outlist."};}
// Intentionally dynamic: user-submitted projects exist only in this browser's local state.
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <ProjectDetails id={id}/>;}
