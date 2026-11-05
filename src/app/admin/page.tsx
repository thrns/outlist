import type {Metadata} from "next";
import {AdminPage} from "@/components/directory/admin-page";
import {AdminAccessState} from "@/components/directory/admin-access-state";
import {AdminAccessDeniedError,AdminAuthUnavailableError,requireAdmin} from "@/lib/auth/admin";
export const dynamic="force-dynamic";
export const revalidate=0;
export const metadata:Metadata={title:"Directory administration",description:"Invite-only Outlist administrator workspace.",robots:{index:false,follow:false}};
export default async function Page(){
  try {
    await requireAdmin();
  } catch(error) {
    if(error instanceof AdminAccessDeniedError)return <AdminAccessState status="denied"/>;
    if(error instanceof AdminAuthUnavailableError)return <AdminAccessState status="service"/>;
    throw error;
  }
  return <AdminPage/>;
}
