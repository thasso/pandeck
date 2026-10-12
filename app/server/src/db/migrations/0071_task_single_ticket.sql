-- A Task holds ONE ticket now: a single `jira` or `github` edge. Tasks that
-- held several keep their first (primary) ref — a Jira key before a GitHub
-- ref, then in stored order — and every other ref is kept as a `related`
-- external link, so nothing the user linked is lost. A Jira link needs the
-- site's address, taken from a Jira link already stored on a Task; with none
-- to copy, the extra keys are appended to the Task's description instead.

CREATE TEMP TABLE migrate_ticket_edges AS
SELECT from_id, relation, to_id, created_at_ms,
       ROW_NUMBER() OVER (
         PARTITION BY from_id
         ORDER BY CASE relation WHEN 'jira' THEN 0 ELSE 1 END,
                  COALESCE(position, 0), created_at_ms, to_id
       ) AS rank
  FROM links
 WHERE from_type = 'task' AND relation IN ('jira', 'github');

CREATE TEMP TABLE migrate_jira_site AS
SELECT substr(to_id, 1, instr(to_id, '/browse/') - 1) AS base
  FROM links
 WHERE from_type = 'task' AND relation = 'link' AND to_type = 'url'
   AND to_id LIKE 'http%/browse/%'
   AND json_extract(metadata_json, '$.source') = 'jira'
 ORDER BY created_at_ms DESC
 LIMIT 1;

INSERT OR IGNORE INTO links
  (from_type, from_id, relation, to_type, to_id, position, metadata_json,
   created_at_ms)
SELECT 'task', e.from_id, 'link', 'url',
       CASE e.relation
         WHEN 'github'
           THEN 'https://github.com/' || replace(e.to_id, '#', '/issues/')
         ELSE (SELECT base FROM migrate_jira_site) || '/browse/' || e.to_id
       END,
       NULL,
       json_object('kind', 'related', 'source', e.relation, 'title', e.to_id),
       e.created_at_ms
  FROM migrate_ticket_edges e
 WHERE e.rank > 1
   AND (e.relation = 'github' OR EXISTS (SELECT 1 FROM migrate_jira_site));

UPDATE tasks
   SET description =
         CASE WHEN description = '' THEN '' ELSE description || char(10, 10) END
         || 'Also linked Jira issues: '
         || (SELECT group_concat(e.to_id, ', ')
               FROM migrate_ticket_edges e
              WHERE e.from_id = CAST(tasks.id AS TEXT)
                AND e.rank > 1 AND e.relation = 'jira')
 WHERE NOT EXISTS (SELECT 1 FROM migrate_jira_site)
   AND CAST(id AS TEXT) IN (
         SELECT from_id FROM migrate_ticket_edges
          WHERE rank > 1 AND relation = 'jira');

DELETE FROM links
 WHERE from_type = 'task' AND relation IN ('jira', 'github')
   AND (from_id, relation, to_id) IN (
         SELECT from_id, relation, to_id FROM migrate_ticket_edges
          WHERE rank > 1);

-- Every Task with a ticket changes its wire shape (`ticket` replaces the two
-- lists), so it takes a new revision: a warm client's cached row would
-- otherwise match the digest and keep the old shape.
INSERT INTO sequences (entity_type, next_id) VALUES ('task_revision', 1)
  ON CONFLICT(entity_type) DO UPDATE SET next_id = next_id + 1;

UPDATE tasks
   SET revision = (
         SELECT next_id FROM sequences WHERE entity_type = 'task_revision')
 WHERE CAST(id AS TEXT) IN (SELECT from_id FROM migrate_ticket_edges);

DROP TABLE migrate_ticket_edges;
DROP TABLE migrate_jira_site;
