// In-browser Whisper speech-to-text (free, private: audio never leaves the laptop).
// Model files are downloaded once from Hugging Face and cached by the browser.
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

let transcriber = null;
let loadedKey = "";

async function load(model) {
  const webgpu = !!(self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter().catch(() => null)));
  const key = model + (webgpu ? ":gpu" : ":cpu");
  if (transcriber && loadedKey === key) return webgpu;
  transcriber = await pipeline("automatic-speech-recognition", model, {
    device: webgpu ? "webgpu" : "wasm",
    dtype: webgpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
    progress_callback: (p) => {
      if (p.status === "progress" && p.total) {
        self.postMessage({ type: "loading", file: p.file, fraction: p.loaded / p.total });
      }
    },
  });
  loadedKey = key;
  return webgpu;
}

self.onmessage = async (e) => {
  const { model, samples, sampleRate, chunks, language, skip = [] } = e.data;
  const alreadyDone = new Set(skip); // chunks finished in an earlier, interrupted run
  try {
    const gpu = await load(model);
    self.postMessage({ type: "ready", gpu });
    const englishOnly = model.endsWith(".en");
    for (let i = 0; i < chunks.length; i++) {
      if (alreadyDone.has(i)) continue;
      const [s, end] = chunks[i];
      const out = await transcriber(samples.subarray(s, end), {
        ...(englishOnly ? {} : { language: language || "english", task: "transcribe" }),
        chunk_length_s: 30,
      });
      self.postMessage({ type: "chunk", index: i, total: chunks.length, start: s / sampleRate, text: (out.text || "").trim() });
    }
    self.postMessage({ type: "done" });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
};
