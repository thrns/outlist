import type {Metadata} from "next";
import {ProjectDirectory} from "@/components/directory/project-directory";
export const metadata:Metadata={title:"Explore",description:"Search, filter and compare open-source projects."};
export default async function Page({searchParams}:{searchParams:Promise<{q?:string}>}) {
  const {q}=await searchParams;
  return <ProjectDirectory key={q||""} initialQuery={typeof q==="string"?q:""}/>;
}
