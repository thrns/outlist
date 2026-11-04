import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {categoryById} from "@/data/catalog";
import {ProjectDirectory} from "@/components/directory/project-directory";
export async function generateMetadata({params}:{params:Promise<{id:string}>}):Promise<Metadata>{const {id}=await params;const c=categoryById(id);return {title:c?.name||"Category",description:c?.description};}
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;if(!categoryById(id))notFound();return <ProjectDirectory categoryId={id}/>;}
