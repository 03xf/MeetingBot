# Quick start (packaged users)

For people who downloaded an installer. No Node.js, no Python, no commands.

中文版：[QUICK_START.zh-CN.md](QUICK_START.zh-CN.md)

---

## What you need

| Item | Notes |
|---|---|
| OS | Windows 10 / 11 (64-bit). There is no macOS installer yet — see [INSTALL_MACOS.en.md](INSTALL_MACOS.en.md) |
| Network | Enough to reach the providers you choose |
| API keys | One for speech recognition, one for AI answers (a single provider can cover both). You create them; the provider bills you |
| Time | About 5 minutes the first time, mostly signing up and copying keys |

MeetingBot is **bring-your-own-key**: no accounts, no server, no fee collected by this app. If "API key" means nothing to you yet, read [API_KEYS.en.md](API_KEYS.en.md) first.

---

## Step 1 — download and install

1. Open the [Releases page](https://github.com/03xf/MeetingBot/releases).
2. Download `MeetingBot-<version>-win-x64.exe` (installer) or `...-win-x64-portable.exe` (portable). The difference and the install locations are in [INSTALL_WINDOWS.en.md](INSTALL_WINDOWS.en.md).
3. This beta is not code-signed, so Windows SmartScreen shows "Windows protected your PC". Once you have confirmed the file came from the official release page above, click **More info → Run anyway**.
4. Verify the download first if you can: every `.exe` ships with a matching `.exe.sha256` file containing the hash CI computed at build time.

---

## Step 2 — follow the setup wizard (5 steps)

The wizard opens by itself on first launch. It is a normal, taskbar-visible window that screen sharing can see (so someone can walk you through it remotely); the main overlay stays closed until it finishes.

### 1️⃣ Welcome

Explains bring-your-own-key, what an API key is, and where your data goes:

- keys are encrypted and stored on this machine;
- with cloud speech recognition, meeting audio goes to the ASR provider you chose;
- with a cloud LLM, the transcript and the material you import go to the LLM provider you chose;
- with local speech recognition, audio never leaves the machine.

The toggle in the top-right switches **中文 / English**, and that choice becomes the app's UI language.

### 2️⃣ Pick a plan

| Plan | Combination | Keys needed | Good for |
|---|---|---|---|
| **Low latency (recommended)** | Alibaba Cloud realtime ASR + DeepSeek answers | 2 | The snappiest captions, mixed Chinese/English meetings |
| **Minimal setup** | MiMo ASR + MiMo answers | 1 (one key can serve both) | Signing up with a single platform. Captions arrive per sentence, so they trail a little (Beta) |
| **Transcription only** | Alibaba Cloud realtime ASR | 1 | You do not want AI answers yet |
| **Advanced / local** | Changes nothing, goes straight to the app | 0 | You plan to use local FunASR / MOSS / Whisper or a custom provider |

"Advanced / local" ends the wizard immediately; configure everything from Settings afterwards.

### 3️⃣ Configure the services

One card per service, each with the provider tutorial inline:

1. click "Open the official key page", create a key on the provider site and copy it;
2. come back and paste it (there is a "Paste from clipboard" button);
3. click "Save and test connection".

Saving strips surrounding whitespace, wrapping quotes and a `Bearer ` prefix automatically. The connection test sends one **tiny** real request (1 token / ~1.4 s of audio / a 64×64 image), so the provider may charge a very small amount. Tests only ever run when you click — nothing is called in the background.

On failure the card shows an error code and the single next action worth taking, plus a "Save and retry later" escape hatch.

### 4️⃣ Connection test

- **Computer audio**: play anything with sound, click "Start test" and watch the level meter move. If it stays flat, the card lists what to check.
- **Microphone (optional)**: transcribes your own voice on a separate channel. Use headphones so the speakers do not echo back.
- **Checklist**: which keys are saved, whether audio works, and the latest connection-test verdicts. Anything still "Not saved" or "No sound" blocks "Next"; merely untested does not.

### 5️⃣ Done

Review the summary and click "Enter MeetingBot". The wizard writes the whole plan as a **single** settings update and closes; the main window opens.

> You can reopen the wizard at any time: **⚙ Settings → Run the setup wizard again**. The main window keeps running while it is open.

---

## Step 3 — your first meeting

Windows beta.11 starts in **Browse mode**, with a non-focusable window. Answer, scroll, switch sessions and copy here; explicitly enter **Edit mode** to type, change settings or audio devices, or import files. Return to Browse afterwards. The first-run wizard is a normal focusable window. This is a test prerelease: native input acceptance in Edge / Chrome and platform tests on Feishu / Beisen remain pending. See the [release notes](../releases/v0.2.0-beta.11.md).

1. Play something with speech in it (a meeting, a video, a podcast).
2. Click **▶ Start** in the title bar; the Transcript pane on the left starts filling.
3. Click **Cut & answer** to combine all other-party speech since the last submission. If an utterance is still in progress, the app actively finalizes its recorded portion and includes it even before subtitles appear. Recognition finishes before answering. Your microphone transcript is excluded; pauses never trigger answers.
4. Preview finalized pending segments in the left pane; the current utterance is added after cut recognition finishes. Recording continues, and audio after the boundary belongs to the next question. **Cancel submission** cancels the answer, keeps recognized speech pending and preserves the boundary. Failed or cancelled answers return to the queue. Single-line **⚡Ans** and selected-text answers do not advance this queue. The service still needs time to recognize audio; cutting mid-word may reduce accuracy. Recognition failure prevents incomplete submission.
5. For answers grounded in your experience, import material with **📄Resume** / **📋JD** (`.md/.txt/.docx/.pdf`). Parsing is local; the text is only sent to the LLM you configured, and only as context for a question you asked.

Other title-bar controls:

| Button | What it does |
|---|---|
| `A:ZH` / `A:EN` | Language the AI answers in |
| `Text` / `Vision` | Answer with the text LLM, or with the vision model (screenshot Q&A) |
| `🎤Mic` | Transcribe your own voice separately |
| `Capture protection` | Controls recording capture protection; does not certify focus preservation or platform detection results |
| `Browse mode` / `Edit mode` | Browse is non-focusable; explicit editing allows activation |
| `—` | Hide the window; the hotkey or the tray icon brings it back |

---

## Custom instructions

Open **⚙ Settings → Custom instructions**, enter your requirements and click **Save**. The next question uses them across all sessions; they persist after restart. Existing answers are unchanged. Combined questions, single-line answers, free questions and screenshots (including multimodal answers) all carry these instructions. They replace the default interview style; clear the field to restore it. Knowledge and code formatting rules remain, while translation is unaffected. Instructions are stored locally and sent to your configured model with answer requests.

## Background transparency

Open **⚙ Settings → Background transparency** and drag to preview (0% opaque, up to 95% transparent). **Save** keeps the setting after restart; cancelling or closing settings restores the saved value. Only the background changes: text and buttons remain clear, and code blocks retain a solid background.

## Lost the window?

The main window deliberately stays out of the taskbar, so after hiding it there are two ways back:

- press the show/hide hotkey (`Control+B` by default, changeable in Settings);
- click the MeetingBot icon in the system tray, or pick "Show window" from its menu.

The tray menu also has Start/Stop transcription, New session, Settings, Service status, Help & guides, Check for updates and Quit. The first time the window is hidden you get one balloon reminder, and never again.

---

## When something goes wrong

1. Open **Help & guides** in the app (tray menu, or Settings → Help & guides). It works offline.
2. Read [TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md) for the full error-code table.
3. Still stuck: Settings → Advanced → Diagnostics, copy the report (it has no keys, resume text or transcripts) and open an issue at [GitHub Issues](https://github.com/03xf/MeetingBot/issues).
