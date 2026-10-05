-- The Day Scan was removed: its synthesis journal and Tempo proposal state
-- machine have no reader left. Worklogs it submitted live in Tempo itself.
DROP TABLE IF EXISTS day_synthesis_candidate_tasks;
DROP TABLE IF EXISTS day_synthesis_runs;
DROP TABLE IF EXISTS day_tempo_proposals;
