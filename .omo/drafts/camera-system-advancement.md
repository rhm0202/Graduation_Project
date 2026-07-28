---
slug: camera-system-advancement
status: interviewing
intent: clear
review_required: false
pending-action: resolve the Camera Module 3 versus Global Shutter Camera hardware fork before writing a plan
approach: Keep Raspberry Pi 4 and the local-LAN WebRTC/WHEP architecture. First distinguish exposure blur, rolling-shutter distortion, focus hunting, codec smearing, and pan-tilt vibration with controlled hardware A/B measurements. Use that evidence to lock either Camera Module 3 or Global Shutter Camera, then establish an immutable post-replacement baseline, repair reproducibility and observability, optimize capture/transport/frame scheduling/inference, and tune pan-tilt control while proving both tracking and hair-boundary quality against that baseline.
---

# Draft: camera-system-advancement

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
docs-architecture | README and setup artifacts describe the v2.1 WebRTC/control architecture accurately | active | README.md:63-98; renderer/rpi.js:1-215; UPDATES.md:306-322
capture-transport | Webcam and RPi inputs deliver measurable, adaptive, recoverable video | active | renderer/sources.js:166-202; renderer/rpi.js:144-215
ai-composition | Segmentation, tracking, composition, and recording meet chosen latency/quality targets | active | renderer/sources.js:34-100,414-875; renderer/recording.js:12-55
hardware-control | Sensor/lens/exposure and pan-tilt control match the intended motion and lighting conditions | active | server/spotlight_core.py:42-99; server/modules/config.py:7-24; server/modules/pid_controller.py:108-228

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
network boundary | fixed local LAN/Windows hotspot only | explicitly selected; current RTCPeerConnection and private 192.168.137.x configuration already match it | yes
implementation boundary | no product code changes until the user explicitly starts implementation | explicitly requested | yes
acceptance thresholds | combine fixed minimum guardrails with repeatable relative improvement over the Camera Module 3 Wide baseline | explicitly selected recommended policy; baseline-first avoids inventing unsupported absolute gains | yes
camera hardware | keep Camera Module 3 as the balanced default, with Global Shutter Camera as a conditional fast-pan choice | global shutter removes row-timing distortion but not exposure blur or physical vibration; its 1.58 MP resolution may weaken hair-boundary detail | yes

## Findings (cited - path:lines)
- README is stale: it documents JPEG frames through spotlight_core on port 8000 and captureStream(30), while v2.1 receives RPi video through MediaMTX WHEP and uses WebSocket 8765 only for control; the master canvas captures at 60 fps (README.md:63-98; renderer/rpi.js:29-215; renderer/sources.js:34-59; UPDATES.md:306-322).
- The advertised multi-source compositor currently draws only state.selectedSourceId; transform and layer order are not used during frame composition (renderer/sources.js:74-100,130-141,1014-1070).
- Resolution and frame-rate settings are persisted and restart the stream, but addWebcamSource requests only deviceId and audio, so those UI settings do not affect camera capture (renderer/settings.js:11-25; renderer/media.js:244-265; renderer/sources.js:166-173).
- Each AI loop performs 640x640 canvas readback and a 1,228,800-element JavaScript RGB conversion; all sources share one sessionBusy gate, then the full-resolution frame is read again for mask composition (renderer/sources.js:543-615,721-875).
- AI model loading points to AI_models/yolo26l-seg.onnx, but the checkout contains only yolo26l-seg.zip and yolo26n-seg.onnx; packaging reproducibility is therefore incomplete unless the large model is supplied separately (renderer/background.js:13-29; AI_models/; .gitignore:11).
- RPi video reconnection is not coupled to ICE failure, and no getStats/requestVideoFrameCallback instrumentation exists, so end-to-end latency, packet loss, decode delay, and dropped frames are unmeasured (renderer/rpi.js:144-215; renderer/sources.js:54-59,543-875).
- The desktop repository contains no camera exposure, shutter, gain, autofocus, MediaMTX codec, or bitrate controls. The displayed smear cannot currently be classified as optical motion blur, rolling-shutter distortion, focus hunting, or WebRTC compression from repository evidence alone (renderer/rpi.js:144-215; renderer/sources.js:543-875).
- The AI path resizes each source frame to 640x640 and transmits coordinates only when the selected person probability exceeds 0.5; a blurred frame can therefore create a detection/control dropout, but inference FPS, skipped frames, and decoded-frame timing are not instrumented (renderer/sources.js:543-718,863-875).
- Background-removal output intentionally applies blur(1px) and contrast(1.3); this can soften person and hair edges but is separate from camera-motion blur (renderer/sources.js:850-857).
- The current pan-tilt path can issue up to ±15° PID corrections at 30 Hz with EMA smoothing, while the linked RPi motor worker moves in 3° steps every 15 ms. Abrupt target changes, stair-step motion, backlash, and deadzone/EMA dynamics are plausible vibration sources that a global-shutter sensor cannot remove (server/modules/config.py:12-24; server/modules/pid_controller.py:182-218; server/spotlight_core.py:42-99; linked RPi motor_module_pca9685.py).
- Raspberry Pi specifies Camera Module 3 as an 11.9 MP, 4608x2592 autofocus sensor with 1080p50 support; the Wide variant has a 102° horizontal FoV. The official Global Shutter Camera is 1.58 MP, 1456x1088 at up to 60 Hz, uses a C/CS lens, and supports exposures down to approximately 30 µs given adequate light (Raspberry Pi Camera Module 3 product brief; Raspberry Pi Global Shutter Camera product page and camera hardware documentation).
- Raspberry Pi describes global shutter as eliminating row-by-row rolling artefacts such as compression, stretching, and shearing. Motion blur remains governed by displacement during exposure, so short exposure and adequate lighting are required regardless of sensor choice (Raspberry Pi Global Shutter Camera announcement and camera software documentation).
- The linked Raspberry Pi repository has migrated its Python camera module to a stub and does not track a MediaMTX configuration or publisher launcher; the reproducible cam/WHEP publication path is missing from source control (GitHub rhm0202/Graduation_Project_In_Raspberry_Pi main tree; modules/camera_module.py; active/run.sh).
- There are no automated tests; package.json:test is an intentional failure placeholder (package.json:6-11).

## Decisions (with rationale)
- Preserve WebRTC/WHEP as the low-latency RPi transport; HLS adds latency and would weaken tracking responsiveness.
- Prioritize a controlled hardware diagnosis before locking the replacement model, because current code cannot quantify where camera-to-control delay or smear originates.
- Primary outcomes are co-equal: tracking response/pan-tilt stability and high-quality person boundaries including hair; the plan must measure both and may not improve one by silently regressing the other.
- Keep Raspberry Pi 4. A Raspberry Pi 5 or AI Camera architecture migration is out of scope.
- Use tests-after for software behavior, followed by repeatable hardware measurements on the real Raspberry Pi/camera/pan-tilt assembly.
- Do not treat Global Shutter Camera as a standalone cure for "afterimage": it is the preferred sensor only if identical-exposure testing shows rolling-shutter skew/jello is materially causing detector dropouts during pan.
- If exposure shortening, added light, focus locking, codec validation, and gentler pan motion restore recognition, prefer Camera Module 3 for the single-camera design because its much higher spatial resolution better protects person/hair boundary quality.
- If fast pan must continue and rolling-shutter distortion still causes unacceptable dropouts, use Global Shutter Camera with an appropriate C/CS lens and sufficient illumination, accepting the 1456x1088 ceiling and validating mask/hair quality explicitly.
- Limit networking to the same local LAN or Windows hotspot. Do not add STUN, TURN, remote-network support, or internet-facing authentication.
- Define success with both minimum guardrails and relative improvement over a repeatable selected-camera baseline; retain raw benchmark evidence so improvements are reproducible.

## Scope IN
- Raspberry Pi 4 + selected CSI camera capture and exposure/focus configuration, MediaMTX WebRTC/WHEP transport, shared frame scheduling, ONNX segmentation/tracking and selected-camera composition, pan-tilt feedback, reproducible setup, model packaging, software tests-after, and repeatable hardware QA metrics. Existing webcam behavior receives regression coverage but is not redesigned.

## Scope OUT (Must NOT have)
- No product-code implementation before explicit authorization.
- No replacement of the existing WebRTC path with a higher-latency streaming protocol without measured evidence.
- No final sensor decision from visual impression alone; capture matched local/pre-encode and PC/WebRTC samples before purchase or, if purchase must precede A/B testing, preserve a returnable/borrowed evaluation route.
- No Raspberry Pi 5 migration and no AI Camera inference-architecture rewrite.
- No general OBS-style multi-source layering/compositor repair; record the pre-existing selected-source-only behavior as a separate risk because it is not required to improve the RPi camera tracking and mask pipeline.
- No Electron security refactor, unrelated recording-format expansion, remote networking, STUN/TURN, or HLS migration.

## Required hardware diagnosis
- Capture the same moving target with the camera fixed, then with pan enabled, at matched 1/60, 1/120, 1/250, and 1/500 second exposure equivalents while recording illumination and gain.
- Compare a local pre-encode recording against the received WebRTC frame. Sharp local frames plus blocky trails on the PC indicate transport/codec tuning, not a shutter replacement.
- Photograph vertical lines or a grid during pan. Sharp but tilted, stretched, or wavy geometry indicates rolling-shutter distortion and is the strongest evidence for Global Shutter Camera.
- Log person confidence, detection-dropout rate, reacquisition time, target-centre jitter, mask boundary quality, decoded/dropped frames, packet loss, servo overshoot, and settling time.
- Compare Camera Module 3 and Global Shutter Camera only with matched FoV, subject pixel height, exposure, frame rate, lighting, and mount motion; otherwise the sensor comparison is confounded.

## Open questions
- Hardware decision gate: keep the balanced single-camera recommendation (Camera Module 3, with Global Shutter only if the controlled test proves residual rolling distortion), or commit from the start to Global Shutter Camera and accept the lower-resolution/lens trade-off?

## Approval gate
status: interviewing
approach: Resolve the sensor fork through the diagnostic criteria above, then use five implementation waves: reproducible selected-camera/MediaMTX baseline; telemetry and automated tests; frame-synchronous capture/WebRTC recovery; WebGPU/model/mask quality optimization; PID/pan-tilt tuning, documentation, packaging, and final hardware regression evidence.
next-action: Record the owner's hardware choice. Only after that choice and explicit plan approval may .omo/plans/camera-system-advancement.md be created. Do not implement product code.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
