# Review components

- A bare tap on content never creates a comment. Creation comes from a text
  selection, or from a named affordance on a structural unit. A tap on an
  existing highlight still opens its thread.
- Never paint a Custom Highlight under a live browser selection. Native
  selection paint owns that phase; a Custom Highlight may take over after a
  composer opens.
- Comment actuation lives in the page header and inspector on wide layouts, and
  in the object dock row plus its Actions list on small layouts — never in a
  floating bar over content.
- Submit review is offered ONLY while something is pending. The batch is derived
  (open threads no session was handed), so an empty one sends nothing; where it
  appears it takes the chrome's primary SLOT, and the sheet it opens offers the
  object's own action instead (`app/web/docs/ui-shell.md`).
