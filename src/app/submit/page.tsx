import type {Metadata} from "next";
import {SubmissionPage} from "@/components/directory/submission-page";
export const metadata:Metadata={title:"Submit a project",description:"Public project submissions are currently unavailable."};
export default function Page(){return <SubmissionPage/>;}
