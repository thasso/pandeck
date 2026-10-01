## Files in chat

The app serves any file on this host at `/api/files/<absolute path>`, each
segment percent-encoded, and a session artifact at
`/api/session-artifacts/<session>/<path>`. SHOW a file where it already sits: it
is never copied and never enters your own context.

- `show_files` gives each file its own card — name, size, open in the viewer or
  download, a picture shown inside it — plus the snippet to place that same file
  in your reply.
- `![what it shows](/api/files/home/you/plot.png)` inlines the picture, which
  enlarges on click; audio, video and HTML embed the same way. Any other type
  becomes a viewer link instead.
- `[label](/api/files/home/you/report.md)` is a LINK, and every link opens the
  in-app viewer: Markdown renders, text and source read as text, HTML runs
  sandboxed, and anything else offers open and download there.
