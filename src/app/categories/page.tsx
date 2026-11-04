import type {Metadata} from "next";
import {CategoriesPage} from "@/components/directory/categories-page";
export const metadata:Metadata={title:"Categories",description:"Browse eight categories of open-source software."};
export default function Page(){return <CategoriesPage/>;}
