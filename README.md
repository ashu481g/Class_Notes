# Lecture Notes Studio

Record or upload a lecture, then:

1. **Clean up the voice.** Rumble/hum filter, spectral noise removal (it learns the noise from the quiet gaps between sentences), a clarity boost, loudness levelling so a soft or distant professor comes through clearly, and an optional pitch shift. All of this runs in your browser.
2. **Transcribe.** Either free on your laptop (Whisper running in the browser, with WebGPU when available) or through OpenAI's cloud speech-to-text.
3. **Write class notes.** Claude turns the transcript into structured notes with LaTeX formulas, Mermaid diagrams and SVG figures. It adds the standard formulas and diagrams for each topic even when the professor didn't write them out, and marks them 📌 *Added for context*.
4. **Slides and narrated video.** From the same transcript, Claude writes an English slide deck (with diagrams and formulas) and a narration script for each slide in natural Hinglish (Hindi + English, Indian teaching style). Download it as PowerPoint (the narration goes in the speaker notes), or create an MP4 in which each slide is explained by a Hindi-English voice. The video is encoded in the browser, much faster than real time (Chrome or Edge).

## Using it with a Claude Pro / Max subscription (no API key)

A Claude Pro or Max subscription covers claude.ai, the desktop app and Claude Code, but it does **not** include an API key. API keys are billed separately, pay as you go, at console.anthropic.com. The app works fully without one:

1. Step 4: **Copy AI prompt**, paste it into claude.ai, and paste Claude's reply back into the app to see the notes with diagrams and formulas.
2. Step 5: **Copy slides prompt**, paste it into claude.ai (for long lectures, attach the downloaded .txt), then paste Claude's JSON reply back (or load it from a file) and click **Load slides**.
3. Choose a free voice (**Swara** or **Madhur**, Microsoft's neural Hindi voices, which read Hindi and English in the same sentence naturally) and click **Create narrated video**.

With an Anthropic API key, the "Generate … with AI" buttons do steps 1–2 inside the app. With an OpenAI key you can also use OpenAI's voices.

> The free voices use the same Microsoft service as Edge's Read Aloud feature. It isn't an official paid API, so Microsoft could change or limit it; the OpenAI voices are the supported alternative.

**Your work is saved as you go.** The audio file, cleaned audio, transcript (including a half-finished one), notes, slides, voice clips and video are kept in the browser (IndexedDB) until you choose a new input file or click **↺ Start over**. Reloading, closing the tab or a crash loses nothing: an interrupted transcription continues from the last finished part, and voice clips are only re-generated for slides whose narration you changed.

## Run on your laptop

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000. Add API keys under ⚙ Settings, or copy `.env.example` to `.env.local` and fill them in:

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | Generating class notes and slides in the app |
| `OPENAI_API_KEY` | Optional: OpenAI narration voices and cloud transcription |

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. On vercel.com, choose **Add New → Project** and import the repo. The defaults work as they are.
3. Under **Settings → Environment Variables**, add `ANTHROPIC_API_KEY` (and optionally `OPENAI_API_KEY`).

⚠️ If you set keys on the server, anyone with your URL can spend your credits. Either keep the URL private, add Vercel's password protection, or leave the server keys empty and paste the key into ⚙ Settings in your own browser.

## Notes and limits

- Audio processing and on-device transcription happen in the browser tab, so keep the tab open. A 1-hour lecture at "Speech (16 kHz)" quality is the most efficient setting.
- Notes generation streams for up to 5 minutes (the Vercel function limit). For very long lectures, Claude Sonnet 5.5 is faster.
- Recordings made in the app are also downloaded automatically as a raw `.webm` backup.
