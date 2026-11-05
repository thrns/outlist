insert into public.categories (slug, name, description, icon_identifier, sort_order, is_active)
values
  (
    'developer-tools', 'Developer Tools',
    'Editors, API clients, automation, testing, and tools for building software.',
    'code', 10, true
  ),
  (
    'ai-machine-learning', 'AI & Machine Learning',
    'Frameworks and tools for building, deploying, evaluating, and observing AI applications.',
    'brain', 20, true
  ),
  (
    'productivity', 'Productivity',
    'Knowledge bases, project management, and personal productivity tools.',
    'grid', 30, true
  ),
  (
    'design', 'Design',
    'Tools for interface design, diagrams, illustration, and creative collaboration.',
    'paint', 40, true
  ),
  (
    'analytics', 'Analytics',
    'Tools for usage analytics, performance monitoring, and data exploration.',
    'chart', 50, true
  ),
  (
    'infrastructure', 'Infrastructure',
    'Self-hosting, cloud infrastructure, deployment, and observability software.',
    'server', 60, true
  ),
  (
    'data-databases', 'Data & Databases',
    'Databases, backends, search engines, and data platforms.',
    'database', 70, true
  ),
  (
    'communication', 'Communication',
    'Open-source collaboration, messaging, and team communication tools.',
    'message', 80, true
  ),
  (
    'self-hosted', 'Self-hosted',
    'Applications designed to run on infrastructure controlled by their operators.',
    'house', 90, true
  ),
  (
    'security-privacy', 'Security & Privacy',
    'Tools focused on security, privacy, identity, and data protection.',
    'shield', 100, true
  ),
  (
    'automation-workflows', 'Automation & Workflows',
    'Tools for automating tasks, connecting services, and coordinating workflows.',
    'workflow', 110, true
  )
on conflict (slug) do update
set name = excluded.name,
    description = excluded.description,
    icon_identifier = excluded.icon_identifier,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active;
