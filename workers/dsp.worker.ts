/// <reference lib="webworker" />
import { enhance, type EnhanceOptions } from "../lib/dsp";

type Req = { samples: Float32Array; sampleRate: number; options: EnhanceOptions };

self.onmessage = (e: MessageEvent<Req>) => {
  const { samples, sampleRate, options } = e.data;
  try {
    const out = enhance(samples, sampleRate, options, (stage, fraction) =>
      self.postMessage({ type: "progress", stage, fraction }),
    );
    self.postMessage({ type: "done", samples: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", message: String(err) });
  }
};
