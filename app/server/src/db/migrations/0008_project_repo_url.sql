-- Per-project git URL used to clone/provision the project's repo (via ambient
-- git+ssh). The clone lands under settings.projectsRoot/<project id> and becomes
-- the project's main checkout. Additive: existing rows keep NULL.
ALTER TABLE projects ADD COLUMN repo_url TEXT;
