# Generate TTS audio files

Batch-generate text-to-speech audio files using Edge TTS (free, no API key, unlimited).

## Arguments
- $ARGUMENTS should contain: source of text (file path or description), output directory, language/voice

## Instructions

### 1. Setup
Ensure edge-tts is installed:
```bash
pip3 install edge-tts
```

### 2. Create the generation script
Create a Node.js script that:
- Collects all text strings that need audio
- Creates MD5 hash of each text as filename (for deduplication and caching)
- Calls `edge-tts` via execFile for each text
- Skips already-generated files (incremental)
- Writes a manifest.json mapping text → filename
- Reports generated/cached/failed counts

### Script template
```js
import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const AUDIO_DIR = "./audio";
const VOICE = "ja-JP-NanamiNeural"; // Change per language
const RATE = "-10%"; // Slightly slower for learning

if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });

function fileKey(text) {
  return createHash("md5").update(text).digest("hex");
}

function generateOne(text) {
  return new Promise((resolve, reject) => {
    const key = fileKey(text);
    const outPath = join(AUDIO_DIR, `${key}.mp3`);
    if (existsSync(outPath)) return resolve("cached");

    execFile("edge-tts", [
      "--voice", VOICE,
      `--rate=${RATE}`,  // Important: use = format to avoid arg parsing issues
      "--text", text,
      "--write-media", outPath,
    ], (err) => err ? reject(err) : resolve("generated"));
  });
}
```

### Available Japanese voices
- `ja-JP-NanamiNeural` — Female, natural (recommended)
- `ja-JP-KeitaNeural` — Male
- `ja-JP-DaichiNeural` — Male, deeper
- `ja-JP-MayuNeural` — Female, younger

### Available languages (common)
- English: `en-US-JennyNeural`, `en-GB-SoniaNeural`
- Chinese: `zh-CN-XiaoxiaoNeural`
- Korean: `ko-KR-SunHiNeural`
- Spanish: `es-ES-ElviraNeural`

List all voices: `edge-tts --list-voices`

### 3. Serving the audio
Create an Express service or serve from a static directory:
- Serve manifest.json for text→filename lookup
- Serve individual MP3 files with cache headers
- Add auth middleware if needed

### Key notes
- Edge TTS is free with no rate limits
- ~10-15KB per short phrase, ~2.3MB for 189 files
- Rate parameter uses `=` format: `--rate=-10%` (not `--rate -10%`)
- Filenames are MD5 hashes for safe filesystem names and deduplication
