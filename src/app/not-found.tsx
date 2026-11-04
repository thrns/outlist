import Link from "next/link";
import {Button} from "@/components/ui/button";
import {EmptyState} from "@/components/ui/empty-state";
import {Glyph} from "@/components/project/glyph";
export default function NotFound() {return <main className="container page"><EmptyState icon={<Glyph name="info" size="lg"/>} title="Page not found" description="This project or page isn't available in the current directory."><Button asChild><Link href="/explore">Browse projects <Glyph name="arrow"/></Link></Button></EmptyState></main>;}
