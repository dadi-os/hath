-- Rename the retired tool names in Hath's live data after the verb_noun rename.
-- NOT RUN. Run in psql against hath-postgres AFTER the new Hath build is live. By default the whole
-- script rolls back (a dry run that prints counts); add -v commit=1 to keep the rewrite:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rename-tools-2026-10-31.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v commit=1 -f rename-tools-2026-10-31.sql
-- Step 1 prints what would change; step 2 backs up (tool_rename_backup_* tables, kept on commit);
-- step 3 rewrites; step 4 prints what is left.
-- Mapping: send -> send_message, message -> queue_message, find -> find_files,
--          hath_spawn_agent -> spawn_agent.
-- Not touched on purpose: ghar_* names (their input shapes differ from get_device and
-- control_device, so a rename would show calls the new tools reject), the `messages` table
-- (what people and agents said stays as said), router-lane send_message rows (already right).

\echo === STEP 1: what would change ===

SELECT 'agent_logs response rows with a renamed tool_use' AS what, count(*) AS rows
FROM agent_logs
WHERE event = 'response'
  AND jsonb_typeof(payload->'content') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(payload->'content') AS b
    WHERE b->>'type' = 'tool_use' AND b->>'name' IN ('send', 'message', 'find', 'hath_spawn_agent')
  );

SELECT 'agent_logs tool_result rows with a renamed name' AS what, count(*) AS rows
FROM agent_logs
WHERE event = 'tool_result' AND payload->>'name' IN ('send', 'message', 'find', 'hath_spawn_agent');

SELECT 'agents whose charter names a renamed tool' AS what, id
FROM agents
WHERE system_prompt ~ '(hath_spawn_agent|`(send|message|find)`|message\(\{|send\(\{)';

SELECT 'scheduled_messages naming a renamed tool' AS what, id
FROM scheduled_messages
WHERE content ~ '(hath_spawn_agent|`(send|message|find)`|message\(\{|send\(\{)';

\echo === STEP 2: backup (kept; drop them yourself once satisfied) ===

BEGIN;

CREATE TABLE tool_rename_backup_agent_logs AS
SELECT * FROM agent_logs
WHERE (event = 'response'
       AND jsonb_typeof(payload->'content') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(payload->'content') AS b
         WHERE b->>'type' = 'tool_use' AND b->>'name' IN ('send', 'message', 'find', 'hath_spawn_agent')))
   OR (event = 'tool_result' AND payload->>'name' IN ('send', 'message', 'find', 'hath_spawn_agent'));

CREATE TABLE tool_rename_backup_agents AS
SELECT * FROM agents
WHERE system_prompt ~ '(hath_spawn_agent|`(send|message|find)`|message\(\{|send\(\{)';

CREATE TABLE tool_rename_backup_scheduled_messages AS
SELECT * FROM scheduled_messages
WHERE content ~ '(hath_spawn_agent|`(send|message|find)`|message\(\{|send\(\{)';

\echo === STEP 3: rewrite ===

UPDATE agent_logs
SET payload = jsonb_set(
  payload,
  '{content}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN b->>'type' = 'tool_use' AND b->>'name' IN ('send', 'message', 'find', 'hath_spawn_agent')
          THEN jsonb_set(b, '{name}', to_jsonb(
            CASE b->>'name'
              WHEN 'send' THEN 'send_message'
              WHEN 'message' THEN 'queue_message'
              WHEN 'find' THEN 'find_files'
              ELSE 'spawn_agent'
            END))
        ELSE b
      END
      ORDER BY ord)
    FROM jsonb_array_elements(payload->'content') WITH ORDINALITY AS t(b, ord)
  ))
WHERE id IN (SELECT id FROM tool_rename_backup_agent_logs WHERE event = 'response');

UPDATE agent_logs
SET payload = jsonb_set(
  payload,
  '{name}',
  to_jsonb(
    CASE payload->>'name'
      WHEN 'send' THEN 'send_message'
      WHEN 'message' THEN 'queue_message'
      WHEN 'find' THEN 'find_files'
      ELSE 'spawn_agent'
    END))
WHERE id IN (SELECT id FROM tool_rename_backup_agent_logs WHERE event = 'tool_result');

UPDATE agents
SET system_prompt = regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(system_prompt, 'hath_spawn_agent', 'spawn_agent', 'g'),
          '`send`', '`send_message`', 'g'),
        '`message`', '`queue_message`', 'g'),
      '`find`', '`find_files`', 'g'),
    '\msend\(\{', 'send_message({', 'g'),
  '\mmessage\(\{', 'queue_message({', 'g')
WHERE id IN (SELECT id FROM tool_rename_backup_agents);

UPDATE scheduled_messages
SET content = regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(content, 'hath_spawn_agent', 'spawn_agent', 'g'),
          '`send`', '`send_message`', 'g'),
        '`message`', '`queue_message`', 'g'),
      '`find`', '`find_files`', 'g'),
    '\msend\(\{', 'send_message({', 'g'),
  '\mmessage\(\{', 'queue_message({', 'g')
WHERE id IN (SELECT id FROM tool_rename_backup_scheduled_messages);

\echo === STEP 4: check, then COMMIT or ROLLBACK ===

SELECT count(*) AS old_names_left_in_logs
FROM agent_logs
WHERE (event = 'tool_result' AND payload->>'name' IN ('send', 'message', 'find', 'hath_spawn_agent'))
   OR (event = 'response'
       AND jsonb_typeof(payload->'content') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(payload->'content') AS b
         WHERE b->>'type' = 'tool_use' AND b->>'name' IN ('send', 'message', 'find', 'hath_spawn_agent')));

\if :{?commit}
  COMMIT;
  \echo committed; the tool_rename_backup_* tables hold the old rows
\else
  ROLLBACK;
  \echo rolled back (dry run); rerun with -v commit=1 to keep the rewrite
\endif
