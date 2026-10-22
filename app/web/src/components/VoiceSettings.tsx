import { useEffect, useRef, useState } from "react";
import type { AppSettings, SpeechToTextStatus } from "@assistant/shared";
import { KOKORO_ENGLISH_VOICES } from "@assistant/shared";
import { settingBounds } from "@assistant/shared/settingsRegistry";
import { SpeechPlayer } from "../lib/speechPlayer.ts";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import { Field, FieldLabel, FieldDescription } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import { NativeSelect } from "./ui/native-select.tsx";
import { Switch } from "./ui/switch.tsx";
import { ErrorNote } from "./common/load.tsx";

/** Conversation and synthesis own their registry fields in the Dictation section. */
export function VoiceSettings({
  settings,
  status,
  onUpdate,
}: {
  settings: AppSettings;
  status: SpeechToTextStatus | null;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const conversation = settings.speechConversation;
  const synthesis = settings.speechSynthesis;
  const saveConversation = (patch: Partial<typeof conversation>) =>
    onUpdate({ speechConversation: { ...conversation, ...patch } });
  const saveSynthesis = (patch: Partial<typeof synthesis>) =>
    onUpdate({ speechSynthesis: { ...synthesis, voice, speed, ...patch } });
  const [voice, setVoice] = useState(synthesis.voice);
  const [speed, setSpeed] = useState(synthesis.speed);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const player = useRef<SpeechPlayer | null>(null);
  useEffect(() => {
    setVoice(synthesis.voice);
  }, [synthesis.voice]);
  useEffect(() => {
    setSpeed(synthesis.speed);
  }, [synthesis.speed]);
  useEffect(() => () => player.current?.dispose(), []);
  useEffect(() => {
    if (!synthesis.enabled) {
      player.current?.dispose();
      player.current = null;
      setPreviewing(false);
    }
  }, [synthesis.enabled]);
  useEffect(() => {
    const hide = () => {
      if (!document.hidden) return;
      player.current?.dispose();
      player.current = null;
      setPreviewing(false);
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  const preview = () => {
    player.current?.dispose();
    player.current = null;
    if (previewing) {
      setPreviewing(false);
      return;
    }
    setError(null);
    setPreviewing(true);
    try {
      player.current = new SpeechPlayer({
        voice,
        speed,
        onSpeaking: (speaking) => {
          if (!speaking) setPreviewing(false);
        },
        onError: (message) => {
          setPreviewing(false);
          setError(message);
        },
      });
      player.current.enqueue([
        "Hello. This is how I will sound in our conversation.",
      ]);
    } catch (failure) {
      setPreviewing(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const synthesisReason = !synthesis.enabled
    ? "Enable spoken replies to preview a voice."
    : !status?.tts?.configured
      ? (status?.tts?.reason ?? "Spoken replies are unavailable.")
      : undefined;
  const models = status?.conversation?.availableModelIds ?? [];
  return (
    <>
      <Card className="mt-5">
        <CardContent className="space-y-4 pt-6">
          <h3 className="text-sm font-semibold">Conversation</h3>
          <p className="text-sm text-muted-foreground">
            Keep the microphone open, send after a pause and hear replies aloud.
            Talking over a reply stops its audio, not the agent.
          </p>
          {status?.conversation && !status.conversation.configured && (
            <p className="text-sm text-muted-foreground">
              {status.conversation.reason}
            </p>
          )}
          <Field orientation="horizontal">
            <FieldLabel htmlFor="conversation-enabled">
              Show conversation in the composer
            </FieldLabel>
            <Switch
              id="conversation-enabled"
              checked={conversation.enabled}
              onCheckedChange={(enabled) => saveConversation({ enabled })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="conversation-model">
              Conversation model
            </FieldLabel>
            <NativeSelect
              id="conversation-model"
              value={conversation.modelId}
              onChange={(event) =>
                saveConversation({ modelId: event.target.value })
              }
            >
              <option value="">Automatic</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="conversation-silence">
              Send after silence, seconds
            </FieldLabel>
            <Input
              id="conversation-silence"
              type="number"
              step="0.1"
              {...settingBounds("speechConversation.endpointSilenceSeconds")}
              value={conversation.endpointSilenceSeconds}
              onChange={(event) =>
                saveConversation({
                  endpointSilenceSeconds: Number(event.target.value),
                })
              }
            />
            <FieldDescription>
              Changes apply the next time conversation starts. Unbroken speech
              is sent after two minutes.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="conversation-threads">
              Conversation threads
            </FieldLabel>
            <Input
              id="conversation-threads"
              type="number"
              {...settingBounds("speechConversation.numThreads")}
              value={conversation.numThreads}
              onChange={(event) =>
                saveConversation({ numThreads: Number(event.target.value) })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="conversation-idle">
              Release conversation memory after seconds idle
            </FieldLabel>
            <Input
              id="conversation-idle"
              type="number"
              {...settingBounds("speechConversation.idleShutdownSeconds")}
              value={conversation.idleShutdownSeconds}
              onChange={(event) =>
                saveConversation({
                  idleShutdownSeconds: Number(event.target.value),
                })
              }
            />
            <FieldDescription>Zero keeps the model loaded.</FieldDescription>
          </Field>
        </CardContent>
      </Card>
      <Card className="mt-5">
        <CardContent className="space-y-4 pt-6">
          <h3 className="text-sm font-semibold">Spoken replies</h3>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="synthesis-enabled">
              Enable spoken replies
            </FieldLabel>
            <Switch
              id="synthesis-enabled"
              checked={synthesis.enabled}
              onCheckedChange={(enabled) => saveSynthesis({ enabled })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="synthesis-voice">Voice</FieldLabel>
            <NativeSelect
              id="synthesis-voice"
              value={voice}
              onChange={(event) => {
                setVoice(event.target.value);
                saveSynthesis({ voice: event.target.value });
              }}
            >
              {KOKORO_ENGLISH_VOICES.map(({ name }) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="synthesis-speed">Speaking speed</FieldLabel>
            <Input
              id="synthesis-speed"
              type="number"
              step="0.1"
              {...settingBounds("speechSynthesis.speed")}
              value={speed}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSpeed(next);
                saveSynthesis({ speed: next });
              }}
            />
          </Field>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(synthesisReason)}
              title={synthesisReason}
              onClick={preview}
            >
              {previewing ? "Stop preview" : "Preview voice"}
            </Button>
          </div>
          {synthesisReason && (
            <p className="text-sm text-muted-foreground">{synthesisReason}</p>
          )}
          {error && <ErrorNote message={error} />}
          <Field>
            <FieldLabel htmlFor="synthesis-threads">
              Speech synthesis threads
            </FieldLabel>
            <Input
              id="synthesis-threads"
              type="number"
              {...settingBounds("speechSynthesis.numThreads")}
              value={synthesis.numThreads}
              onChange={(event) =>
                saveSynthesis({ numThreads: Number(event.target.value) })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="synthesis-idle">
              Release speech memory after seconds idle
            </FieldLabel>
            <Input
              id="synthesis-idle"
              type="number"
              {...settingBounds("speechSynthesis.idleShutdownSeconds")}
              value={synthesis.idleShutdownSeconds}
              onChange={(event) =>
                saveSynthesis({
                  idleShutdownSeconds: Number(event.target.value),
                })
              }
            />
            <FieldDescription>Zero keeps the model loaded.</FieldDescription>
          </Field>
        </CardContent>
      </Card>
    </>
  );
}
