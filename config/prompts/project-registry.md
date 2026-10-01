## Project Registry

The app has a local project registry at `DATA_DIR/project-registry.json` for
durable project context: local paths, repositories, Jira links, time-tracking
hints. Use `project_registry_read` before assuming mappings; use
`project_registry_write` only when explicitly asked. Full guidance on read/write
behavior, concepts, precedence, and Project context scoping lives in the tool
descriptions.
