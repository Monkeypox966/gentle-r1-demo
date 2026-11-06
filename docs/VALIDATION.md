# Browser verification

2026-11-06, production build under `/gentle-r1-demo/`. See [machine-readable results](validation-local.json).

- Independent Python deployment oracle: eight 392-dimensional observation cases, action-filter history and all four 200 Hz substeps. Observation tolerance 2e-6; filter tolerance 1e-11.
- Browser ONNX versus Python ONNX: eight observations; maximum absolute action error 1.669e-6 (acceptance threshold 1e-5). The same frozen ONNX is used in both runtimes.
- Six closed-loop cases: stand, raise and reach, each without and with wrist springs, 10 simulated seconds each. Each performs 500 policy inferences / 2,000 physics steps. All completed with no guard fault and final floating-base height above 0.4 m. These are synthetic-reference functional checks, not a training benchmark.
- External-force input, actual mesh mouse picking/drag, force release, pause/reset, reference overlay, force-condition UI, method dialog and 390 px mobile overflow are exercised by Playwright.
- Every policy/model/reference asset is SHA256-checked in unit tests. Runtime also verifies the downloaded ONNX hash.
- No browser exceptions or HTTP errors are accepted. CI repeats the full acceptance before deployment and saves evidence for 14 days.
- CI uses the Google Chrome already installed in the pinned Ubuntu 24.04 GitHub runner image (`PLAYWRIGHT_CHANNEL=chrome`); local tests default to Playwright's managed Chromium headless shell. Both use CPU SwiftShader.

Host verification uses Chromium headless with SwiftShader (CPU rendering), two CPU cores excluding CPU1, 6 GiB hard memory limit, no swap, and the training simulator lock. Initial six-case run peaked at 1.2 GiB. Real-time speed depends on the visitor's browser and hardware; the fixed simulation time steps never change.

Limits: the demo exposes the existing frozen student's response, including imperfect compliance. The 5–15 N input is a learned condition; it is not a contact-force bound. Root stability in six synthetic clips does not establish general motion quality, human-contact safety, hardware readiness, or reproduce the broader frozen evaluation. Original training code/configuration/checkpoint bytes remain unchanged.
