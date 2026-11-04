import type {Metadata} from "next";
import {AdminPage} from "@/components/directory/admin-page";
export const metadata:Metadata={title:"Admin demo",description:"A browser-local moderation and directory administration demo.",robots:{index:false,follow:false}};
export default function Page(){return <AdminPage/>;}
