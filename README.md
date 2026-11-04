# Outlist — Next.js directory prototype

A complete React reconstruction of the supplied standalone Outlist HTML prototype. Uses **Next.js App Router**, **React 19**, **TypeScript**, **Tailwind CSS v4**, and locally-owned **shadcn/ui-style components** (Radix-powered dialog and checkbox, plus button, badge, input, textarea, and native-select components).

## Quick start

Requires Node.js **20.9+** (Node.js 22 LTS recommended).

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No API keys, environment variables, database, or external services are required.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Next.js development server |
| `npm run build` | Create optimized production build |
| `npm start` | Run the production build |
| `npm run typecheck` | Strict TypeScript check |
| `npm run lint` | ESLint with Next.js core-web-vitals + TypeScript rules |
| `npm run check` | Run typecheck, lint, and build |
| `npm run validate:data` | Verify extracted seed data and referential integrity |

## Routes

- `/` — Home, hero search, featured projects, trending/recent, categories
- `/explore` — Search, category/license/language filters, sorting, pagination
- `/categories` — Category directory
- `/category/[id]` — Category-specific filtered directory
- `/project/[id]` — Project details, repository metadata, related projects
- `/alternatives` — Browse and filter proprietary software alternatives
- `/submit` — Form validation and browser-local submission queue
- `/admin` — Approve/reject submissions, feature/unlist listings, mock sync log

## Features

- Responsive design faithfully transcribed from the original HTML's CSS and visual tokens.
- Real Next.js URLs and navigation, React components, accessible form labels and dialog behavior.
- Ctrl/⌘ + K opens global search; Escape closes it; Enter opens the first result.
- Light/dark mode, mobile navigation, mobile filter drawer, searchable/sortable/paginated listing.
- Seed data contains **33 sample projects and 8 categories** from the supplied prototype.
- State is saved under `outlist-directory-v1` in **localStorage** and survives refresh. Approved submissions immediately appear in public directory. Rejected submissions leave the review queue. Featured and visibility changes also persist.
- All sample counts, project activity and repository metadata are **illustrative**. Links point to the project's public GitHub repository and official website as in the source prototype.
- No account system, hosted repository management, automated GitHub ingestion, actual content moderation, or server-side persistence. The sync action is deliberately labeled **mock sync**. This is an explicitly browser-local prototype, not a hosted multi-user directory. To add those later, replace the local `DirectoryProvider` with a database + authenticated API.

## Architecture

```
src/
  app/                 Next.js App Router pages, layout, metadata and loading/error UI
  components/
    ui/                Owned shadcn/ui-style primitives (Radix where needed)
    layout/            Header, footer, command palette, breadcrumbs, headings
    project/           Project cards, logo, details and Lucide icons
    directory/         Directory, filters, category index, alternatives, submission, admin
    home/              Homepage sections
  context/             Typed directory state and localStorage persistence
  data/                Typed model/helpers and seed JSON extracted from original HTML
  lib/                 UI class-name utility
```

## Design fidelity and data

`src/app/globals.css` retains the source HTML's main CSS and breakpoints, with minimal React-specific adjustments. The original sample data and most original copy are retained, including the representative activity chart. The original HTML is **not embedded or executed** anywhere in the application.

The source prototype contained an alternative-project reference (`outline`) without a corresponding project record. This reconstruction omits that nonexistent entry instead of rendering a broken link. It also corrects the original category-filter counting and enforces duplicate-repository validation on submissions.

## Environment

`.env.example` is included for clarity; **no environment variables are necessary**. Inter font files are delivered via the `@fontsource/inter` npm package and bundled locally by Next.js rather than relying on a third-party font CDN.

## Verification note

This project was generated in a sandbox where outbound access to `registry.npmjs.org` was unavailable (`EAI_AGAIN`). Consequently, npm dependency installation, a full Next.js build and runtime browser testing could **not** be completed in that sandbox. The source was instead checked with locally available static tooling. Run `npm install && npm run check` in a normal network-enabled environment to confirm the full toolchain. This limitation is disclosed rather than claiming an unverified successful production build.
