# Phase 2 Implementation Specification

Implement Phase 2 on branch `feat/release-candidate-passport` after the Phase 1
delivery at `c1e8ee1`. Do not reimplement Phase 1. Work as five independent,
reviewable commits and run focused tests before continuing:

1. `feat(intake): add multimodal SKU intake and OCR adapters`
2. `feat(policy): add reviewed policy drift ingestion`
3. `feat(agent): add confirmed domain actions`
4. `feat(feedback): add post-launch feedback and experiments`
5. `feat(video): add verifiable storyboard and media workflow`

Do not deploy. Codex will review and deploy the final branch.

## Phase 2A — Multimodal SKU intake

The existing SKU upload displays images, but listing generation does not use
their contents. Replace that limitation with an auditable multimodal intake
pipeline.

1. Add a structured Product Fact Extraction step.
2. Accept product photos, packaging photos, certificates, manuals, and CSV/XLSX
   specification sheets.
3. Extract only observable information: visible category, color, shape/form,
   components, packaging text, explicitly visible dimensions, and explicitly
   readable identifiers.
4. Never infer certification, safety, material, capacity, or performance from
   appearance alone.
5. Every extracted fact must contain value, confidence, source document/image,
   page or bounding box when available, extraction method, and review state.
6. Model-extracted facts always start as `needs_review`, never `verified`.
7. Conflicts between user-entered, OCR-extracted, and document-derived facts
   must become explicit conflict records.
8. Users can approve, correct, or reject each fact.
9. Only approved structured facts may influence listing copy. Raw untrusted OCR
   text must never be inserted directly into generation prompts.
10. Treat all text extracted from uploads as untrusted product data and protect
    the model boundary from prompt injection.
11. Uploaded images may be used as image-generation references only when the
    configured provider documents and supports image conditioning.
12. If reference images are unsupported, disclose the limitation; never claim
    they were used.
13. Preserve product identity where supported: color, shape, recognizable
    components, and logos only when explicitly permitted.
14. Display “reference image used” only when the image was actually sent in the
    real provider request.

Provider rules:

- Use documented provider request formats only.
- Do not invent Token Plan parameters.
- Model provider capabilities explicitly, including
  `supports_reference_image`, `supports_vision`, and `supports_ocr`.
- Tests must prove unsupported providers never receive invented fields.

## Phase 2B — OCR and extensible fact ontology

Define an optional OCR provider interface and implement at least one real
adapter capable of running in the project environment.

1. If the dependency or binary is unavailable, return `manual_review` with
   `ocr_unavailable`; never report a successful text inspection.
2. Optional OCR absence must not prevent application startup.
3. OCR results contain text, confidence, bounding box, page/image reference,
   and method/provider.
4. Display OCR boxes in the evidence viewer and let users correct text before
   approving facts.
5. Support Chinese and English when the selected adapter supports them.
6. Enforce image-size and processing-time limits.
7. Tests use generated local images and never call an external OCR service.

Replace fixed fact patterns with an extensible registry supporting:

- key and localized label
- claim type and data type
- unit family and aliases
- extraction patterns and normalization
- conflict comparison
- whether evidence is required

Maintain compatibility for `capacity`, `folded_height`, `weight`,
`temperature_range`, `bpa_free`, `food_grade_silicone`, and
`dishwasher_safe`. Add generic definitions for dimensions, material, color,
model number, manufacturer, country of origin, package quantity, battery
capacity, voltage, power, age restriction, recyclability, and warranty.
Registry knowledge never makes a fact verified.

## Phase 2C — Reviewed policy drift watcher

Add a safe Policy Watch intake workflow for versioned policy snapshots. This is
not an uncontrolled scraper.

1. Track platform, market, source URL, last checked time, HTTP status,
   ETag/Last-Modified, normalized content hash, and current snapshot hash.
2. Fetch only from an explicit hostname allowlist.
3. Reject redirects to non-allowlisted hosts.
4. Block private, loopback, link-local, metadata, and internal addresses after
   DNS resolution and on every redirect.
5. Enforce response-size and timeout limits.
6. Changed content creates a `candidate` record only. It must never activate a
   policy automatically.
7. Show the source change, previous rule, candidate rule, source excerpt,
   retrieval time, and confidence.
8. Require human approval before writing or activating a snapshot.
9. Label model interpretations as model-assisted. Deterministic policy diff and
   impact logic remains authoritative.
10. Parsing failure creates an evidence record and never overwrites rules.
11. Provide a manual `检查更新` action. A scheduler, if added, may only enqueue
    checks and never approve or activate candidates.
12. Mocked-network tests cover unchanged ETag, changed content, redirect
    rejection, private-IP rejection, oversized responses, timeout, parse
    failure, and candidate approval. Automated tests never call live platforms.

## Phase 2D — Confirmed Agent domain actions

Extend the Agent with typed allow-listed operations:

- `validate_listing`
- `inspect_image`
- `open_release_passport`
- `build_release_passport`
- `export_release_package`
- `analyze_policy_impact`
- `build_migration_candidate`
- `open_evidence_source`
- `analyze_feedback`
- `create_experiment`

Requirements:

1. Do not expose arbitrary endpoint, URL, HTTP method, filesystem path, or shell
   command selection to the model.
2. Validate every operation in both frontend and backend.
3. Read-only operations may run after plan approval.
4. Approval, migration application, package export, and paid media generation
   require an additional explicit confirmation.
5. Publishing remains unsupported.
6. Status and progress come from actual operation results.
7. Execution traces show requested action, data read, validation performed,
   confirmation, and real result, but never hidden chain-of-thought.
8. Plans remain bounded, previewable, safe to retry, and transactional where
   state changes.
9. Use idempotency identifiers so retries cannot duplicate expensive or
   state-changing operations.
10. Test injection, malformed operations, duplicate requests, cancellation,
    partial failure, idempotent retry, and second-confirmation enforcement.

## Phase 2E — Post-launch Feedback Lab

Add a dedicated `反馈实验室` panel that imports performance data and creates
reviewable candidate revisions. It is not a live marketplace integration unless
real credentials and an official API are explicitly configured.

Inputs may be CSV/XLSX rows containing SKU, platform, listing revision, date
range, impressions, clicks, CTR, add-to-cart, purchases, CVR, revenue, returns,
optional return reason, and optional review/rating text.

1. Provide a downloadable import template.
2. Validate each row independently and preserve valid rows when others fail.
3. Associate every metric with an exact listing revision.
4. Report sample sizes and time windows for comparisons.
5. Calculate metrics deterministically and show missing-data warnings.
6. Never claim causality from correlation or fabricate uplift predictions.
7. Compare revision A/B, platform/platform, and before/after.
8. Detect high-impression/low-CTR, acceptable-CTR/low-CVR, elevated return rate,
   and repeated review/return themes.
9. Suggestions become candidate changes, never live edits.
10. Each candidate shows observed signal, supporting rows, affected field,
    proposed change, confidence, and risks.
11. Candidates enter the existing review, validation, evidence, approval, and
    rollback lifecycle without overwriting an approved revision.
12. Add an Experiment entity with hypothesis, baseline revision, candidate
    revision, changed fields, start/end dates, primary metric, guardrail metrics,
    and state.
13. Model summaries must retain source rows and quote references.
14. Tests use local fixtures only.
15. Keep analytics in the dedicated panel; place only concise candidate nodes
    on the canvas.

## Phase 2F — Verifiable storyboard and content package

Expand the current one-call video node into an editable, verifiable storyboard
workflow.

1. Each shot contains start/end time, duration, visual instruction, approved
   source facts, source image, overlay text, narration, and platform.
2. Default 15-second structure: hook, product demonstration, evidence-backed
   benefit, closing frame.
3. Users can reorder, add, remove, and edit shots.
4. Validate total duration and display the exact expected model-call count
   before generation.
5. Multiple paid generation calls require explicit confirmation.
6. Each shot has independent status and retry. Retrying one failed shot must not
   regenerate successful shots.
7. Persist provider task IDs safely without exposing secrets.
8. Cancellation stops polling and prevents stale results from overwriting the
   active run.
9. Generate WebVTT or SRT subtitles from approved overlay/narration text.
10. Add optional TTS only through a documented, configured provider adapter. If
    unavailable, export narration text and subtitles.
11. Never claim clips are merged unless a real composition step produced a
    playable final file.
12. If FFmpeg composition is implemented, validate inputs, build a fixed
    argument array without shell interpolation, enforce file/duration limits,
    and validate the playable result.
13. Produce a Content Package containing `storyboard.json`, captions, narration,
    generated clips, final video only when composed, and a generation manifest.
14. Progress must be real and per-shot, such as “shot 2/4 generating”; no fake
    percentages or timer-based completion.
15. Include the content package in the Release Passport.
16. Existing `audio` and `cameraMode` fields must become real inputs or be
    removed from the visible contract.

## Phase 2G — Localization boundaries

1. Add source language, target market, target language, currency, and
   measurement system to project settings.
2. Preserve original facts and normalized units.
3. Unit conversion must be deterministic and traceable.
4. Markets without an active policy snapshot show `政策未覆盖，需人工复核`.
5. Never reuse US rules and label them as another market.
6. Support localization metadata for US English, UK English, German, French,
   and Japanese.
7. Only US policy checks may be marked verified until real snapshots for other
   markets exist.
8. Test conversions, missing policy coverage, locale persistence, and prompt
   boundaries.

## Cross-feature architecture and persistence

Use one lifecycle:

`SKU Source → Extracted Facts → Human-Approved Facts → Platform Drafts →
Visual/Policy/Evidence Validation → Human-Approved Revision → Release Passport
→ Handoff Package → Imported Feedback → Candidate Revision → Revalidation →
Approval or Rollback`

Do not create disconnected demo panels or duplicate business logic. Reuse fact
IDs, policy snapshots, the evidence gate, migration impact engine, candidate
patches, revision history, Agent confirmation flow, `ExecutionGraph`, and
existing API error handling. All visible counts and states come from records.

Define versioned schemas for projects, listing revisions, approvals, visual
inspections, release passports, policy checks/candidates, feedback imports,
experiments, storyboards, and media tasks. Important state must not remain only
in React memory. Browser-local persistence is allowed only if labelled local,
versioned, refresh-safe, exportable/importable, free of credentials, and able to
recover its last valid snapshot. Keep backend evidence outside release dirs.
Do not introduce a database unless it reduces complexity and includes migration
and backup instructions.

## Final acceptance

Add an end-to-end golden path that exercises real application logic while
mocking external providers only at the network boundary:

1. Create a SKU and upload a product image plus specification evidence.
2. Extract, correct, and approve facts.
3. Generate three platform listings and platform-specific images.
4. Run policy, evidence, and pixel inspections.
5. Edit a title, show the field diff, revalidate, and approve the revision.
6. Create a four-shot storyboard and generate safely mocked provider clips.
7. Build a Release Passport, export the ZIP, and inspect its contents.
8. Refresh and confirm project recovery.
9. Import performance feedback and create an improvement candidate.
10. Confirm the approved revision was not overwritten, then roll back and
    verify exact restoration.

Also provide a manual real-provider smoke script, used only when credentials are
configured, for one text, one image, and one video request. It must never print
credentials and must not assume OCR is configured.

## Delivery rules

- Do not weaken safety checks to satisfy tests.
- Do not mark placeholder results as real or fabricate live data, marketplace
  acceptance, OCR, progress, compliance, or provider capability.
- Never silently fall back from a real inspection to pass.
- Document production impact of optional heavy dependencies.
- Do not commit generated media, uploads, databases, secrets, browser profiles,
  screenshots, or test videos.
- Preserve usability at 1440px and 1280px and the current dark design language.
- Opening or closing panels must not move the canvas.
- Do not deploy.

The final report must list, per commit: hash, implemented capabilities, exact
test commands/counts, real versus mocked portions, optional dependencies,
remaining limitations, and provider features that could not be implemented
honestly.
