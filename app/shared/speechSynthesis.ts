/** English speaker ids from sherpa-onnx's Kokoro v1.0 voice table.
 * https://github.com/k2-fsa/sherpa-onnx/blob/edd126edb552001356bbf2000ed73a18ef5da9b0/scripts/kokoro/v1.0/generate_voices_bin.py
 * Keep ids explicit: other Kokoro releases use different voice tables.
 */
export const KOKORO_ENGLISH_VOICES = [
  { name: "af_alloy", sid: 0 },
  { name: "af_aoede", sid: 1 },
  { name: "af_bella", sid: 2 },
  { name: "af_heart", sid: 3 },
  { name: "af_jessica", sid: 4 },
  { name: "af_kore", sid: 5 },
  { name: "af_nicole", sid: 6 },
  { name: "af_nova", sid: 7 },
  { name: "af_river", sid: 8 },
  { name: "af_sarah", sid: 9 },
  { name: "af_sky", sid: 10 },
  { name: "am_adam", sid: 11 },
  { name: "am_echo", sid: 12 },
  { name: "am_eric", sid: 13 },
  { name: "am_fenrir", sid: 14 },
  { name: "am_liam", sid: 15 },
  { name: "am_michael", sid: 16 },
  { name: "am_onyx", sid: 17 },
  { name: "am_puck", sid: 18 },
  { name: "am_santa", sid: 19 },
  { name: "bf_alice", sid: 20 },
  { name: "bf_emma", sid: 21 },
  { name: "bf_isabella", sid: 22 },
  { name: "bf_lily", sid: 23 },
  { name: "bm_daniel", sid: 24 },
  { name: "bm_fable", sid: 25 },
  { name: "bm_george", sid: 26 },
  { name: "bm_lewis", sid: 27 },
] as const;

export interface SpeechSynthesisSettings {
  enabled: boolean;
  voice: string;
  speed: number;
  numThreads: number;
  idleShutdownSeconds: number;
}

export const DEFAULT_SPEECH_SYNTHESIS_SETTINGS: SpeechSynthesisSettings = {
  enabled: true,
  voice: "af_heart",
  speed: 1,
  numThreads: 8,
  idleShutdownSeconds: 600,
};

export const SPEECH_SYNTHESIS_LIMITS = {
  speed: { min: 0.5, max: 2 },
  numThreads: { min: 1, max: 32 },
  idleShutdownSeconds: { min: 0, max: 24 * 3600 },
  maxTextChars: 500,
  maxAudioSeconds: 30,
  sampleRate: 24000,
} as const;

export interface SpeechSynthesisStatus {
  configured: boolean;
  reason?: string;
  modelId?: string;
  availableVoices: string[];
}

/** POST /api/speech/synthesize. Overrides allow a voice preview before saving.
 * Returns a mono PCM16 WAV at 24 kHz. Abort the fetch to cancel synthesis.
 */
export interface SpeechSynthesizeRequest {
  text: string;
  voice?: string;
  speed?: number;
}
