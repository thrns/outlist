"use client";
import {useEffect} from "react";
import Link from "next/link";
import {Button} from "@/components/ui/button";
import {Glyph} from "@/components/project/glyph";
export default function Error({error,reset}:{error:Error & {digest?:string};reset:()=>void}) {
  useEffect(()=>{console.error("Outlist page error:",error);},[error]);
  return <main className="container page"><div className="empty-state"><Glyph name="info" size="lg"/><strong>Something went wrong</strong><p>We couldn&apos;t load this page. You can try again or return to the directory.</p><div className="flex justify-center gap-2 flex-wrap mt-5"><Button onClick={reset}>Try again</Button><Button asChild variant="outline"><Link href="/explore">Browse projects</Link></Button></div></div></main>;
}
