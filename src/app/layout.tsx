import type {Metadata,Viewport} from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./globals.css";
import {DirectoryProvider} from "@/context/directory-provider";
import {SiteHeader} from "@/components/layout/site-header";
import {SiteFooter} from "@/components/layout/site-footer";
import {Toaster} from "sonner";
export const metadata:Metadata={
  title:{default:"Outlist — Discover open-source software",template:"%s — Outlist"},
  description:"Explore curated open-source tools, find alternatives to proprietary software, and discover what developers are building next.",
  applicationName:"Outlist",robots:{index:true,follow:true},
};
export const viewport:Viewport={width:"device-width",initialScale:1,colorScheme:"light dark"};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en" suppressHydrationWarning><body><DirectoryProvider><SiteHeader/>{children}<SiteFooter/><Toaster position="bottom-right" richColors closeButton/></DirectoryProvider></body></html>;
}
