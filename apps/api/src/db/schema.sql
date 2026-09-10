CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
  build_context TEXT NOT NULL DEFAULT '.',
  port INTEGER NOT NULL DEFAULT 3000,
  env JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'idle',
  container_id TEXT,
  image_tag TEXT,
  previous_image_tag TEXT,
  hostname TEXT NOT NULL,
  memory_limit_bytes BIGINT NOT NULL DEFAULT 536870912,
  cpu_nano_cpus BIGINT NOT NULL DEFAULT 1000000000,
  auto_deploy BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deploys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  triggered_by TEXT NOT NULL DEFAULT 'manual',
  image_tag TEXT,
  log TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS deploys_project_id_idx ON deploys(project_id);
CREATE INDEX IF NOT EXISTS deploys_created_at_idx ON deploys(created_at DESC);

CREATE TABLE IF NOT EXISTS databases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  container_id TEXT,
  volume_name TEXT NOT NULL,
  connection_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
