# Voice conversation

The main chat composer offers Conversation beside dictation. It requires an
existing session, a secure microphone-capable browser, streaming recognition and
speech synthesis on the host, and both conversation and spoken replies enabled
in Settings. The disabled button explains the missing capability. Offline
tap-to-start/tap-to-stop dictation remains separate and never auto-sends. All
composers share microphone admission, including the mobile dock.

## Talking and interruption

Conversation keeps the microphone open with echo cancellation, noise suppression
and automatic gain control. The browser reuses the PCM worklet, resamples its
non-integer output rates to 16 kHz and sends paced 200 ms Int16 frames after
recognition admission. It retains no utterance buffer. Upload backpressure stops
conversation rather than replaying stale speech later.

Replacement partials appear on the composer's conversation ledge. A nonempty
final sends through the ordinary composer path, including its attachments,
comments, send restrictions, queueing and permanent-session steering behavior.
The silence threshold is configured in Dictation settings; the recognizer also
forces a final after two minutes of uninterrupted speech. Empty finals do not
send or consume a segment number: the recognizer can reuse that number after a
silence-only endpoint. The ordinary prompt API has no independent per-message
instruction field, so spoken sends append the visible hint "Voice conversation:
answer briefly in plain spoken sentences." No always-on system prompt layer is
added.

The ledge announces starting, listening, hearing you, thinking and speaking. It
stays visible when the mobile composer collapses and offers Stop conversation.
Turning off, changing session, hiding/unloading the page or losing the socket
releases the microphone and closes recognition and playback. Errors stay on the
composer. Reconnecting is an explicit toggle, never an automatic microphone
open.

Only newly arriving assistant text blocks are spoken, not history, thinking,
tool calls or results. Speech uses the runtime stream id, not the display row's
reused `live` id. When a durable entry replaces that row, matching text-block
prefixes transfer the sentence cursors and interruption suppression, so the
response is neither repeated nor unmuted on completion. Markdown links use their
labels; fenced and indented code becomes "Code omitted"; tables and images are
skipped. Complete sentences are synthesized as the response streams, with a
final unpunctuated tail on completion. Long sentences are split within the
server's 500-character limit. One synthesis fetch runs at a time; at most two
decoded sentences are scheduled, with the next buffer starting at the previous
buffer's exact AudioContext end time. Slow synthesis can still cause a gap. A
global busy response is shown, not retried.

Distinct nonempty speech cancels the synthesis fetch, scheduled audio and queue,
including synthesis still waiting for its first buffer. The interrupted
assistant response stays muted as it finishes. The agent keeps running. The next
spoken final uses the same queue/steer choice as typing. Matching recognizer
feedback is ignored against the current/recent spoken text, retained for the
segment through its final. There is no grace period that would swallow a short
genuine "stop". This is a lexical echo guard, not speaker identification:
repeating the exact spoken words may be ignored. Headphones are recommended if
speaker echo remains.

## Settings and preview

The Dictation section owns conversation enablement, installed-model selection,
silence, threads and idle release, plus spoken-reply enablement, the shared 28
English Kokoro voice names, speed, synthesis threads and idle release. Numeric
bounds come from the settings registry. Voice preview uses local picker/speed
values as request overrides, without waiting for a settings echo. Stop preview,
page hide or leaving Settings cancels its request and playback. Preview and
conversation use the same globally single-flight endpoint, so another client can
make synthesis busy. See
[settings](../../../docs/settings.md#speech-conversation) and
[server speech](../../../docs/reference/server-speech.md).
