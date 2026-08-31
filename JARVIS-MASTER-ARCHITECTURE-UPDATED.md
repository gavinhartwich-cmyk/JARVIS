# JARVIS — Comprehensive Master Architecture

**Updated:** August 31, 2026, seventh pass (08-30: wake-word/mic-gain + VAD fixes; 08-31 first pass: app-control wiring, TTS diagnostic, HUD auto-close, persistent wake-word daemon; 08-31 second pass: duplicate wake-word trigger fix, real app-launch fix via Get-StartApps, a "thinking" audio acknowledgment; 08-31 third pass: Fish Audio TTS integration with automatic Piper fallback; 08-31 fourth pass: real Get-StartApps escaping bug fixed (was opening File Explorer instead of the app), Fish Audio confirmed blocked on payment - Gavin moving to Chatterbox for $0 voice cloning; 08-31 fifth pass: root-caused total playback silence to SoundPlayer's legacy audio path, swapped primary playback to Windows Media Player COM; 08-31 sixth pass: WMP COM confirmed live to hang/timeout, replaced with WPF MediaPlayer + computed-duration sleep; 08-31 seventh pass: built full Chatterbox local voice-cloning TTS integration, provider temporarily reverted to Piper until Gavin has a reference clip)  
**Status:** Phase 0, Phase 1, and Phase 1.5 are now verified real via `verify-jarvis.ps1` run live on Gavin's actual PC (2026-08-30) — see that script and its `setup-logs/` output, not just this doc, for the current pass/fail state. Phase 3 is code-complete and code-verified as of 2026-08-27 but not yet run live. Phase 2's TTS/STT/wake-word/reply path was already real; as of 2026-08-30 mic capture, audio playback, and end-of-turn detection are also real and code-complete (`bun run dev listen`). First real live run found wake-word sensitivity badly miscalibrated (fixed with a mic-gain change + lowered threshold), then a stuck-turn bug (fixed with a self-calibrating per-turn VAD threshold + a soft-clip fix). Re-run after both: wake word, STT, and TTS all genuinely fired for the first time - but the app never actually opened (voice pipeline wasn't wired to real app-control execution), TTS audio was never heard, the HUD window piled up across runs, and wake-word latency was bad enough to eat the start of one-breath commands. All four fixed 2026-08-31 (see the update above) — **not yet re-run live to confirm**. Full-duplex/interruption remains deliberately unbuilt. See Part 10 below and the ground-truth bullets above for details.  
**Core Principle:** One persistent intelligence with multiple interfaces, devices, memories, and capabilities

**Ground-truth status (verified by reading code — last updated 2026-08-26, after removing all Claude/Zo dependencies):**
- ✅ **Phase 0** — real. 5-agent orchestrator, memory, verification, audit trail. Originally proven end-to-end against live Postgres + Claude-via-Zo, before the standalone pivot; the code path that made that possible (`models/claude-provider.ts`, all `ZO_API_KEY`/`ClaudeProvider` wiring) has since been deleted outright. As of 2026-08-27 the system runs on OmniRoute → Ollama (Gemini/OpenRouter optional) — see the OmniRoute bullet below; this line is stale wherever it says "Gemini," corrected here. Needs one fresh live run on Gavin's PC (OmniRoute + `OMNIROUTE_API_KEY`, already in `.env`) to reconfirm the vertical slice end-to-end on the new provider order — not yet done, blocked on the PC being reachable, not on a key.
- ✅ **Phase 1.5 (Conversational Intelligence)** — real as of 2026-08-27, and now genuinely real rather than just "wired." Imported and called from `orchestrator.ts` (`processWithStreaming`, `completeTurn`, memory methods) as this line already said — but until today `streamFromModel()`/`streamFromBuffer()` in `conversation-intelligence.ts` returned 100% hardcoded mock text (e.g. `"I understand you'd like to ${utterance.substring(0,20)}..."`) and never called any LLM, despite being reachable and "wired." Fixed: `ConversationalIntelligence` now takes a real `ModelProvider` (`orchestrator.ts` passes `new GatewayModelProvider(createDefaultGateway())`, same gateway as everywhere else), and a new `callModel()` method sends the real prompt/utterance through it — the token-by-token "streaming" is still a simulated drip (setInterval over the real response text, not a true streaming API), but the content itself is now genuinely LLM-generated. Also added a `bun run dev conversation "<text>"` CLI command so this is actually reachable/testable from the command line, where before nothing in cli.ts exercised it. Code-verified, not yet run live against OmniRoute/Ollama on Gavin's PC.
- ✅ **Part 3 Foundational Subsystems** — real, built 2026-08-26. Presence & Device Awareness (`core/presence.ts`), Identity Recognition (`core/identity.ts`), Authorization Engine (`core/authorization.ts`, 4 levels), and Security Layer are wired into actual tool execution (`tools/manager.ts`, `phase3/screen-control.ts`) — not documentation, actually enforced: `bun run dev whoami` exercises the full chain. Computer Control (`phase3/windows-control.ts`) is real PowerShell/Win32 automation, but **unverified** — written and typechecked on a Linux sandbox that cannot run it; must be confirmed with `bun run dev control-test` on the actual Windows PC before it's trusted.
- ⚠️ **Gemini provider** — real (`models/gemini-provider.ts`), direct REST call to Google's API, zero Zo/Claude/Anthropic dependency anywhere in the codebase (confirmed by a full-source grep). No longer the "sole" provider as of 2026-08-27 (superseded by the OmniRoute bullet below) and no longer even configured — `.env` has no `GEMINI_API_KEY`, so this provider isn't registered in the current gateway at all. Code stays in place as an optional fallback if a key is ever added.
- ✅ **Phase 1 (JARVIS Developer)** — real as of 2026-08-27, correcting the stale ❌ this line carried until today. Read `developer.ts` directly (not the old status notes): its 7-agent pipeline (Architect, Planner, Coder, Debugger, Code Reviewer, Security Reviewer, Verifier) genuinely calls the LLM gateway at every step (`this.agents.architect.execute()` etc., same `BaseAgent` + `createDefaultGateway()` pattern as Phase 0), does mechanical (not LLM-guessed) build/test verification, runs a bounded auto-debug loop, and gates deployment behind a real, non-bypassable human-approval flag — see `git.ts`, `patch.ts`, `build-test.ts`. `bun run dev phase1` still only prints a static pipeline summary (`JARVISDeveloper.printWorkflow()`), but `bun run dev developer "<requirement>"` runs the real thing end to end, and `bun run dev phase1-selftest` runs the compounding self-test. Not yet run live against the actual OmniRoute/Ollama gateway on Gavin's PC to confirm the full loop end to end — code-verified, not run-verified.
- ⚠️ **[UPDATE 2026-08-30] Phase 2 (Voice) — mic capture, playback, and end-of-turn detection are now real; full-duplex/interruption still isn't.** The three concrete gaps this file used to list under Phase 2 status ("no microphone capture anywhere in this codebase," no audio playback, no VAD/end-of-turn detection so a real mic feed would never finish a turn) are closed: `scripts/mic_capture.py` (new, real `sounddevice` capture, continuous PCM16 stream) + `phase2/mic-capture.ts` (new, spawns it and re-chunks stdout) feed real microphone audio into the exact `processAudioChunk()` methods `wake-word-detector.ts`/`speech-recognizer.ts` already exposed but nothing ever called with real audio; `phase2/audio-player.ts` (new, PowerShell `Media.SoundPlayer`, matching `windows-control.ts`'s existing shell-out pattern) actually plays the synthesized reply instead of only writing a WAV nobody heard; `voice-interface.ts` gained a new public `processMicChunk()` that routes chunks to whichever stage is active and implements the master doc's own Part 5.3 silence-duration rule (3000ms of silence after detected speech ends the turn) using simple RMS energy, not a trained VAD model — `config.audio.vadEnabled` was previously an inert flag with nothing behind it. Reachable via a new `bun run dev listen` CLI command. Crucially, `VoiceInterface`'s existing `start()`/`handleWakeWord()`/`handleUserSpeech()` orchestration — the whole wake-word → recognize → respond → synthesize loop — was ALREADY real and correctly wired before this change; the only things missing were the mic feed, the playback, and the turn-ending signal, not a redesign. **Still NOT real, deliberately deferred, not silently skipped:** true full-duplex (`LISTEN ←→ THINK ←→ SPEAK`, Part 5.1) and barge-in interruption. `conversation-engine.ts`'s interruption state machine still isn't wired to real audio (`startSpeaking()`/`streamToken()` there are still honest scaffolding — see their own "Note: Real implementation would..." comments). The new `listen` command is intentionally sequential (LISTEN → THINK → SPEAK → WAIT, looping) with a half-duplex guard (`isSpeaking`) that drops mic input entirely during JARVIS's own playback so it can't hear itself and re-trigger — a real, honest interim substitute for acoustic echo cancellation, not a simulation of full duplex. Building real-time barge-in blind, with no way to test real audio/echo behavior from this Linux sandbox, would be irresponsible; that's real follow-up work once `listen` itself is confirmed working on Gavin's actual PC (**not yet run live — needs real-hardware verification, same as everything else Phase 2**). Also still true from before: `speech-recognizer.ts`'s "streaming" is a whole-buffer batch per turn, not true incremental transcription, and there's still no noise suppression despite `config.audio.noiseSuppressionEnabled` existing as a config field.
- ⚠️ **[UPDATE 2026-08-30, later same day] Real first live run of `listen` found wake-word sensitivity badly miscalibrated for Gavin's actual mic/room — fixed with real data, not yet re-verified live.** Gavin ran `bun run dev listen` for real (the first live run of anything in this Phase 2 update): the wake word never fired at normal talking volume. The new score-logging this update already added (see the bullet above) turned this from a guess into real data — 12 samples while he genuinely tried the wake word scored only 0.0000-0.0175, versus 0.25-0.99 measured on 2026-08-26 from synthesized clips and the 0.15 threshold that data set. A gap that large pointed at raw input level, not just the trigger point, so two changes went in together: `scripts/mic_capture.py` now applies a real linear gain multiplier (`audio.micGain` in voice-config.ts, default 4.0) to the captured signal before it reaches either the wake-word model or the RMS-based VAD — both consumers of the same raw stream benefit, not just one threshold — with hard-clipping to avoid distortion and a new throttled `[mic] peak level` stderr log (raw vs. post-gain, flags clipping) specifically so this can be measured and re-tuned from real numbers instead of guessed again; `wakeWord.sensitivity` also came down 0.15 → 0.05 as a safety margin on top of the gain fix, chosen to stay well above Gavin's observed real non-speech floor (0.0000-0.0034). Disclosed honestly: a threshold this far below the original synthesized-clip data is unusual, and this is a real hypothesis grounded in Gavin's own numbers, not a validated fix — **not yet re-run live**, so it's still unknown whether 4.0x gain is enough, too much (clipping), or whether the deeper issue is Windows-level mic input volume/boost rather than anything in this codebase. Also still unconfirmed as of this update: whether a full wake-word → STT → LLM → TTS-playback round trip has ever completed successfully even once on real hardware — both of Gavin's live attempts so far failed at or before the wake-word stage.
- ⚠️ **[UPDATE 2026-08-30, third pass same day] Wake word now fires reliably (91% confidence, live) — the gain fix worked — but the turn then never ended, so nothing was ever said back; root-caused and fixed with real log data, still not re-verified live.** Gavin re-ran `listen`: the wake word triggered correctly this time, but after that, silence — no transcription, no reply, no audio. The real console output (VAD energy logging from the previous update) showed exactly why: `silence: 0ms/3000ms` on every single line for over a minute straight. The 4x mic gain that fixed wake-word detection also pushed real ambient background energy up to 2600-4000, comfortably above the old fixed `SPEECH_RMS_THRESHOLD = 500` — so every chunk, speech or not, read as "still talking," the silence-cutoff could never fire, and the turn was silently stuck (would have eventually hit the 5-minute `maxTurnDuration` backstop and done nothing useful even then). The same log also showed repeated real clipping on louder speech ("CLIPPING - gain too high"), which distorts exactly the audio Whisper needs to transcribe well. Two fixes, both root-cause not band-aid: (1) `mic_capture.py` switched from a hard `np.clip` to `np.tanh` soft-knee saturation — behaves identically to the confirmed-working linear gain at normal/quiet volume, but saturates smoothly instead of flat-topping on loud peaks, so the gain didn't need lowering (which would have undone the wake-word fix), only the limiting behavior did; (2) `voice-interface.ts`'s fixed VAD threshold is gone entirely, replaced with `turnSpeechThreshold` computed fresh in `handleWakeWord()` from a real rolling window of ambient energy (`idleEnergyWindow`, ~5s of pre-wake-word idle audio) — "speech" is now defined as 2.5x the room's own just-measured quiet floor, not a static number that has no way to know what gain or room it's up against. This is the direct, disclosed lesson from the previous same-day fix: a fixed threshold cannot survive a gain change, so the fix this time is architectural (self-calibrating), not another guessed constant. **Not yet re-run live** — still unknown whether this actually lets a turn complete, and the full wake-word → STT → LLM → TTS-playback round trip remains unconfirmed on real hardware even once.
- ✅ **[UPDATE 2026-08-31] Real end-to-end round trip confirmed live for the first time — wake word, STT, and TTS all genuinely fired — but surfaced four more real bugs, all fixed same day.** Gavin re-ran `listen` twice: the VAD fix above worked (turns correctly ended on real silence both times, no more stuck-forever turns), Whisper transcribed real (if imperfect: "Drivers open Spotify", "Open no pad") text, and a real LLM reply was generated and synthesized. But: (1) **the app never actually opened** - `voice-interface.ts`'s `generateResponse()` had an explicit, previously-documented gap (see the 2026-08-27 app-control bullets below): it never routed through `Orchestrator.parseAppControlIntent()`/`executeAppControlIntent()` at all, so "open Spotify"/"open notepad" just got a conversational clarifying question back instead of the app opening - fixed by having `cli.ts`'s `listen`/`voice-reply` commands pass their already-constructed `Orchestrator` into `VoiceInterface`, which `generateResponse()` now delegates to when present (falls back to the old direct-model-call path otherwise, e.g. for tests). (2) **TTS said it synthesized audio but Gavin never heard it** - `playWavBuffer()`'s PlaySync() call completed with no error, so this isn't a crash; added a real peak-amplitude diagnostic on the synthesized WAV right before playback (parses the actual RIFF/data chunk, not a hardcoded offset) so the next run can tell a genuinely-silent-synthesis bug apart from a Windows default-playback-device/volume issue - not yet re-run live to see which it is. (3) **the HUD window piled up "like 7 opened"** over repeated test runs - `Start-Process` was fire-and-forget with no way to ever find that window again; fixed by capturing its real PID (`-PassThru`) and closing exactly that PID on shutdown, not a blanket `taskkill msedge` that would risk closing Gavin's regular browsing. (4) **measured, real latency root cause for "very delayed from the wakeword to the listening mode"**: the old design spawned a fresh Python subprocess per ~1s detection cycle - measured in this project's own venv at ~1.1-1.5s of pure import/model-load overhead PER CYCLE, on top of the ~1s buffering wait, meaning saying "jarvis, open notepad" as one breath lost the start of the command to that 2+ second gap (directly explains the garbled transcripts above). Fixed architecturally, not tuned: `scripts/wakeword_detect_daemon.py` (new) loads the model exactly ONCE and stays alive for the whole `listen` session, scoring real 80ms/1280-sample chunks streamed over stdin as they arrive - `wake-word-detector.ts` rewritten to spawn/reuse this persistent process instead of one-shot `wakeword_detect.py` (kept, unchanged interface, still used by the real openWakeWord test); validated end-to-end in a scratch venv before shipping (real model load ~1.1s once, then ~2ms/chunk streaming, confirmed via an actual stdin-feeding test, not just reasoning about it). Model-download self-heal logic (2026-08-30's fix) factored into a shared `scripts/_wakeword_model_setup.py` so both scripts stay correct together. **Not yet re-run live** - none of these four fixes has been confirmed against Gavin's actual hardware yet.
- ✅ **[UPDATE 2026-08-31, second pass] Re-run confirmed the four fixes above are real progress — latency fixed, app-control now genuinely fires — but surfaced three more real bugs in the same log.** (1) **Duplicate wake-word triggers**: streaming real 80ms-chunk scores (vs. the old one-max-score-per-1s-batch design) means a single spoken "jarvis" naturally spans several consecutive chunks, and the log showed 2-3 separate "Wake word detected" events fire back-to-back for what was clearly one utterance - each one re-running `handleWakeWord()` (double-starting speech recognition, resetting turn timers mid-stream), and the likely cause of a confusing `"timed out waiting for the daemon to score N chunks"` error later in the same run. Fixed with a one-shot latch (`triggered`) in `wake-word-detector.ts`: further scores are still logged, but only the first crossing per listening session actually fires - reset when `startListening()` begins the next one. Also had `handleWakeWord()` explicitly call `stopListening()`, which now resolves any leftover in-flight score-count waiter immediately instead of letting it hang until a 5s timeout mid-turn. (2) **App-control fired but the app still didn't open** - real progress from the previous fix (both "open notepad" and "open Spotify" correctly triggered `parseAppControlIntent`/`executeAppControlIntent` this time), but `windows-control.ts`'s `openApplication()` was still just `Start-Process "<name>"`, which only works for apps directly on PATH - confirmed live failing on a genuinely-installed, correctly-transcribed "Spotify" ("The system cannot find the file specified"). Fixed by searching the real Windows Start Menu app index (`Get-StartApps` - the same index Windows Search itself uses, covers Store/UWP apps with no PATH-visible executable) for a fuzzy match and launching via `shell:AppsFolder\<AppID>` through `explorer.exe`, falling back to the old plain `Start-Process` only when nothing matches (still covers bare system tools like notepad/calc/cmd). Disclosed limitation this does NOT fix: "notepad" was misheard by Whisper as "no pad" both times it was tried - a fuzzy Start Menu search can't recover from a wrong transcription, so that failure is real but a different, STT-accuracy problem, not this one. (3) **"It should be responding while thinking, instead of nothing"** (Gavin, verbatim) - a real LLM call plus full TTS synthesis measured ~2s+ of dead air with zero audible feedback, on a pipeline explicitly built sequential (LISTEN → THINK → SPEAK → WAIT, Part 10) rather than full-duplex. Added a short, fixed, synthesized-once-and-cached "Mm-hm, one moment." acknowledgment (`ensureFillerAudio()`) played immediately after speech recognition completes and before the slow real response - stays within the sequential design (one more real SPEAK step, not concurrent SPEAK+THINK), first turn pays a small extra synthesis cost, every turn after is cached. **Not yet re-run live** - none of these three fixes has been confirmed against Gavin's actual hardware yet, and the STT-accuracy limitation on "notepad" and the still-open TTS-playback-silence question from the previous update remain unresolved.
- ✅ **[UPDATE 2026-08-31, third pass] TTS backend swapped to Gavin's real Fish Audio "jarvis" voice, with automatic fallback to local Piper.** Per Gavin: "when the voice speaks i want to connect it to fish audio i have a jarvis voice thats perfect for it." Confirmed the real Fish Audio API (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech): `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer <key>`, JSON body (`text`, `reference_id`, `format`, `prosody.speed`), raw audio bytes back (not JSON) via chunked transfer. New `src/phase2/fish-audio-synthesizer.ts` implements the same `ISpeechSynthesizer` shape (`synthesize`/`setVoice`/`setSpeakingRate`/`getStatus`, factored out of `speech-synthesizer.ts` as a shared interface) as the existing Piper `SpeechSynthesizer`, so it is a real drop-in, not a parallel code path. New `src/phase2/tts-provider.ts`'s `createSpeechSynthesizer()` wraps Fish Audio with an automatic fallback to Piper on ANY failure (missing/bad key, network down, 401/402/503 from the API) - same $0-first/provider-agnostic resilience pattern already used for LLM providers, applied here so a Fish Audio hiccup degrades to a local voice instead of silence. `voice-config.ts`'s `textToSpeech` gained `provider: "fish-audio"` and `fishAudio.referenceId: "049975dde0a14889ad219f24a95e3a4f"` (Gavin's real voice model ID, given directly) as the new default; the existing `voiceId`/Piper path is kept as-is and now serves as the fallback voice, not deleted. `voice-interface.ts`'s `initializeComponents()` now calls `createSpeechSynthesizer(this.config)` instead of constructing `SpeechSynthesizer` directly. Auth: reads `FISH_AUDIO_API_KEY` from `.env` - Gavin added his real key there himself (his explicit choice, never asked for it in chat); also fixed a real formatting bug found in the process - his key had been added to `.env` as a freeform `fish audio api key: <value>` line with no newline before it (would not have parsed as an env var at all), reformatted to a proper `FISH_AUDIO_API_KEY=<value>` line. **Not yet run live** - this needs Gavin's real Fish Audio account/key/voice to confirm end-to-end; typechecks clean (`tsc --noEmit`) but the actual API call, the fallback path, and whether `computeWavPeakAmplitude`'s prior "peak amplitude: 1.0000 but Gavin didn't hear it" mystery resolves once Fish Audio replaces Piper are all unconfirmed.
- ✅ **[UPDATE 2026-08-31, fourth pass] Re-run surfaced two real findings: a genuine escaping bug in the Get-StartApps app-launch fix, and Fish Audio blocked on payment.** (1) **App launch STILL opened plain File Explorer instead of Spotify/Notepad**, even after the previous fix. Root-caused (not guessed) to a real bug in `windows-control.ts` itself: the PowerShell was built from a TS template literal containing `` \$($app.AppID) ``, but `\$` inside a JS/TS template literal is a recognized escape sequence that collapses to a literal `$` - it silently swallowed the backslash before the string ever reached PowerShell. Verified with an actual Node template-literal test: the code was really emitting `shell:AppsFolder$($app.AppID)` (missing separator) instead of `shell:AppsFolder\$($app.AppID)` - explorer.exe can't resolve the malformed URI and its real, documented fallback behavior is to just open a plain File Explorer window with no error, exactly matching what Gavin saw for both apps, and exactly why `Start-Process` still reported success. Fixed by escaping the backslash itself (`` \\$($app.AppID) `` in the TS source), verified with the same kind of real Node test that `shell:AppsFolder\$($app.AppID)` (correct) is what's actually emitted now. (2) **Fish Audio TTS (previous update) returned a real, confirmed 402 Payment Required** - "Insufficient API credit" - on both calls in the same run; the automatic Piper fallback (built for exactly this) worked correctly both times, so JARVIS still spoke via Piper rather than going silent. Per Gavin, rather than funding the Fish Audio account he's moving to Chatterbox (Resemble AI's open-source, $0, locally-run voice-cloning TTS model) instead - fits the project's $0-first philosophy better than a paid API. **Not yet built**: Chatterbox needs a local Python/PyTorch inference setup (same subprocess pattern as Piper/Whisper/openWakeWord, not a simple REST call like Fish Audio was) plus a real reference audio clip of the voice to clone - waiting on Gavin to confirm the plan and provide that clip before wiring it in; `tts-provider.ts`'s fallback-wrapper design from the previous update means swapping the primary provider out for Chatterbox later doesn't require re-architecting, just a new synthesizer class dropped in alongside fish-audio-synthesizer.ts. **Also unresolved, disclosed again**: Piper's audio genuinely played (no thrown error from `PlaySync()`, peak amplitude 1.0000 logged, same as previous update) but Gavin still reports hearing nothing - with a real, non-silent buffer confirmed and no code-level exception, the most likely real cause left is a Windows-side output routing/volume issue rather than a code bug - specifically worth Gavin checking Windows' per-app "Volume Mixer" / "App volume and device preferences" for whichever process actually plays the sound (the PowerShell/dotnet host, since `SoundPlayer.PlaySync()` runs inside the spawned `powershell.exe`) being independently muted or set to 0%, which produces exactly this symptom - audio genuinely "plays" with no error, silently, because Windows itself is muting that one process.
- ✅ **[UPDATE 2026-08-31, fifth pass] Isolated the total-silence bug to `System.Media.SoundPlayer` itself - swapped playback to Windows Media Player COM.** Gavin ran the exact `PlaySync()` call manually against a stock Windows system sound (`notify.wav`), completely outside JARVIS's own code - no sound at all, while confirming his speakers work fine for everything else. That isolates the problem precisely: not JARVIS's generated audio (already confirmed non-silent, peak amplitude 1.0000), not general Windows muting/volume, not the mic/speaker hardware - specifically `SoundPlayer`'s legacy MME/waveOut playback path, which has a known real quirk of targeting a different "default device" than the one every normal app (and the rest of Windows) uses, especially on a machine with more than one playback device. `audio-player.ts`'s `playWavBuffer()` now plays through the Windows Media Player ActiveX/COM object (`WMPlayer.OCX`) instead - it uses the modern media pipeline and follows the real current default output device - polling `playState` (3=Playing, 6=Buffering, 7=Waiting, 9=Transitioning, 10=Ready all mean "not done yet") to preserve the same "block until playback genuinely finishes" contract the old `PlaySync()` gave the rest of the pipeline. Falls back to the original `SoundPlayer` approach only if `WMPlayer.OCX` can't be constructed at all (e.g. a Windows edition missing the media feature pack), so this can't make things worse than before. **Not yet run live** - this is a real, well-motivated fix for a real, precisely-isolated symptom, but has not been confirmed to actually produce audible sound on Gavin's machine yet; if it doesn't, the next real diagnostic step is checking whether the legacy Sound Control Panel (`mmsys.cpl` - separate from the modern Settings app) shows a different default playback device selected than what Gavin actually listens on.
- ✅ **[UPDATE 2026-08-31, sixth pass] The WMP-COM playback fix (previous update) confirmed live to be WORSE - it hung until killed, not just silent.** Gavin's log: `"Filler playback failed (non-fatal): PowerShell exited null:"` - a real, confirmed timeout/kill (fixed `runPowerShell` in the same pass to report the signal instead of a bare `null`, so a hang reads differently from a real PowerShell error going forward), and the main response's playback never even got to log success or failure before Gavin had to Ctrl+C the whole session. Real, disclosed reasoning: `WMPlayer.OCX` is a *windowed* ActiveX control built to be hosted inside a real UI window with a Windows message loop pumping it - a bare `powershell.exe -Command` console process has neither, and a first-ever COM use of it can also silently pop a hidden modal "first run" dialog nobody can see or dismiss. Replaced with `System.Windows.Media.MediaPlayer` (WPF/PresentationCore) - same modern Media Foundation pipeline (should still follow the real default output device, unlike SoundPlayer), but NOT a windowed ActiveX control, so no message-pump/hidden-dialog requirement. Its `Open()`/`Play()` are async with no built-in blocking call, so rather than depend on events that may never fire without a pumped Dispatcher, `audio-player.ts` now computes the real WAV duration from the buffer itself (+600ms safety margin) and blocks with `Start-Sleep` for that long - the standard, commonly-used way to script WPF MediaPlayer from a plain console host. Falls back to the legacy `SoundPlayer` only if `PresentationCore` itself can't load. **Not yet confirmed live.**
- ✅ **[UPDATE 2026-08-31, seventh pass] Built the full Chatterbox local voice-cloning TTS integration - not yet activated, waiting on Gavin's reference clip.** Per Gavin, moving off Fish Audio (real, confirmed 402 Payment Required on every call) to Resemble AI's open-source Chatterbox model (https://github.com/resemble-ai/chatterbox) instead, to stay $0. Verified the real API before writing any code (pip package, `ChatterboxTurboTTS.from_pretrained(device=...)`, `model.generate(text, audio_prompt_path=...)`, `model.sr`, torch 2.6.0 pinned dependency, Python >=3.10, real per-CUDA-version pip install URLs for torch 2.6.0 from pytorch.org) rather than guessing. New `scripts/chatterbox_synthesize_daemon.py` - a persistent daemon loading the model exactly once (same reasoning as the wake-word daemon: a fresh subprocess per response would repeat a real bug already fixed once this session), serving text->WAV requests over stdin/stdout as newline-delimited JSON. New `src/phase2/chatterbox-synthesizer.ts` implements `ISpeechSynthesizer` (which gained an optional `shutdown()` for real persistent-process teardown, called from `VoiceInterface.stop()` alongside the wake-word daemon's own shutdown - a no-op for Piper/Fish Audio, which don't hold a persistent process). Uses the Turbo model variant (350M, English) over the base model for lower per-response latency, a disclosed, not-yet-A/B-tested choice - easy to switch back if voice-clone quality isn't good enough once Gavin has a clip to test with. `tts-provider.ts`'s `createSpeechSynthesizer()` now handles `provider: "chatterbox"`, falling back to Piper (with a clear console warning) if no reference clip is configured - which is the current real state: `voice-config.ts`'s default `provider` is temporarily back to plain `"piper"` (not `"chatterbox"`) since there's no reason to keep the confirmed-402 Fish Audio path in the hot path either. New `scripts/setup-chatterbox.ps1` (+ a Linux `.sh` counterpart for parity) installs a dedicated CUDA-enabled PyTorch + chatterbox-tts venv, separate from `tools/whisper/venv` since Chatterbox's dependency stack (torch, transformers, diffusers, gradio) is heavy/version-pinned enough to risk conflicts if shared. Gavin confirmed an NVIDIA GPU (so cu124 CUDA wheels by default) but had not yet picked/recorded a real ~10s reference clip of the voice to clone. **Not yet run at all** - needs Gavin to (1) run `setup-chatterbox.ps1`, (2) get a real reference clip, (3) set `CHATTERBOX_VOICE_CLIP_PATH` in `.env` and flip `provider` to `"chatterbox"` in `voice-config.ts`, before any of this actually engages instead of the fallback path.
- ⚠️ **[SUPERSEDED BY THE UPDATE ABOVE, kept for history] Phase 2 (Voice) — TTS/STT/wake word real, mic capture still not.** As of 2026-08-26: `speech-synthesizer.ts` runs the real Piper binary (local, $0, no API key), `speech-recognizer.ts` runs real `faster-whisper` via `scripts/whisper_transcribe.py`, and `wake-word-detector.ts` runs the real pretrained openWakeWord `hey_jarvis` model via `scripts/wakeword_detect.py`, tuned (sensitivity 0.15, per Gavin's request) to fire on bare "Jarvis" anywhere in speech, not just the literal "hey Jarvis" phrase the model was trained on — all proven live: a full TTS→STT round trip correctly transcribed "the quick brown fox..." back from synthesized audio, and the wake word model scored ~0.999 on "hey jarvis...", 0.25-0.99 on bare "jarvis" depending on sentence position/cadence, and ~0.0001-0.0003 on unrelated speech (`bun test src/tests/speech-synthesizer.test.ts src/tests/speech-recognizer.test.ts src/tests/wake-word-detector.test.ts`). Known limitation: one measured mid-sentence case with no pause after "jarvis" scored only 0.003 and would still be missed — closing that gap fully would need a dedicated custom-trained "jarvis" model, not just this threshold tune. Run `scripts/setup-voice.sh` first (downloads Piper + builds the whisper/openWakeWord venv; gitignored, not committed). `voice-interface.ts`'s `generateResponse()` — previously a hardcoded "I received your command..." stub, meaning "natural conversation" was 0% real even with TTS/STT/wake-word all wired — now calls the real Gemini→Ollama→OpenRouter gateway; verified live that two different questions get two different real answers (`src/tests/voice-interface.test.ts`). A new `bun run dev voice-reply "<text>"` CLI command reaches it (text-in/audio-out, no mic yet — the first command that reaches any of Phase 2). Also found+fixed a real bug along the way: `speech-synthesizer.ts` silently ignored `voiceId` and always used `en_US-amy-medium` regardless of config; it now actually selects the model. Streaming in all classes is honestly labeled non-incremental (whole ~1s buffer, not true low-latency streaming) — fine for proving the models work, but a persistent-subprocess rework is the next step once real-time mic latency matters. Still NOT real: interruption (state machine exists in `conversation-engine.ts` but isn't wired to `voice-interface.ts` or real audio), full-duplex audio, and — the actual hardware blocker underneath all three — there is no microphone capture anywhere in this codebase, which needs real hardware I/O and has to happen on Gavin's PC, not this Linux sandbox.
- ✅ **Phase 3 (Vision/Screen)** — screen control is real (PowerShell automation, PC-unverified — see Part 3 bullet above). Vision is now fully wired as of 2026-08-27, not just capable: `phase3/ollama-vision-provider.ts` is a real, working `VisionProvider` (moondream via local Ollama, $0, verified live 2026-08-26 against a real generated test image), but `VisionSystem` — the class meant to use it — was never instantiated anywhere in `src/`, so nothing could reach it, and its unconnected-provider fallback silently returned fabricated, always-identical "office desk" data instead of failing. Both gaps closed 2026-08-27: `VisionSystem`'s fallback methods now throw a clear error instead of fabricating data, and a new `bun run dev vision-test <path-to-image>` CLI command instantiates `VisionSystem`, calls `setProvider(new OllamaVisionProvider())`, and runs a real `analyzeImage()` + `detectObjects()` against whatever image path you give it. `GeminiVisionProvider` still throws "not yet implemented" on every method — untouched, still a stub. Code-verified, not yet run live — needs Ollama running on Gavin's PC with `moondream` pulled (`ollama pull moondream`) and a real image to point it at.
- ⚠️ **[UPDATE 2026-08-30] Phase 5 (Visual HUD) — first real piece exists now, not a native overlay yet.** Per Gavin, sharing a reference image and asking for "the icon but animated with spins and moving parts" to show JARVIS's state. Built as a real, self-contained animated SVG/CSS page (`public/hud.html` - concentric rings, tick-mark dial, rotating sweep arcs, center wordmark, all real CSS/SVG animation, no video/GIF) served by a tiny local HTTP server (`src/phase2/hud-server.ts`, Bun's built-in `Bun.serve`, no new dependency) and opened as a borderless Edge "app mode" window from the new `bun run dev listen` command. State (idle/listening/thinking/speaking) is driven by voice-interface.ts's real event emitters, not a simulated timer - the HUD genuinely reflects the pipeline's real state. Still NOT built: this is a normal (if borderless) window, not a true always-on-top desktop overlay with click-through and no taskbar entry - a native approach (WPF/WinUI, or a browser window with more aggressive always-on-top flags) would be needed for that; there's still no `desktop/` folder or persistent tray-icon presence; and closing the HUD window is manual (`listen` doesn't auto-close it on exit) since programmatically killing "msedge" processes risks closing Gavin's regular browsing, not just the HUD. Not yet run live - needs a real Windows desktop with Edge, same as everything else in this list.
- ✅ **Standalone / provider-agnostic / $0-first** — true now, not aspirational. Every Claude/Zo/Anthropic reference (`claude-provider.ts`, `ZO_API_KEY`, `ClaudeVisionProvider`, hardcoded `"claude"` entries in `model-router.ts`) has been removed from the codebase. Real cloud (OmniRoute, Gemini — both optional by key), real local (Ollama, no API key at all, always registered), and OpenRouter (optional) all exist, unified behind `LLMGateway` (`src/models/llm-gateway.ts`). As of 2026-08-27 the gateway tries OmniRoute first, not Gemini — see the OmniRoute bullet below, which supersedes the "tries Gemini first" claim this line originally made. None of this touches Zo in any form. Verified 2026-08-26 with `llm-gateway.test.ts` (fake-provider fallback/health/cooldown logic, provider-agnostic — unaffected by the 2026-08-27 reordering) and a live `bun run dev test` run that reached the gateway and failed with the correct "no provider configured" message when no key/Ollama was present in the CI sandbox — the wiring itself is proven, the LLM calls' actual content still needs a live run on Gavin's PC to exercise end-to-end.
- ✅ **OmniRoute as primary provider (2026-08-27)** — per Gavin's request to stop depending on any single provider's daily quota. New `models/omniroute-provider.ts` (identical wire format to `openrouter-provider.ts` — OpenAI-compatible chat/completions) talks to a self-hosted OmniRoute gateway (https://github.com/diegosouzapw/OmniRoute, MIT, runs locally via `npm install -g omniroute` on Gavin's PC) which itself aggregates 300+ upstream providers, 90+ free, with its own quota-aware auto-fallback — so a single upstream running dry is now absorbed by OmniRoute before it ever reaches JARVIS as an error. `createDefaultGateway()` order is now: OmniRoute (if `OMNIROUTE_API_KEY` set) → Ollama (local, zero-cost floor, always registered) → Gemini (now optional, only if `GEMINI_API_KEY` set) → OpenRouter (optional). Typecheck clean, `llm-gateway.test.ts` (fake-provider logic, unaffected by the reordering) still 7/7 pass. Not yet verified live against a real running OmniRoute instance — that needs Gavin's PC, where OmniRoute actually runs.
- ✅ **All 18 agent roles now registered (2026-08-27)** — fixes a real "Agent not found" crash risk, not just a doc gap. `agents/types.ts`'s 6 core roles (Researcher, Reasoner, Critic, Fact Checker, Verifier, Synthesizer) were always defined, but `cli.ts` only ever registered 5 of them (dropping Verifier), and the 13 roles in `agents/specialized-agents.ts`'s `SPECIALIZED_AGENT_ROLES` (Architect, Coder, Tester, Debugger, Code Reviewer, Security Reviewer, Performance Analyzer, Analyzer, Explainer, Simplifier, Planner, Error Analyzer, Verifier) were imported but never registered at all — even though `TaskDecomposer.getAgentPipeline()` routes 8 of its 9 task types (everything except plain "research"/"reasoning") to a mix of these names. Any task classified as code_write, code_debug, code_review, explanation, planning, analysis, or verification would have thrown `"Agent not found: <name>"` the moment `Orchestrator.orchestrate()` tried to run it — the original vertical-slice test never hit this because it happened to classify as the one pipeline (`researcher, reasoner, critic, fact-checker, synthesizer`) that was fully registered. Fixed: `cli.ts` now registers all 18 roles (`[...coreAgents, ...Object.values(SPECIALIZED_AGENT_ROLES)]`) at startup. Code-verified, not yet run live.
- ✅ **Gateway fallback + routing fixes (2026-08-27, per Gavin's "OmniRoute Routing Directive")** — architecture stays exactly as specified (OmniRoute primary → Ollama floor → Gemini/OpenRouter optional, capability-aware where practical, never chase individual providers); three real bugs found while verifying that against the directive, all fixed: (1) `LLMGateway.generate()`/`stream()` previously tried only one fallback hop (preferred provider, then exactly one alternate) before throwing — with all 4 providers configured, an OmniRoute *and* Ollama outage would fail even with Gemini/OpenRouter still reachable; now cascades through every registered provider before giving up, so a provider-specific error only ever reaches the user once literally all of them have failed, per the directive's explicit requirement. (2) `ConversationalIntelligence.callModel()` received `IntelligentModelRouter`'s tier selection (fast/main/deep/deterministic/creative, each with its own temperature/token profile) but silently discarded it, using one hardcoded config for every request regardless of intent — the opposite of "capability-aware." Now actually uses it. (3) `callModel()` had no error handling at all — once the gateway exhausted every provider, the raw error propagated uncaught up through `cli.ts`'s `conversation` command with no catch anywhere in between, meaning a total-outage would show a raw stack trace instead of JARVIS staying conversational; now caught and turned into the same clean fallback line `voice-interface.ts` already used correctly. New `verify-jarvis.ps1` (repo root) runs the directive's 11-step verification checklist end to end and categorizes every failure (configuration/provider-availability/latency/authentication/application-code/windows-integration/hardware), including a dedicated app-control round-trip test (see next bullet) — ready to run the moment Gavin's home; not yet run live (bridge to the PC is down this session).
- ✅ **Proactive app-control in conversation (2026-08-27)** — closes the exact gap the directive's own "Jarvis, open Spotify" example flagged: previously `isTaskRequest()` detected action-shaped utterances but only logged the detection, so a real "open Spotify" request got a plausible-sounding conversational reply with zero action behind it (documented, not fixed, in the first pass at this directive). Fixed now, per Gavin: *"when something like that is asked it completes the task and stay[s] conversational... it needs to be proactive not reactive."* `Orchestrator.parseAppControlIntent()` detects "open/launch/start/close/quit/exit <app>" anchored to the start of the utterance (verified against 15 real/edge-case inputs with a standalone regex test, not just reasoning about it — false positives like "start my day off right" fail safely, since a bogus app name just fails to launch cleanly, not dangerously). `executeAppControlIntent()` then actually runs it through the same authorized `ScreenControl`/`windowsController` path `control-test` already exercises (real `Start-Process`/`Stop-Process` via PowerShell, gated by `authorizationEngine`) — **before** the LLM generates any reply. The real outcome (success or a genuine failure reason) is passed into `ConversationalIntelligence` as a new `ActionOutcome`, which instructs the model to confirm what already happened in past tense and — this is the "proactive, not reactive" part — ask a natural follow-up when one exists for that kind of app ("Opening Spotify — what would you like to listen to?"), or to be honest about it when the action failed, never claim success it didn't verify. `bun run dev conversation "open Spotify"` exercises this directly; `verify-jarvis.ps1` step 6b does a full open-then-close Notepad round trip and checks the real OS process list (not just JARVIS's own claim) to confirm the action genuinely happened. Deliberately scoped to open/close only, not arbitrary multi-step commands ("open Spotify and play jazz") — that's real future work, not built here. Also deliberately NOT wired into `voice-interface.ts`'s separate, identity-less `generateResponse()` path (see comment there) — only the orchestrator's `processConversation()` path (`bun run dev conversation`) has it for now. Code-verified (regex logic actually executed and tested, TypeScript syntax-checked with `tsc`/`bun build`), not yet run live against real Windows automation.
- ✅ **Natural-language app-control, not keyword-matched (2026-08-27, same day)** — per Gavin: *"that narrow scope makes it difficult to talk naturally... I don't want it to be like current home systems where it's very blocky and certain words MUST be said like with Alexa or Google Home."* The regex from the bullet above only ever caught explicit phrasing ("open Spotify") anchored to the start of the utterance — genuinely Alexa-shaped. Fixed with a two-tier design in `Orchestrator.processConversation()`: tier 1 is still that same free, instant regex (kept because it's zero-cost and 100% reliable for the obvious case); tier 2, `classifyAppControlIntent()`, only runs when tier 1 finds nothing, and uses the LLM itself — not a bigger keyword list — to understand indirect/colloquial phrasing: "yo pull up chrome real quick," "I wanna listen to some music, get Spotify going," "kill that notepad window" all now resolve to the same real open/close execution as the explicit phrasing. The classifier prompt is deliberately conservative (verified against constructed examples, not live) — it's told to fire only when a specific named app is actually being requested, not merely mentioned ("I'm working in Photoshop right now" should not trigger it), and any classification failure (bad JSON, provider error) fails safe to "no intent detected," same as a genuine miss, never a crash or a wrong action. Real, disclosed tradeoff: unlike the free regex tier, this adds one extra LLM round-trip to every conversational turn that doesn't match the explicit phrasing — worth confirming the latency feels acceptable once run live; the fix if not is tunable (e.g. gating tier 2 behind a cheap pre-filter, or a config toggle), not a redesign. Uses `response_format: json_object` where the provider honors it (OmniRoute/OpenRouter get real JSON-mode enforcement; Ollama/Gemini ignore that option and rely on the prompt itself, same as their existing `{content, confidence}` structured-output pattern elsewhere in this codebase) — output is defensively parsed (`extractJsonObject()` strips markdown fences/stray text a smaller model might add) rather than trusted raw. Code-verified: the JSON-extraction logic was actually run against six realistic model-output shapes (clean JSON, fenced, fenced-with-preamble, inline-with-surrounding-text, non-JSON, empty) in a standalone test, all six correct; TypeScript syntax-checked with `tsc`/`bun build`, no errors introduced. Not yet run against a live model, so the classifier's real-world accuracy (not just its output-parsing) is unconfirmed until Gavin's PC.

---

## Core Philosophy

JARVIS is **not** tied to one LLM, one device, or one interface.

JARVIS is a persistent personal intelligence whose underlying components can evolve while its identity, memory, conversation, and permissions remain stable.

**The architecture flows:**
```
JARVIS Intelligence
    ↓
Conversation / Memory / Planning / Autonomy
    ↓
Tools / Devices / Services
    ↓
PC / Phone / Wearables / Future Interfaces
```

The LLM is one component. The system is much larger.

---

## Part 1: Foundation & Non-Negotiable Principles

### 1.1 Local-First

JARVIS runs on Gavin's Windows PC as a local application.

It is not a web app. It is not hosted externally. It belongs to the hardware.

### 1.2 Zero-Cost

JARVIS must work without:
- Paid APIs
- Subscription services
- Paid cloud hosting
- Required third-party services

Every capability must have a free or local path.

### 1.3 Provider-Agnostic

No LLM becomes "JARVIS."

Gemini, Ollama/local models, or future models are **providers** that JARVIS can use through a standardized interface — never Claude or Zo, which this project is intentionally standalone from.

Changing providers must not change JARVIS's behavior, memory, or identity.

### 1.4 Verification-First

Important outputs should be challenged, tested, and verified by independent agents.

JARVIS does not blindly trust itself.

### 1.5 Human-Controlled Autonomy

JARVIS may eventually improve itself, but only through controlled processes with:
- Sandboxing
- Testing
- Verification
- Approval
- Auditability
- Rollback capability

### 1.6 Build the Brain Before the Body

Core reasoning, memory, verification, and tool systems come first.

Voice, phones, AR/VR, and hardware are downstream interfaces.

---

## Part 2: Core Architectural Principles

### 2.1 One Intelligence, Multiple Interfaces

```
                    JARVIS CORE
                       │
        ┌──────────────┼──────────────┐
        │              │              │
    CONVERSATION    INTELLIGENCE    AUTONOMY
    ENGINE          ENGINE           ENGINE
        │              │              │
    MEMORY          PLANNING       RECOVERY
        │              │              │
        └──────────────┼──────────────┘
                       │
                  TOOL SYSTEM
                       │
        ┌──────────────┼──────────────┐
        │              │              │
    COMPUTER       INTERNET       DEVICES
    CONTROL        APIS           HARDWARE
        │              │              │
        ├──────────────┼──────────────┤
        │
    ENVIRONMENT LAYER
    (Presence, Device Awareness, Identity, Authorization, Security)
        │
    INTERFACES
    ┌──────────┬────────────┬─────────────┐
    │          │            │             │
   PC         Phone      Wearables    Future
   │          │            │
   └──────────┼────────────┘
              │
         Shared State
    (Memory, Conversation, Identity)
```

**Critical:** The same JARVIS runs the PC interface, phone interface, and wearable interface.

Conversation started on PC should continue on phone without losing context.

Identity is unified. Memory is shared. Permissions are portable.

### 2.2 JARVIS Identity ≠ Authorization

Recognizing someone as Gavin does NOT automatically grant administrative access.

These are separate systems:

```
Person Detected
    ↓
Identity Engine
    ↓
Identity Confidence
    ↓
Authorization Engine
    ↓
Permission Check
    ↓
Risk Assessment
    ↓
Additional Verification if Needed
    ↓
Tool Execution
    ↓
Audit Log
```

### 2.3 LLM Decision ≠ Permission

The LLM may determine: "The user wants to install software."

The authorization system decides: "Is this person allowed?"

The tool layer decides: "Can this tool execute that action?"

This separation must be enforced architecturally.

### 2.4 JARVIS ≠ One Device

JARVIS is a distributed system where:

- **PC** is the primary computational host
- **Phone** is a mobile interface + sensor platform
- **Wearables** are health sensors
- **Future devices** are additional interfaces

All share the same identity, memory, and conversation state.

---

## Part 3: Foundational Subsystems (Must exist BEFORE Phase 0)

### 3.1 Presence & Device Awareness

JARVIS must know:

**User Presence:**
- Is Gavin at PC?
- Is Gavin on phone?
- Is Gavin away?
- Where is Gavin?

**Device Awareness:**
- Which devices are available?
- Which devices can JARVIS reach?
- What are their capabilities?
- What communication channels exist?

**Active Interface:**
- Which device is currently primary?
- Can Gavin hear/see notifications?
- Which device should receive alerts?

**Communication Routing:**
```
Gavin at PC
    ↓
PC voice + screen available
    ↓
Route all communication to PC

Gavin on phone
    ↓
Phone voice available
    ↓
Route phone-appropriate communication to phone

Gavin away (phone in pocket)
    ↓
Only critical notifications
    ↓
Route to phone notification
```

**Implementation:**
- Device heartbeats (PC sends presence signal)
- Phone location (optional: GPS integration)
- Screen state (PC screen on/locked)
- Activity detection (PC active use)
- Explicit commands ("I'm going out")

### 3.2 Identity Recognition System

JARVIS must identify who is interacting with it.

**Identity Signals:**
- Face recognition (camera)
- Voice recognition (microphone)
- Device identity (logged-in account)
- Behavioral patterns (usage style)
- Session context (login state)

**Confidence Levels:**
```
Unknown Person
    ↓
Identity Engine Analyzes
    ↓
Confidence: 30% → Unknown
Confidence: 70% → Recognized Person (Not Gavin)
Confidence: 95% → Gavin Recognized
```

**CRITICAL:** Confidence score ≠ Permission level.

A 95% identity confidence does NOT automatically grant Level 3 (Verified) authorization.

### 3.3 Authorization Engine

JARVIS has four authorization levels:

**Level 0: Unknown**
- Can: Handle harmless conversation, answer public questions
- Cannot: Access personal data, files, accounts, system settings

**Level 1: Recognized Person**
- Can: Some low-risk personal features (if permission granted)
- Cannot: Access sensitive data without permission

**Level 2: Gavin (Normal Access)**
- Can: Personal assistant tasks (calendar, email, files, projects)
- Cannot: High-risk/admin actions

**Level 3: Verified Gavin (Admin)**
- Can: Anything (software installation, settings, credentials, security changes)
- Requires: Additional verification (PIN, face + voice, device confirmation, explicit approval)

**Permission Check Flow:**
```
Person + Identity Confidence
    ↓
Authorization Engine
    ↓
Base Level (0/1/2/3)
    ↓
Specific Tool Permissions
    ↓
Risk Assessment
    ↓
Action Type (Normal/Admin/Destructive)
    ↓
Is verification needed?
    ├─ NO → Execute
    └─ YES → Request additional auth
```

**High-Risk Actions Requiring Level 3:**
- Installing software
- Changing system permissions
- Accessing credentials
- Modifying security settings
- Large-scale data deletion
- Modifying JARVIS core
- Granting new permissions

### 3.4 Computer Control Abstraction Layer

JARVIS accesses the computer through a controlled tool interface, not direct OS access.

**Application Control**
- Open application by name
- Close application
- Focus window
- Minimize/maximize/restore

**Input Control**
- Type text
- Press keys
- Click mouse
- Scroll
- Drag

**File Operations**
- List directory
- Read file
- Write file
- Delete file
- Move file
- Create directory

**Clipboard**
- Get clipboard
- Set clipboard

**Screenshot**
- Capture screen
- Capture region
- OCR text from screen

**Terminal**
- Execute command (with permission check)
- Get output
- Handle errors

**Window Management**
- List open windows
- Get active window
- Switch window

**System Settings**
- Get settings (always allowed)
- Change settings (requires permission)

All actions pass through authorization before execution.

### 3.5 Security Layer

Core invariants:

1. **LLM output is not automatic permission**
2. **Identity confidence is not authorization level**
3. **Tool availability ≠ Permission to use**
4. **High-risk actions require explicit verification**
5. **All actions are auditable**
6. **Uncontrolled self-modification is prevented**
7. **Permissions are granular, not monolithic**

---

## Part 4: Conversational Intelligence (Phase 1.5)

The most important architectural layer.

JARVIS must feel like a persistent conversational assistant, not a sequence of independent LLM calls.

### 4.1 Conversation State Machine

Explicit, observable conversation state:

```
IDLE
    ↓
User wakes word
    ↓
LISTENING
    ↓
Speech received
    ↓
THINKING
    ↓
Response determined
    ↓
SPEAKING
    ↓
User interrupts (or response ends)
    ↓
INTERRUPTED or IDLE
```

**States:**

- **IDLE:** Not currently conversing
- **LISTENING:** Actively recording speech
- **THINKING:** Processing input, determining response
- **SPEAKING:** Speaking response via TTS
- **INTERRUPTED:** User interrupted, stopping current response
- **EXECUTING:** Running tool/command
- **WAITING_FOR_USER:** Awaiting response (e.g., yes/no)
- **ERROR:** Recoverable error occurred

**State is observable:** Tools can check current state, adjust behavior accordingly.

### 4.2 Working Conversation Memory

Short-term memory for current conversation:

```
Recent Turns (last 10)
├── User utterance
├── Detected intention
├── JARVIS response
├── Actions taken
└── Timestamp

Current Topic
Current Task
Current Subtask

Relevant Entities
├── People mentioned
├── Dates mentioned
├── Locations
└── Projects

Pronoun Referents
├── "that" → (most recent object)
├── "it" → (most recent subject)
├── "he/she" → (most recent person)

Pending Actions
├── Action 1
├── Action 2
└── ...

Recent Decisions
└── (for context)
```

**Lifetime:** Duration of conversation session

**Purpose:** Enable natural follow-ups like:
```
User: "What time is my meeting?"
JARVIS: "2 PM tomorrow."
User: "Move that to Thursday."
← JARVIS knows "that" = the meeting
```

### 4.3 Four-Level Memory Architecture

**Working Memory**
- What is happening right now?
- Current turn, recent context, immediate references
- Expires at end of conversation

**Episodic Memory**
- What happened previously?
- Conversations, events, interactions, past decisions
- Can be queried: "What did we talk about last week?"
- Persists indefinitely (can be pruned)

**Semantic Memory**
- What does JARVIS know about Gavin and his world?
- Preferences, people, projects, locations, facts
- Persists indefinitely
- Used for context

**Procedural Memory**
- How does JARVIS normally do things?
- Workflows, routines, automation patterns
- "When Gavin arrives at office: check calendar, review email"
- Persists indefinitely

**Memory Operations:**
- Retrieve (query by keyword/context)
- Rank (relevance to current task)
- Create (store new memory)
- Update (correct existing memory)
- Consolidate (merge similar memories)
- Expire (remove outdated temporary data)
- Delete (user-requested removal)

### 4.4 Context Assembly

Every reasoning request dynamically assembles context from:

```
Current Utterance
    ↓ (combine with)
Recent Conversation (last 2-3 turns)
    ↓ (add)
Current Task / Topic
    ↓ (add)
Working Memory (entities, decisions)
    ↓ (add)
Relevant Long-Term Memory
    ↓ (add)
Environmental Context (time, location, device)
    ↓ (add)
Tool State (calendar, files, etc.)
    ↓ (add)
Device State (battery, connectivity)
    ↓ (add)
Personality Rules
    ↓
Final Context Assembly
```

**Principle:** Only include relevant information. Do NOT send entire conversation history.

### 4.5 Personality Layer

JARVIS's personality is independent from the underlying LLM.

**Personality Rules:**
- Tone: Professional but warm, helpful, natural
- Formality: Casual (use contractions), not stiff
- Conciseness: Moderate detail, ask if more is needed
- Humor: Appropriate, not forced
- Proactivity: Balanced (suggest, don't override)
- Addressing user: By name, respectful, familiar
- Challenging user: Gentle, evidence-based
- Silence: Only when appropriate (no "umms" or filler)
- Uncertainty: Express clearly without undermining confidence
- Mistakes: Acknowledge, explain, recover

**Applied to every response, regardless of LLM.**

Changing providers does NOT change personality.

### 4.6 Streaming Architecture

Responses stream token-by-token to minimize perceived latency.

```
LLM generates tokens
    ↓
Tokens arrive in stream
    ↓
Response chunked at sentence boundaries
    ↓
Chunks sent to TTS immediately
    ↓
TTS speaks chunk while LLM generates next chunk
    ↓
User hears response while model still thinking
```

**Result:** Perceived latency under 500ms even with full reasoning time.

### 4.7 Interruption Handling

User can interrupt JARVIS mid-sentence.

```
JARVIS: "The weather tomorrow is—"
User: "Actually, what about Friday?"
    ↓
JARVIS detects new speech
    ↓
Cancel current TTS
    ↓
Discard current reasoning
    ↓
Process new utterance
    ↓
Respond to new request

"Friday will be sunny, 72 degrees."
```

No awkwardness. No delay. Natural conversation.

### 4.8 Intelligent Model Routing

Different types of requests use different models.

**Fast Path** (Haiku/small model)
- Greetings ("Hi JARVIS")
- Simple questions ("What time is it?")
- Basic commands ("Turn off lights")
- Acknowledgments ("Got it")
- Short conversational responses

**Main Path** (Opus/medium model)
- Normal conversation
- Moderate reasoning
- Multi-step tasks
- Decision making

**Deep Path** (Opus + extended thinking)
- Complex planning
- Research
- Coding tasks
- Difficult reasoning
- Important decisions

**Deterministic Path** (Small model, temp=0)
- Calendar operations
- File operations
- System commands
- Structured data retrieval

**Selection:** Based on utterance intent, reasoning complexity, user preferences, budget constraints.

---

## Part 5: Voice Interaction Architecture

### 5.1 Full-Duplex Conversation

JARVIS must support simultaneous listening and speaking.

```
LISTEN ←→ THINK ←→ SPEAK
```

Not:

```
LISTEN → THINK → SPEAK → WAIT
```

### 5.2 Wake Word & Attention

**Always-listening mode:**
- Low-power wake word detection (local, no cloud)
- Detects wake word efficiently
- Transitions to full listening on detection

**Push-to-talk fallback:**
- Explicit activation (button press)
- Useful in noisy environments
- Useful when always-listening not available

**Stop-listening:**
- Explicit command ("Stop listening")
- Timeout (30 seconds of inactivity)
- User leaves presence

### 5.3 Speech Recognition

**STT Pipeline:**
```
Audio input
    ↓
Noise suppression
    ↓
Echo cancellation
    ↓
Voice activity detection
    ↓
Speech recognition (local or cloud)
    ↓
Transcript with confidence
```

**Voice Activity Detection (VAD):**
- Detect when user is speaking
- Detect when user stops
- Distinguish:
  - Short pause (wait)
  - Hesitation (wait)
  - Thinking (wait)
  - Sentence break (wait)
  - End of turn (respond)

**Silence Duration Rules:**
- <500ms: Definitely not end-of-turn
- 1000-2000ms: Likely end-of-sentence, prepare to respond
- 3000ms+: Definitely end of turn, respond

### 5.4 TTS Architecture

TTS is an abstraction layer, like LLM providers.

**TTS Provider Interface:**
- Chatterbox (local, $0, voice cloning - built 2026-08-31, not yet activated pending Gavin's reference clip - see `src/phase2/chatterbox-synthesizer.ts`)
- Fish Audio (Gavin's custom "jarvis" voice - built 2026-08-31, currently blocked on a real 402 Payment Required, not the active provider)
- Piper (local, free - current active provider while the above two are unavailable/pending, automatic fallback for both once either is active - see `src/phase2/tts-provider.ts`)

**TTS Capabilities:**
- Voice selection (male, female, character)
- Speech speed (slow to fast)
- Natural pauses (at punctuation)
- Sentence chunking (for streaming)
- Immediate cancellation
- Urgency levels

**Urgency Levels:**
- Normal: Natural conversational pace
- Quiet: Whispered or soft speech
- Urgent: Faster, more emphatic
- Short: Brief acknowledgment
- Detailed: Slower, more careful

---

## Part 6: Vision & Perception

### 6.1 Screen Awareness

JARVIS understands the PC screen:

**Screen Capture:**
- Full screen screenshot
- Active window capture
- Region capture
- OCR on regions

**Context Routing:**
- What application is active?
- What does the screen show?
- Is this task screen-related?
- Do I need to look at the screen?

**Vision Reasoning:**
- Understand UI elements
- Read text from screen
- Detect changes
- Answer "what's on screen?" questions

### 6.2 Camera Awareness

If camera available, JARVIS can see:

**Object Recognition**
- What objects are in view?
- What people are present?

**Scene Understanding**
- What's the environment?
- Is this office/home/workshop?
- What's happening?

**Gesture Recognition**
- Detect hand gestures
- Hand tracking
- Pointing
- Thumbs up/down

**Questions:**
- "What's that on my desk?"
- "Is anyone in the room?"
- "What am I working on?"

### 6.3 Context Routing

Every request checked:

```
Request arrives
    ↓
Does this need screen context?
    ├─ YES → Capture screen
    └─ NO → Skip
    ↓
Does this need camera context?
    ├─ YES → Capture camera (if available)
    └─ NO → Skip
    ↓
Does this need web research?
    ├─ YES → Search web
    └─ NO → Skip
    ↓
Assemble context
    ↓
Route to appropriate tool/model
```

---

## Part 7: Autonomy & Proactivity Engine

JARVIS should eventually operate continuously, not just react to commands.

### 7.1 Proactive Monitoring

JARVIS continuously monitors for:

**Calendar:**
- Upcoming meetings
- Overdue tasks
- Conflicts
- Travel time

**Email:**
- Important messages
- Required follow-ups
- Overdue responses

**Tasks:**
- Pending actions
- Overdue items
- Progress stalled

**Business:**
- Pipeline metrics
- Stalled deals
- Follow-up opportunities
- Anomalies

**Personal:**
- Health data
- Sleep quality
- Activity levels
- Habit adherence

**Patterns:**
- Unusual activity
- Breaking routine
- Performance changes
- Attention needed

### 7.2 Proactivity Decision Engine

Not all monitoring results warrant notification.

```
Event Detected
    ↓
How relevant? (score: 0-100)
    ├─ <20: Ignore
    ├─ 20-40: Archive for briefing
    ├─ 40-70: Conditional notify
    └─ >70: Notify soon
    ↓
How urgent? (score: 0-100)
    ├─ <20: Can wait
    ├─ 20-50: Notify on next check
    ├─ 50-80: Notify within 1 hour
    └─ >80: Notify immediately
    ↓
Requires permission?
    ├─ YES → Request approval
    └─ NO → Proceed
    ↓
Which device?
    ├─ PC at desk? → Use PC
    ├─ Phone in pocket? → Use phone
    └─ Away? → Phone notification
    ↓
Action
    ├─ Notify
    ├─ Execute silently
    ├─ Queue for briefing
    └─ Ignore
```

### 7.3 Communication Timing

Respect user's current context:

- If in meeting: Queue until after
- If working intensely: Batch non-urgent
- If away: Only critical notifications
- If sleeping: Urgent only
- If with others: Private notifications to phone

### 7.4 Permission-Aware Autonomy

JARVIS can eventually take actions without asking, but only for low-risk work.

**No Permission Needed:**
- Archive old emails
- Update local memory
- Download updates
- Organize files
- Schedule non-conflicting meetings
- Prepare briefings
- Research topics

**Needs Permission:**
- Sending emails
- Scheduling meetings that might conflict
- Installing software
- Changing settings
- Deleting files
- Accessing credentials

**Needs Verification:**
- Large financial decisions
- System changes
- Security settings
- Modifying core JARVIS

---

## Part 8: Tool Architecture

JARVIS uses tools through a standardized interface.

**Tool Interface:**
```
name: string
description: string
inputSchema: JSONSchema
outputSchema: JSONSchema
permissions: string[]
execute: (input) → output
errorHandling: (error) → recovery
audit: (input, output, result) → log
```

**Tool Categories:**

**Computer Control**
- Application management
- File operations
- Input control
- Screenshot
- Terminal
- Window management

**Communications**
- Email (Gmail)
- Calendar (Google Calendar)
- Messages
- Notifications

**External Services**
- Web search
- Weather APIs
- Maps APIs
- News APIs
- Time zones

**Local Services**
- JARVIS memory
- JARVIS settings
- JARVIS logs
- Local files

**Business Tools**
- Hartwich OS (CRM)
- Sales pipeline
- Leads database
- Metrics

**Device Services**
- Phone (future)
- Wearables (future)
- Smart home (future)

---

## Part 9: Recovery & Reliability

Every major subsystem must handle failures gracefully.

### 9.1 Failure Modes

**Timeout**
- Max wait time before error
- Retry logic
- Fallback option

**Retry**
- Exponential backoff
- Max retry count
- Circuit breaker (stop retrying after N failures)

**Cancellation**
- User says "stop"
- Timeout triggers
- Resource limit hit
- Priority interrupt

**Fallback**
- Primary service unavailable?
- Use backup service
- Degrade gracefully

**Graceful Degradation**
```
Cloud LLM unavailable
    ↓
Use local model (slower)
    ↓
Only basic capabilities
    ↓
Limited reasoning depth
    ↓
Continue operating
```

### 9.2 Error States

**Recoverable:**
- Temporary network error → Retry
- Tool timeout → Retry with fallback
- Model rate limit → Wait and retry
- Missing file → Ask user

**Unrecoverable:**
- User cancels → Stop gracefully
- Permission denied → Explain and stop
- Invalid input → Clarify and ask again
- System resource exhausted → Defer task

---

## Part 10: Implementation Phases

### Phase 0: Foundation (Current)

**Status:** ✅ Complete

**Capabilities:**
- Core orchestration ✅
- Multi-agent reasoning ✅
- Verification (6 agent roles) ✅
- PostgreSQL + Drizzle ✅
- Provider abstraction ✅
- Memory system ✅
- Audit trail ✅
- Testing infrastructure ✅

**Success Criteria:** JARVIS can decompose tasks, delegate to agents, verify work, store memories, remain auditable.

### Phase 1: JARVIS Developer

**Status:** ✅ Real as of 2026-08-27, correcting the stale ❌ this block carried until today (see the ground-truth bullet above for the full explanation). `developer.ts`'s 7-agent pipeline (Architect, Planner, Coder, Debugger, Code Reviewer, Security Reviewer, Verifier) genuinely calls the LLM gateway at every step, does mechanical build/test verification, runs a bounded auto-debug loop, and gates deployment behind a real human-approval flag. `bun run dev phase1` still only prints a static summary; `bun run dev developer "<requirement>"` runs the real pipeline end to end. Code-verified, not yet run live against OmniRoute/Ollama on Gavin's PC.

**Capabilities:**
- Repository understanding ✅ (real tools, used by the pipeline)
- Code modification ✅ (`applyFileBlocks`, real disk writes)
- Git integration ✅ (`git.ts`, real commits behind the approval gate)
- Automated testing ✅ (`build-test.ts`, mechanical not LLM-guessed)
- Debugging ✅ (bounded auto-debug loop)
- Code review ✅ (Code Reviewer + Security Reviewer agents, real LLM calls)
- Self-improvement loop ✅ (`bun run dev phase1-selftest` — not yet run live)

**Success Criteria:** JARVIS can meaningfully build, test, debug, and improve software. **Code-complete; awaiting a live run on Gavin's PC to confirm end to end.**

### Phase 1.5: Conversational Intelligence

**Status:** ✅ Real as of 2026-08-27. Imported and actively called from `orchestrator.ts`, as this line already said — but until today the actual response generation (`streamFromModel`/`streamFromBuffer`) was 100% hardcoded mock text with zero LLM calls behind it, "wired" without being real. Now fixed: both methods call a real `ModelProvider` (the same `createDefaultGateway()` gateway used everywhere else) via a new `callModel()` method. A new `bun run dev conversation "<text>"` CLI command makes this reachable/testable. See the ground-truth bullet above for the full history. Code-verified, not yet run live.

**Capabilities:**
- Conversation state machine ✅
- Working memory ✅
- Streaming support ✅
- Interruption handling ✅
- Personality layer ✅
- Model routing ✅
- Proactive monitoring ✅

**Success Criteria:** Conversation feels natural and continuous. Context carries across turns. Personality is consistent.

**Dependencies:**
- Phase 0 ✅
- Phase 1 ✅
- Presence & Device Awareness (start parallel)
- Authorization Engine (start parallel)

### Phase 2: Natural Voice Interface

**Status:** ⚠️ TTS, STT, wake word, and real LLM-backed response generation are all real and verified (see 2026-08-26 updates above). As of 2026-08-30, real microphone capture, real audio playback, and real silence-based end-of-turn detection are also built (see the 2026-08-30 update above) and reachable via a new `bun run dev listen` command — sequential (LISTEN → THINK → SPEAK → WAIT, looping), not full-duplex. Interruption and true full-duplex audio (simultaneous listen+speak) are still not built — `conversation-engine.ts` has a real state machine designed for it but it isn't wired to real audio yet — and this whole update is code-verified/typechecked only, **not yet run against Gavin's actual microphone and speakers**, same as everything else in this codebase that needs real hardware I/O this Linux sandbox doesn't have.

**Capabilities:**
- Wake word detection
- Speech recognition
- Natural conversation
- Interruption
- Text-to-speech
- Full-duplex audio
- Streaming TTS

**Success Criteria:** Natural voice conversation. Can interrupt. Responses stream.

**Dependencies:**
- Phase 1.5

### Phase 3: Perception

**Status:** ✅ Code-complete, PC-unverified. `screen-control.ts` shells out to real PowerShell via `windows-control.ts` (open/close/type/key/wait; click/focus/scroll still unexercised), reachable via `bun run dev control-test` — real, written-for-real automation, unverified only because this Linux sandbox can't run PowerShell or drive a real screen, same category as Phase 2's microphone gap. Vision: `ollama-vision-provider.ts` is a real, live-verified `VisionProvider` (moondream via local Ollama, $0); as of 2026-08-27 `VisionSystem` is wired to it via a new `bun run dev vision-test <path-to-image>` CLI command (`setProvider(new OllamaVisionProvider())`), and its no-provider fallback now throws a clear error instead of the fabricated "office desk" data it used to return. `GeminiVisionProvider` still throws "not yet implemented" on every method.

**Capabilities:**
- Screen awareness ✅ (real, PC-unverified)
- Vision ✅ (real, code-verified — needs Ollama + `moondream` on Gavin's PC to run live)
- Object recognition ✅ (same path, `detectObjects()`)
- Visual context routing (`context-router.ts`, not re-audited this pass)

**Success Criteria:** JARVIS can see and understand environment. Code-complete; needs a live run on Gavin's PC (Ollama + `moondream` pulled) to confirm.

**Dependencies:**
- Phase 1.5
- Phase 2 (optional, can run parallel)

### Phase 4: Proactive Intelligence

**Status:** Planned

**Capabilities:**
- Event monitoring
- Proactivity engine
- Smart notifications
- Autonomous actions
- Permission-aware autonomy

**Success Criteria:** JARVIS notices important things without being asked.

**Dependencies:**
- Phase 0
- Phase 1
- Phase 1.5

### Phase 5: Digital Ecosystem

**Status:** Planned

**Capabilities:**
- Calendar integration
- Email integration
- File management
- Hartwich OS integration
- Computer control
- Web search
- External APIs

**Success Criteria:** JARVIS operates across digital tools seamlessly.

**Dependencies:**
- Phase 0
- Phase 1-4

### Phase 6: Unified Mobile Interface

**Status:** Planned

**Architecture:**
- Android JARVIS interface
- Shared memory backend (PC is primary, phone syncs)
- Unified conversation
- Device presence awareness
- Communication routing

**Note:** Phone is NOT separate assistant. Same JARVIS runs both PC and phone.

**Success Criteria:** Conversation started on PC continues on phone. Same identity, memory, capabilities.

**Dependencies:**
- Phase 1.5
- Phase 2
- Presence & Device Awareness

### Phase 7-10: Advanced (Long-term)

- Phase 7: Health & Wearables
- Phase 8: Physical Ecosystem
- Phase 9: Spatial Interface
- Phase 10: Controlled Self-Improvement

---

## Part 11: Pre-Phase Work (Start ASAP)

Must be started before Phase 2 but can run parallel with Phase 1.5:

### Presence & Device Awareness

Build infrastructure for:
- Knowing where Gavin is
- Knowing which devices available
- Routing notifications to correct device
- Understanding device capabilities

### Authorization Engine

Build infrastructure for:
- Identifying users
- Assigning permission levels
- Checking permissions before actions
- Recording access attempts

### Computer Control API

Formalize existing implicit tool layer:
- Application control
- File operations
- Input control
- System commands

### Recovery Patterns

Add to existing subsystems:
- Timeouts
- Retries
- Fallbacks
- Graceful degradation

---

## Part 12: Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Node.js / Bun | Portable, reliable |
| Language | TypeScript | Type safety, maintainability |
| Database | PostgreSQL | Powerful, local capable |
| ORM | Drizzle | Type-safe, lightweight |
| STT | Whisper / faster-whisper | Local, accurate, free |
| TTS | Piper (active), Chatterbox (built, pending Gavin's reference clip), Fish Audio (built, blocked on payment) | Piper is $0/local and currently active; Chatterbox is the intended $0 primary once Gavin has a voice clip; Fish Audio kept in code in case that account is ever funded |
| Wake word | openWakeWord | Local, efficient, free |
| LLM (primary) | OmniRoute (self-hosted local gateway, 300+ upstreams) | Primary as of 2026-08-27 — no single provider's quota can take JARVIS down |
| LLM (fallback) | Ollama (`qwen2.5-coder:1.5b` default) | $0 local floor — built and gateway-wired 2026-08-26, always registered |
| LLM (optional) | Gemini, OpenRouter | Only if their API keys are set — Gemini demoted from primary 2026-08-27 |
| Vision | Ollama (`moondream`, local) | Real, verified 2026-08-26 (`ollama-vision-provider.ts`); `GeminiVisionProvider` still an unimplemented stub |
| GUI | Tauri (future) | Native + web for desktop |

---

## Part 13: Non-Negotiable Invariants

**These cannot be violated:**

1. **IDENTITY ≠ AUTHORIZATION**
   - Recognizing someone ≠ granting access

2. **LLM DECISION ≠ PERMISSION**
   - Model deciding what to do ≠ permission to do it

3. **JARVIS ≠ ONE LLM**
   - Must work with any provider

4. **JARVIS ≠ ONE DEVICE**
   - Must work across PC, phone, wearables

5. **MEMORY ≠ CONVERSATION HISTORY**
   - Extract signal, not store noise

6. **TOOL EXECUTION ≠ LLM OUTPUT**
   - Model suggestion → authorization check → execution

7. **SELF-IMPROVEMENT ≠ UNCONTROLLED SELF-MODIFICATION**
   - Only through approved, tested, verified changes

8. **PRESENCE INFLUENCES COMMUNICATION**
   - Don't interrupt someone in meeting

9. **RISK INFLUENCES AUTHORIZATION**
   - High-risk actions need extra verification

10. **URGENCY INFLUENCES NOTIFICATION**
    - Critical alerts override quiet hours

11. **PERSONALITY IS MODEL-INDEPENDENT**
    - Changing LLMs doesn't change JARVIS

12. **EVERY ACTION IS AUDITABLE**
    - Know what JARVIS did, why, and when

---

## Part 14: Success Metrics

### Phase 0
- [ ] Can reason through multi-agent pipeline
- [ ] Verification catches 80%+ of errors
- [ ] Memory persists and is retrievable
- [ ] Audit trail is complete
- [ ] Works without paid services

### Phase 1
- [ ] Can autonomously code simple features
- [ ] Can debug and fix errors
- [ ] Code quality is acceptable
- [ ] Self-improvement loop works
- [ ] Builds itself faster each iteration

### Phase 1.5
- [ ] Conversation feels natural
- [ ] Context carries across turns
- [ ] Personality is consistent
- [ ] Streaming works smoothly
- [ ] Interruption is seamless

### Phase 2
- [ ] Can have natural voice conversation
- [ ] Can be interrupted mid-sentence
- [ ] Responds within <1 second (streaming)
- [ ] Handles noise/echo
- [ ] Works in realistic environments

### Phase 3
- [ ] Understands screen content
- [ ] Understands visual context
- [ ] Routes correctly (needs screen? skip)
- [ ] Answers visual questions accurately

### Phase 4
- [ ] Proactively identifies opportunities
- [ ] Respects interruption/attention
- [ ] Doesn't become annoying
- [ ] Takes autonomous actions correctly

### Phase 5
- [ ] Integrates with 5+ tools/services
- [ ] Operates seamlessly across digital tools
- [ ] Remembers integrations and context
- [ ] Reduces manual data entry

### Phase 6
- [ ] Unified JARVIS on PC and phone
- [ ] Conversation continues across devices
- [ ] Memory syncs properly
- [ ] Permissions carry over

---

## Part 15: What JARVIS Is Not (Yet)

These are intentionally future capabilities:

- Movie-level robotics
- Iron Man suit integration
- Drones
- Fully autonomous decision-making
- Unlimited intelligence
- Uncontrolled self-modification
- Fully distributed cloud reasoning
- Multi-user architecture

---

## Part 16: Build Strategy

### Don't Do:
- Start with fancy UI (use CLI)
- Build everything at once
- Introduce unnecessary complexity
- Create perfect abstractions prematurely
- Assume you know future needs

### Do:
- Build end-to-end vertical slices
- Test against real scenarios
- Iterate based on what breaks
- Keep architecture explicit
- Document decisions
- Build the boring stuff first

### Timeline Principles:
- Phase 0: Weeks (foundation)
- Phase 1: Weeks-months (developer)
- Phase 1.5: Weeks (conversational intelligence)
- Phase 2: Weeks (voice)
- Phase 3+: Ongoing

Don't rush. Each phase earns the right to the next.

---

## Final Statement

JARVIS is a **persistent, multi-faceted intelligence** that lives on Gavin's computer and can be accessed through multiple interfaces.

It begins as a reasoning engine with memory and verification.

It gains the ability to engineer software.

It gains voice and perception.

It gains proactive intelligence.

It gains mobile access.

Throughout, it remains **one intelligence with consistent identity, memory, and personality** — regardless of which device you're using or which LLM provider is running the reasoning.

**The objective is not to recreate movie JARVIS immediately.**

**The objective is to build the foundation so well that adding new capabilities becomes an integration problem, not another reinvention.**

---

**Build the brain.** (Phase 0) ✅
**Build the developer.** (Phase 1) ✅ code-complete 2026-08-27, PC-unverified
**Build the conversation.** (Phase 1.5) ✅ code-complete 2026-08-27, PC-unverified
**Then give it voice.** (Phase 2) ⚠️ TTS/STT/wake word/reply/mic-capture/playback/end-of-turn detection all real and code-complete as of 2026-08-30 (`bun run dev listen`); full-duplex/interruption deliberately deferred; needs Gavin's PC hardware to actually run for the first time
**Then let it see.** (Phase 3) ✅ code-complete 2026-08-27, PC-unverified — needs Ollama + `moondream` running
**Then let it think ahead.** (Phase 4) — not started
**Then connect everything.** (Phase 5+) — not started

All five phases above are code-aligned with this document as of 2026-08-27. The only work remaining across all of them is running each on Gavin's actual PC to confirm live (OmniRoute cold-start, PowerShell control, mic hardware, Ollama vision) — no further code changes are expected before that verification pass, short of whatever it turns up.
