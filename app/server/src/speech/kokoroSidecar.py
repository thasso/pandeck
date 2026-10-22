"""Warm Kokoro CPU worker. JSON-line requests; framed JSON + PCM16-LE replies.

stdout is protocol only. Never log text/audio or write audio to disk.
Cancellation is read on a separate thread while generate() runs on the main one.
"""
import argparse
import json
import queue
import struct
import sys
import threading

MAX_TEXT = 500
MAX_SAMPLES = 24000 * 30
output = sys.stdout.buffer
jobs = queue.Queue(maxsize=1)
lock = threading.Lock()
current = None
stopping = threading.Event()


def emit(header, pcm=b""):
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    output.write(struct.pack("<I", len(encoded)))
    output.write(encoded)
    output.write(pcm)
    output.flush()


def read_requests():
    global current
    try:
        while not stopping.is_set():
            line = sys.stdin.buffer.readline(8193)
            if not line:
                break
            if len(line) > 8192 or not line.endswith(b"\n"):
                raise ValueError("Oversized protocol request")
            request = json.loads(line)
            with lock:
                if request["type"] == "cancel":
                    if current and current[0] == request["id"]:
                        current[1].set()
                elif request["type"] == "synthesize":
                    if current:
                        raise ValueError("Concurrent synthesis is not supported")
                    if (not isinstance(request["text"], str)
                            or not 0 < len(request["text"]) <= MAX_TEXT
                            or not isinstance(request["sid"], int)
                            or not 0 <= request["sid"] <= 27
                            or not 0.5 <= request["speed"] <= 2):
                        raise ValueError("Invalid synthesis request")
                    cancel = threading.Event()
                    current = (request["id"], cancel)
                    jobs.put_nowait((request, cancel))
                else:
                    raise ValueError("Unknown request")
    finally:
        stopping.set()
        with lock:
            if current:
                current[1].set()


def main():
    global current
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, required=True)
    args = parser.parse_args()
    from pathlib import Path
    import numpy as np
    import sherpa_onnx
    directory = Path(args.model_dir)
    model = sherpa_onnx.OfflineTtsModelConfig(
        num_threads=args.threads, provider="cpu", debug=False)
    model.kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=str(directory / "model.onnx"), voices=str(directory / "voices.bin"),
        tokens=str(directory / "tokens.txt"), data_dir=str(directory / "espeak-ng-data"),
        lexicon=str(directory / "lexicon-us-en.txt"), dict_dir=str(directory / "dict"),
        lang="en-us")
    config = sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1)
    if not config.validate():
        raise ValueError("Invalid Kokoro configuration")
    tts = sherpa_onnx.OfflineTts(config)
    # Exercise graph initialization before readiness, never return this audio.
    generation = sherpa_onnx.GenerationConfig()
    generation.sid = 3
    tts.generate("Ready.", generation)
    emit({"type": "ready"})
    threading.Thread(target=read_requests, daemon=True).start()
    while not stopping.is_set():
        try:
            request, cancel = jobs.get(timeout=0.1)
        except queue.Empty:
            continue
        samples_seen = 0
        too_long = False

        def callback(samples, progress):
            nonlocal samples_seen, too_long
            samples_seen += len(samples)
            too_long = samples_seen > MAX_SAMPLES
            return 0 if cancel.is_set() or too_long or stopping.is_set() else 1

        try:
            generation = sherpa_onnx.GenerationConfig()
            generation.sid = request["sid"]
            generation.speed = request["speed"]
            audio = tts.generate(request["text"], generation, callback)
            if cancel.is_set():
                header, pcm = {"type": "cancelled", "id": request["id"]}, b""
            elif too_long or len(audio.samples) > MAX_SAMPLES or audio.sample_rate != 24000:
                raise ValueError("Synthesis exceeded audio limits")
            else:
                pcm = (np.clip(np.asarray(audio.samples), -1, 1) * 32767).astype("<i2").tobytes()
                if not pcm:
                    raise ValueError("No audio generated")
                header = {"type": "audio", "id": request["id"], "sampleRate": 24000, "bytes": len(pcm)}
        except Exception:
            # Error text from phonemizers can contain the input. Keep it private.
            header, pcm = {"type": "error", "id": request["id"]}, b""
        # Clear admission before the reply: Node may send the next request as soon
        # as it receives this frame. The lock orders it after this job's release.
        with lock:
            current = None
            emit(header, pcm)


if __name__ == "__main__":
    main()
