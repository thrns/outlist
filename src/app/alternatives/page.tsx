import type {Metadata} from "next";
import {AlternativesPage} from "@/components/directory/alternatives-page";
export const metadata:Metadata={title:"Alternatives",description:"Public alternatives will be listed after their catalog relationships are approved."};
export default function Page(){return <AlternativesPage/>;}
