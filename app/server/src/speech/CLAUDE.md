# Speech

Fully local CPU inference for dictation and conversation.

- Audio stays in memory on this machine. Offline dictation buffers one
  utterance; conversation forwards frames without audio history. TTS holds one
  request, never stores audio/text or logs input-bearing native diagnostics.
- Parakeet offline dictation needs the total sample count before audio. Buffer
  and decode once on `/ws/speech`; keep its HTTP retry path unchanged. Live
  partials belong only to Nemotron on `/ws/speech/conversation`, gated on
  sherpa-onnx >= 1.13.5 because older versions drop streaming subwords.
- Decoder-level hotword biasing is unavailable for the shipped Parakeet model
  (verified, not assumed). Keep greedy decoding and fix jargon with the shared
  vocabulary rules, which apply in ONE pass inside `applySpeechVocabulary` —
  never fork a server-local copy, or the Settings preview starts lying.
- The per-utterance byte cap stays DERIVED from
  `maxUtteranceSeconds × sampleRate × 2`; a flat constant wrongly rejects a
  legitimate long utterance from a 48 kHz `AudioContext`.
- Speech frames have separate unions/validation, not `validateClientMessage`.
- Aborting a pending conversation start releases admission immediately. Stale
  warm-ups cannot revive or stop a replacement child.
- Speech is not an agent turn: shutdown rejects work and disposes all engines.
  Recognizer logs must stay outside `DATA_DIR`.
- Kokoro uses the complete fp32 v1.0 directory and shared named speaker ids.
  Preserve cancellation, bounded framing and single-model admission; wait for
  child exit before replacing it. Python and weights remain host capabilities.
- The browser holds the authoritative audio and retries over HTTP, so add no
  server-side utterance state that outlives a connection.
- The recognizer socket listens for `error` with `on`, never `once`: production
  Bun emits it twice for one refused connect, and the warm-up retries refusals
  by design, so an unheard second one crashes the whole server.
