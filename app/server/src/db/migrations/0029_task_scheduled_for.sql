-- When the user (or an agent planning on their behalf) intends to WORK on a
-- Task, as 'YYYY-MM-DD'. Deliberately separate from due_date: a deadline is
-- imposed from outside and a plan is a choice, and the Backlog's Focus view
-- needs to tell "I picked this up for today" apart from "this is late".
ALTER TABLE tasks ADD COLUMN scheduled_for TEXT;
