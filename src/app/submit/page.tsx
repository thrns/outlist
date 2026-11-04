import type {Metadata} from "next";
import {SubmissionPage} from "@/components/directory/submission-page";
export const metadata:Metadata={title:"Submit a project",description:"Submit an open-source project to the Outlist local review queue."};
export default function Page(){return <SubmissionPage/>;}
