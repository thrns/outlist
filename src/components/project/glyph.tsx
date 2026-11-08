import { Code2, Brain, LayoutGrid, Paintbrush, BarChart3, Server, Database, MessageSquare, GitFork, Star, Search, ArrowRight, ArrowUp, ExternalLink, ChevronRight, Moon, Sun, Menu, X, Check, CheckCircle2, Filter, Clock, RotateCw, Info, Plus, List, Box, House, Shield, Workflow, type LucideProps } from "lucide-react";
const glyphs = {code:Code2,brain:Brain,grid:LayoutGrid,paint:Paintbrush,chart:BarChart3,server:Server,database:Database,message:MessageSquare,house:House,shield:Shield,workflow:Workflow,git:GitFork,star:Star,search:Search,arrow:ArrowRight,up:ArrowUp,external:ExternalLink,chevron:ChevronRight,moon:Moon,sun:Sun,menu:Menu,close:X,check:Check,circlecheck:CheckCircle2,filter:Filter,clock:Clock,refresh:RotateCw,info:Info,plus:Plus,list:List,box:Box};
export type GlyphName = keyof typeof glyphs;
export function Glyph({name, size="default", ...props}: {name:GlyphName|string;size?:"default"|"sm"|"lg"}&Omit<LucideProps,"size">) {
  const Icon = glyphs[name as GlyphName] ?? LayoutGrid;
  return <Icon {...props} className={["icon",size === "default" ? "" : size,props.className].filter(Boolean).join(" ")} strokeWidth={1.8} aria-hidden="true" />;
}
