import type {Metadata} from "next";
import {AlternativesPage} from "@/components/directory/alternatives-page";
export const metadata:Metadata={title:"Alternatives",description:"Find open-source alternatives to popular proprietary software."};
export default function Page(){return <AlternativesPage/>;}
