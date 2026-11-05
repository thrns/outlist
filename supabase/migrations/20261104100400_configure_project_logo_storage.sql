-- Public buckets bypass RLS for object downloads. Only reviewed files may be
-- uploaded here by a trusted server, and object paths are recorded on the
-- approved project_logos row before the public URL is exposed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-logos',
  'project-logos',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy project_logos_approved_object_listing on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'project-logos'
    and exists (
      select 1
      from public.project_logos pl
      join public.projects p on p.id = pl.project_id
      where pl.storage_path = storage.objects.name
        and pl.verification_status = 'approved'
        and p.publication_status = 'published'
    )
  );

-- Supabase owns the Storage schema and its table grants. RLS is already
-- enabled by the Storage service; this migration adds only a read policy and
-- no client INSERT, UPDATE, or DELETE policies. The public bucket makes object
-- URLs directly readable without an auth header, so upload only approved
-- assets through a trusted server using the Storage API.
