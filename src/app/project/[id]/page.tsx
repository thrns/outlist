import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectDetails } from "@/components/project/project-details";
import { CatalogError } from "@/components/directory/catalog-error";
import { publicCatalogErrorDescription, publicCatalogErrorTitle } from "@/lib/catalog/messages";
import {
  getPublicProjectBySlug,
  getPublicProjectDescriptionBySlug,
  searchPublicProjects,
  withPublicProjectLogos,
  type PublicCatalogProject,
} from "@/lib/catalog/public";
import type { PublicCatalogProjectView } from "@/lib/catalog/public";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const { id } = await params;
    const project = await getPublicProjectBySlug(id);
    return project
      ? { title: project.name, description: project.summary }
      : { title: "Project not found", description: "This project is not available in the published catalog." };
  } catch {
    return { title: "Project", description: "Published project details from the Outlist catalog." };
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let project: PublicCatalogProject | null = null;
  let description: string | null = null;
  let related: PublicCatalogProjectView[] = [];
  let presentedProject: PublicCatalogProjectView | null = null;
  try {
    project = await getPublicProjectBySlug(id);
    if (project) {
      description = await getPublicProjectDescriptionBySlug(project.slug);
      if (description !== null) {
        const projectId = project.id;
        [presentedProject] = await withPublicProjectLogos([project]);
        const relatedResult = await searchPublicProjects({
          categories: [project.primaryCategory.slug],
          sort: "stars",
          page: 1,
          pageSize: 4,
        });
        related = (await withPublicProjectLogos(relatedResult.items))
          .filter((item) => item.id !== projectId)
          .slice(0, 3);
      }
    }
  } catch (error) {
    return <CatalogError description={publicCatalogErrorDescription(error)} title={publicCatalogErrorTitle(error)} retryHref={"/project/" + id} />;
  }
  if (!project || description === null || !presentedProject) notFound();
  return <ProjectDetails project={presentedProject} description={description} related={related} />;
}
