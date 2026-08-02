# Evidence and Safety Specification

**Evidence reviewed through 1 August 2026.** This document defines the evidence and safety boundary for the first consumer-camera release. It is a product specification, not medical advice or a substitute for market-specific clinical, regulatory, privacy, or legal review.

Labels used below:

- **Supported**: directly supported by an official standard/guideline or relevant published evidence, subject to app-specific validation.
- **Not established**: current evidence does not justify the claim or inference.
- **[Coaching inference]**: a prudent coaching choice that has not been shown to prevent injury.
- **[Engineering inference]**: a risk-control or implementation choice that must be validated in this product.

## Product position and claims

The product is a **general-wellness technique-awareness tool**. It may describe what a live camera or selected local clip showed, how consistently a user performed the selected movement style, and whether tracking was reliable enough to comment.

| Claim or output | Product status |
| --- | --- |
| Rep count, cadence, phase timing, and selected 2D geometry | Supported only after app-specific analytical validation |
| Comparison with a selected swing style or the user's calibrated baseline | Supported when presented as an observation, with confidence and limitations |
| “Supports general fitness practice, technique awareness, and consistency” | Appropriate general-wellness positioning |
| “Safe/unsafe,” “injury risk,” injury probability, or exercise clearance | **Do not claim; not established** |
| Diagnosis of spinal flexion, pathology, imbalance, pain source, or fatigue | **Do not claim; not observable or established** |
| Treatment of back pain, rehabilitation, return-to-sport, or disease-specific prescription | **Do not claim without a medical-device pathway and clinical evidence** |
| Muscle activation, spinal load, bracing, breathing, tissue capacity, or a “safe weight” inferred from video | **Do not claim; not observable from ordinary keypoints** |
| “Perfect form,” “medical/clinical grade,” injury prevention, or equivalence to a qualified coach | **Do not claim** |
| Superiority of kettlebells or this app over other training/coaching | **Do not claim without direct comparative trials** |

The kettlebell-specific evidence base is limited. A scoping review found the longitudinal literature generally small, underpowered, and low quality, with low-to-very-low confidence in reported effects and no quantifiable injury incidence. Absence of reported adverse events in small trials is not proof of safety ([Meigh et al., 2019](https://pubmed.ncbi.nlm.nih.gov/31497302/)).

## Initial supported movement style

Version 1 assesses one explicitly named style:

> **Two-hand, hip-hinge swing to approximately shoulder/eye height**

The movement definition follows the [NSCA two-arm kettlebell swing technique](https://www.nsca.com/education/articles/kinetic-select/two-arm-kettlebell-swing/) and relevant biomechanical studies:

- Stable, flat-footed stance approximately hip-to-shoulder width and a closed two-hand grip.
- Hips move back with moderate knee flexion; the selected style is hip dominant rather than a squat.
- Hip-and-knee extension propels the bell into a forward arc; the arms guide the bell and remain comparatively long.
- The finish is tall and close to the user's calibrated upright position, without a marked backward lean.
- On descent, the user allows the bell to return before hinging and keeps it close through the backswing.
- The set ends with a controlled park.

These are technique observations, not injury-prevention rules. Hip-hinge, squat, double-knee-extension, shoulder-height, overhead, and sport swings have different mechanics. The app must not call another intentional style “bad” or “unsafe”; it should state that the style is unsupported and invite the user to select another mode when available ([Del Monte et al., 2020](https://pubmed.ncbi.nlm.nih.gov/28930870/); [Bullock et al., 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5455182/); [Murphy and Riemann, 2025](https://pubmed.ncbi.nlm.nih.gov/39758692/)).

Do not turn angles reported by small laboratory cohorts into universal cutoffs. Bell mass materially changes joint demand, and style changes trajectory and power ([Lake and Lauder, 2012](https://pubmed.ncbi.nlm.nih.gov/22207261/); [Levine et al., 2022](https://pubmed.ncbi.nlm.nih.gov/32131695/)). Prefer relative measures against the user's upright calibration and thresholds developed from held-out, expert-labelled validation data.

## Observable cue model

The first release may assess five observable dimensions:

1. **Phase timing:** relationship between hip extension and shoulder/wrist movement; timing of the return hinge.
2. **Hip-dominant pattern:** relative hip and knee excursion for the selected style, without a universal hip:knee ratio.
3. **Terminal position:** gross return toward the user's calibrated upright hip/knee/trunk position and absence of a marked back lean.
4. **Wrist-path proxy and arm behaviour:** smooth tracked wrist arc and gross arm behaviour when visible. This is not a detected kettlebell trajectory.
5. **Repeatability:** cadence and trajectory variation across at least three assessable repetitions.

Novice learning research supports phase coordination and repetition consistency as useful coaching observations, but does not establish safety thresholds ([Beerse et al., 2025](https://pubmed.ncbi.nlm.nih.gov/36597768/)).

Prefer separate dimension cards plus a **tracking-confidence** indicator. If a commercial requirement demands a composite, an initial hypothesis is 30% phase timing, 25% hip-dominant pattern, 20% terminal position, 15% wrist-path proxy/arms, and 10% repeatability. **[Engineering inference]** These weights are not evidence-derived and must not be presented with clinical precision. Use broad bands and confidence rather than values such as `87/100`.

Feedback must state one high-confidence observation and one action at a time:

- “Your hands began rising before your hip drive on 4 of 5 reps. Try standing tall through the hips before the arms lift.”
- “Your knees moved more than usual for the selected hip-hinge mode. Try sending the hips farther back.”
- “You moved behind your calibrated upright position at the top. Finish tall instead of leaning back.”
- “Your last three reps became less consistent. End the set or reduce the load.” **[Coaching inference]**
- “This appears to be a different swing style. Select the matching mode if intentional.”

Standard body-pose keypoints cannot resolve segmental lumbar motion. They also cannot measure pain, internal load, muscle activation, breathing, bracing, exertion, or tissue tolerance. Gross trunk-to-pelvis shape may be described cautiously; “neutral spine” must not be scored.

## Validated-release assessability gates

Camera-placement and framing corrections may be emitted before a repetition because they describe whether the capture can be used; they are not swing-technique judgments. The following is the validated-release contract, not a claim that every gate is already implemented. Before any swing-technique score, repeatability result, or assessed coaching pointer, require:

- **Automated approximation, implemented:** exactly one accepted body pose plus all required body and hand landmarks throughout the scoring window. Any future claim about kettlebell path, identity, visibility, or control additionally requires a qualified kettlebell detector or human annotation; the current gate cannot establish those facts.
- **Automatic quality gate, incomplete:** a supported view and stable camera with adequate light, confidence, cadence, and no material occlusion, truncation, motion blur, or out-of-plane rotation for the requested metric. Current landmark/camera heuristics cover only part of this contract; direct blur/light/style checks and target-device thresholds remain release work.
- **Product setup, partial:** the product fixes the supported two-hand swing style in its copy and collects kettlebell mass, but it does not yet ask the user to attest that the performed style matches the supported protocol.
- **Path-dependent repetition gate:** at least three complete, assessable repetitions. The clip path enforces this; the live path does not yet.
- **User-attested preflight, not implemented:** sufficient clear floor space and no current pain, dizziness, unusual breathlessness, or loss-of-control symptom. The current UI advises the user to stop but has no explicit preflight input. A validated release needs a clear, ephemeral local confirmation or must keep assessed coaching disabled; it must not persist a health answer by default.

If a gate fails, provide the corrective setup instruction and return **“Unable to assess reliably”**. Do not emit a score, safety conclusion, or guessed technique pointer. Camera distance and angle can drastically alter detection, and results from squats or other exercises cannot be assumed to transfer to swings ([2026 camera-position study](https://pmc.ncbi.nlm.nih.gov/articles/PMC12978916/)). **[Engineering inference]** Propagate landmark/object uncertainty through every derived metric and suppress feedback when uncertainty crosses a threshold established during validation.

The current clip path enforces the three-repetition gate before returning a pointer, but it still lacks the complete automatic-quality and user-attested preflight contract above. The current live analyzer can surface a provisional observable cue after one ordered swing cycle and has the same remaining gaps. Neither path is a validated technique assessment today; output must remain labelled as prototype technique awareness until every applicable gate exists and is qualified, or each earlier cue has separate, documented validation.

The clip and live implementations ask MediaPipe for up to two poses and accept body evidence only when exactly one pose is returned. Live coaching also requires three geometrically continuous frames before analysis or speech, retains identity only across a short matching gap, and clears coaching and calibration state on ambiguity or discontinuity. Every key full-body landmark must clear an individual visibility floor. These are conservative person-count, framing, and continuity approximations—not biometric identity and not proof that no one else is present. The current model does not identify a kettlebell; wrist motion is labelled as a proxy and cannot establish bell identity, centre, load, path, or control.

## Local clip workflow boundary

The repository's local clip workflow applies these engineering controls:

- Accept one browser-native, successfully decoded video source no longer than 120 seconds and no larger than 200 MiB. File extensions and reported MIME types are hints, not proof that a source is decodable.
- Keep the complete source available for local preview, but analyze only one continuous window from 4 through 10 seconds and one normalized spatial frame selected within the source image. Require at least three complete assessable repetitions before emitting a pointer.
- Do not upload, persist, transcode, or send the clip, its filename, frames, or derived results to analytics. The selection describes analysis boundaries; it does not create a new media file.
- Crop and downscale each sampled frame to a maximum analysis dimension of 640 pixels, sample no faster than 15 frames per second, and allow at most one transferable `ImageBitmap` in flight. Do not build a frame queue.
- Run MediaPipe in the existing dedicated Worker, release every transferred frame after processing, and discard results from cancelled, superseded, or mismatched jobs.

These limits control resource use; they do not make a clip assessable. The selected window and frame should visibly contain the full user and kettlebell, but the current automatic gate can verify only the required body landmarks—not the kettlebell. Sufficient visibility and enough complete repetitions are still required for the requested observation. Cropping cannot recover occluded or truncated evidence, and a user-selected interval can introduce selection bias. Sampling at no more than 15 fps can miss brief events, so output must describe only reliably observed patterns rather than claim frame-accurate biomechanics. Browser codec, orientation, seek, memory, and thermal behaviour require target-device validation.

## Screening, symptoms, and progression

The initial intended population should be **generally healthy adults aged 18 or older**. Minors, pregnancy/postpartum, older or frail users, people with disability or prostheses, and users with pain, injury, or medical conditions require dedicated validation and adapted professional review rather than extrapolation.

Use the [ACSM preparticipation framework](https://www.exerciseismedicine.org/assets/page_documents/ACSM%20Preparticipation%20Screening%20Guidelines.pdf) or a properly licensed implementation of the [CSEP Get Active Questionnaire](https://csep.ca/2021/01/20/pre-screening-for-physical-activity/). Screening informs whether professional guidance may be appropriate; it does not let the app diagnose or clear a user.

Tell the user to stop immediately for:

- Chest pressure or pain.
- Faintness, significant dizziness, or loss of consciousness.
- Unusual severe shortness of breath.
- Sudden or sharp pain, new neurological symptoms, or loss of bell/body control.
- Severe unexpected muscle pain with dark tea/cola-coloured urine or marked weakness; advise urgent medical assessment because these are possible rhabdomyolysis signs ([CDC guidance](https://www.cdc.gov/niosh/rhabdo/signs-symptoms/index.html)).

These are symptom prompts, not diagnoses.

A prudent learning sequence is unloaded hinge, kettlebell deadlift, hike/park, then short sets of two-hand shoulder-height swings. Progress only one variable at a time: load, repetitions, sets, density, or height. Avoid default training-to-failure, HIIT, or EMOM prescriptions for novices. **[Coaching inference]** A fatigue study in experienced men found ground-reaction force rose while hip power fell during repeated maximal-effort intervals, but did not establish an injury threshold ([Levine et al., 2025](https://pubmed.ncbi.nlm.nih.gov/37126368/)).

App instruction is not a substitute for live coaching. In one randomized cross-sectional study, app-only instruction during complex exercises including swings produced lower medial-hamstring activation than physiotherapist instruction; injury outcomes were not studied ([Zebis et al., 2019](https://pubmed.ncbi.nlm.nih.gov/31687405/)). Recommend a qualified coach for novices, persistent uncertainty, pain, or unsupported styles.

## Programming boundary

The [2026 ACSM resistance-training position stand](https://acsm.org/resistance-training-guidelines-update-2026/) prioritizes consistent, high-effort resistance training of all major muscle groups at least twice weekly for healthy adults. The [WHO physical-activity guideline](https://www.who.int/publications/i/item/9789240014886) recommends 150–300 minutes of moderate or 75–150 minutes of vigorous aerobic activity weekly, plus strengthening all major muscle groups on at least two days.

A swing is one ballistic, hip-dominant exercise and should not be represented as a complete balanced program. **[Coaching inference]** Overall programming should include appropriate push, pull, squat/hinge, carry/core, aerobic, recovery, and mobility choices based on the user's goals and capacity. General ACSM load prescriptions must not be converted directly into a camera-selected kettlebell weight.

## General-wellness and regulatory boundary

The January 2026 [FDA General Wellness guidance](https://www.fda.gov/media/90652/download) covers low-risk products intended for fitness, strength, endurance, coordination, and activity tracking. It excludes diagnosis, disease screening/monitoring, clinical thresholds, treatment direction, and claims of clinical accuracy, clinical grade, or substitution for an authorized device. Inclusion under that policy does not establish safety or effectiveness.

The [FTC Health Products Compliance Guidance](https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance) requires competent and reliable evidence for express and implied health claims. A disclaimer cannot cure a contradictory medical or safety claim.

In the UK, intended purpose is inferred from the whole experience—including UI, app-store copy, website, advertising, social posts, and testimonials. General fitness is not usually a medical purpose; diagnosis, individual disease risk, and treatment influence may make software a medical device ([MHRA software guidance](https://www.gov.uk/government/publications/medical-devices-software-applications-apps)). The corresponding EU reference is [MDCG 2019-11 rev.1](https://health.ec.europa.eu/latest-updates/update-mdcg-2019-11-rev1-qualification-and-classification-software-regulation-eu-2017745-and-2025-06-17_en).

Under the [EU AI Act](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai), relevant transparency provisions begin applying on 2 August 2026. Classification depends on intended purpose and functionality. Maintain consistent wellness positioning and obtain market-specific legal review before release or any claims expansion.

## Privacy and accessibility

Privacy defaults:

- Process live camera frames and selected clips on-device and ephemerally. The current clip workflow does not upload, retain, transcode, or add the source or derived results to analytics. **[Engineering inference]**
- Crop or ignore faces, do not record audio, and never use face or gait for identity.
- Keep spoken framing explicitly opt-in and output-only. The primary path plays one of 22 pre-generated, same-origin MP3 assets from the versioned `maritime-command-v2` candidate; it has no runtime synthesis provider, application server function, microphone access, or frame, clip, image, landmark, or user-audio transfer. If the branded pack is unavailable, that same spoken-framing opt-in permits a browser-reported local English system voice to read the fixed phrase without a second confirmation; its availability, sound, and OS/browser privacy behaviour vary. Never fall back to speech recognition or attach user audio.
- Do not persist derived metrics unless a future user-facing feature has a defined purpose, retention period, and consent basis.
- Require separate, granular opt-in consent for support uploads, research, or model improvement.
- Any future persistence or transfer requires export and deletion controls, a retention schedule, encryption, and a data-protection impact assessment where risk is high.

### Static AI voice-pack boundary

The visual framing classifier and movement analyzer remain on-device. After speech opt-in, the browser fetches only the selected profile's eleven statically enumerated, Vite-hashed, same-origin audio assets. The complete candidate contains 22 distinct 24 kHz mono MP3 clips and totals 323,166 bytes. The male/female phrase sets total 19,300/19,133 ms (0.87% delta) and differ by 0.036 LU in mean integrated loudness; those are engineering parity measurements, not evidence of British authenticity, charisma, coaching efficacy, or user motivation. Each asset is streamed under a fixed 15-second deadline into a buffer whose ceiling is the exact manifest byte length. Oversized declared or actual bodies, stalls, cancellation, incorrect `audio/mpeg` MIME, short bodies, and SHA-256 mismatches fail before decoding; failed streams are aborted and their readers released. Playback uses one owned `AudioContext`; replacement and profile switching cancel stale or active playback, while page hiding, session end, disable, failure, and unmount also abort unfinished asset requests. The context is suspended while inactive and closed on unmount.

The two product profiles are original fictional AI-generated British Maritime Command characters. They must be disclosed as AI-generated and must not be marketed as recordings of a human coach, imitations of an identifiable person, or members of or endorsements by a real military unit. The v2 pack remains a candidate until blind human review accepts accent, matched leadership energy, naturalness, exact wording, and intelligibility. The release provenance, semantic identity brief, prompt-persistence limitation, mastering contract, integrity checks, and human sign-off requirements are recorded in [`VOICE_PACK.md`](VOICE_PACK.md).

The runtime path contains no voice-provider credential, voice-provider request, WebRTC peer, WebSocket, microphone track, data channel, application server function, free-form text surface, or arbitrary URL fetch. Statically enumerated source URLs and an exhaustive typed profile/message map expose no intended runtime mechanism for a cue or user input to select another origin or path; this does not replace deployed-asset and application-integrity controls. Only the mastered assets are public; reference audio, raw masters, voice prompts, speaker embeddings, model credentials, and generation tokens remain outside the repository and deployment. The local device-speech fallback is platform controlled, so its network and retention behaviour cannot be inferred from application source and must be described separately from the static primary path. It occurs within the original spoken-framing opt-in rather than prompting again after a pack failure.

An image is not automatically special-category biometric data under UK GDPR, but technical processing for unique identification is. Pain, medical-screening answers, and inferred health status may be special-category health data. Ephemeral processing is still processing ([ICO special-category data](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-is-special-category-data/); [ICO privacy by design and default](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance/data-protection-by-design-and-by-default/)). The amended US [FTC Health Breach Notification Rule](https://www.ftc.gov/legal-library/browse/rules/health-breach-notification-rule) applies to many non-HIPAA consumer health apps and covers unauthorized disclosures as well as security breaches.

Target [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) and its [mobile/non-web applicability](https://www.w3.org/WAI/standards-guidelines/mobile/):

- Provide text/captions plus visual and haptic equivalents for audio cues, and spoken alternatives for visual overlays.
- Treat “position looks good” only as a stable framing state: it does not mean the room is safe, the bell is detected, or the swing is correct. Suppress automatic setup speech while a swing is in progress so it does not distract the athlete.
- Do not convey meaning by colour alone; support scalable text, high contrast, screen readers, and reduced motion.
- Provide large, accessible start/pause/stop controls; never require a camera gesture to operate the session.
- Offer adjustable cue pace and volume and an accessible non-camera/manual-log mode.
- Support alternate metric sets and “not assessable” rather than treating prostheses, mobility aids, atypical anatomy, or limited range as failure.

## Validation protocol

No live-camera- or clip-derived claim ships without validation of the exact production pipeline.

1. **Analytical validity:** compare synchronized app output with 3D marker-based motion capture and expert-labelled video for the supported swing, loads, views, devices, and environments.
2. **Measurement performance:** report joint-angle mean absolute error and Bland–Altman bias/limits, phase-event timing error, rep-count precision/recall/F1, false-cue rate, calibration, test-retest reliability, and assessability/rejection coverage.
3. **Cue validity:** have qualified kettlebell and biomechanics experts predefine acceptable observations and review disagreements. Test whether each cue describes the recorded movement; do not equate agreement with injury prevention.
4. **User effect:** prospectively test comprehension, behaviour change, adverse events, and comparison with no feedback and qualified coaching before making effectiveness or equivalence claims.
5. **Subgroups and conditions:** report performance across age, sex/gender, skin tone, body size/proportions, clothing, disability/prosthesis, lighting, phone/camera hardware, handedness, bell mass, and intended style. Do not generalize beyond represented groups.
6. **Release controls:** version models, data, thresholds, cue text, voice-pack ID, profile identities, audio bytes/hashes, and delivery instructions; stage rollouts; monitor drift and complaints; preserve rollback and an auditable model card/change log.
7. **Clip-path equivalence:** test supported containers, codecs, rotations, resolutions, trim boundaries, spatial-coordinate mapping, cancellation, memory, and thermals. Compare clip and live-path results from the same source frames and verify that no media or derived result leaves the device.
8. **Spoken framing:** test both static AI-generated profiles and the device fallback for exact-cue adherence, disclosure, first-audio latency, clean cancellation, profile switching, cache behaviour, screen-reader coexistence, integrity-failure recovery, and the documented no-microphone/no-user-media boundary. Confirm all 22 deployed clips match the release manifest.

Markerless measurement accuracy is task-, joint-, plane-, system-, and protocol-dependent. Recent reviews find promising reliability for some sagittal tasks but continuing accuracy and real-time-feedback gaps ([Yoma et al., 2025](https://pubmed.ncbi.nlm.nih.gov/40526450/); [El-Rajab et al., 2025](https://pubmed.ncbi.nlm.nih.gov/40416048/)). Dynamic-movement validation has reported sagittal errors of several degrees and much larger errors in some transverse-plane measures ([Edwards et al., 2025](https://pubmed.ncbi.nlm.nih.gov/39733226/)). Do not infer transverse rotation from monocular RGB or transfer validation from squats, jumps, or rehabilitation exercises to kettlebell swings.

Use deterministic, versioned logic for cue eligibility and thresholds. The static voice pack is an output renderer only: generation uses the exact approved allowlist, and runtime playback accepts only exact typed `CoachVoiceMessage` objects. Neither the branded pack nor the device fallback may add advice or invent safety decisions, measurements, or thresholds. **[Engineering inference]** Apply the [NIST AI Risk Management Framework](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10) across governance, mapping, measurement, and ongoing risk management.

## Key evidence links

- Kettlebell evidence review: [Meigh et al., 2019](https://pubmed.ncbi.nlm.nih.gov/31497302/)
- General resistance training: [ACSM Position Stand, 2026](https://pubmed.ncbi.nlm.nih.gov/41843416/)
- Public-health activity guidance: [WHO, 2020](https://www.who.int/publications/i/item/9789240014886)
- Swing spinal/hip loading: [McGill and Marshall, 2012](https://pubmed.ncbi.nlm.nih.gov/21997449/)
- Swing mechanical demand: [Lake and Lauder, 2012](https://pubmed.ncbi.nlm.nih.gov/22207261/)
- Effect of kettlebell mass: [Levine et al., 2022](https://pubmed.ncbi.nlm.nih.gov/32131695/)
- Camera movement-screening review: [El-Rajab et al., 2025](https://pubmed.ncbi.nlm.nih.gov/40416048/)
- Markerless kinematics review: [Yoma et al., 2025](https://pubmed.ncbi.nlm.nih.gov/40526450/)
- Movement screens and injury risk: [Whittaker et al., 2017](https://pubmed.ncbi.nlm.nih.gov/27935483/); [Bullock et al., 2022](https://pubmed.ncbi.nlm.nih.gov/35689749/)
