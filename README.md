# AquaGuard AI Pool Safety

An experimental iPhone-first camera and pose-detection MVP built from the supplied Google Stitch project and AquaGuard product roadmap.

## Included

- Live rear-camera monitor using `getUserMedia`
- Google MediaPipe on-device pose detection and video-mode landmark tracking for up to four people
- Experimental pool-entry and loss-of-pose risk state machine
- Live-view draggable pool-boundary calibration saved on the device
- Actual local audible alarm, vibration where supported, app badge, and installed-app notification banner
- User-confirmed handoff to the Phone app for an emergency call; AquaGuard never places a call automatically
- Four-step interactive first-run guide covering supervision, phone placement, camera permission, calibration, and alerts
- Local snapshots, system checks, sample activity history, and on-device settings
- Installable web-app metadata, home-screen icons, and an offline app shell
- iPhone and Pixel preview shells supplied by the mobile-app runtime
- Original Stitch HTML and downloaded assets in `stitch-source/` and `public/assets/aquaguard/`
- Visual comparison evidence and QA report in `qa/` and `design-qa.md`

## Run locally

```bash
pnpm install
pnpm dev
```

Open `http://localhost:4173/` when using the current preview command, or the Vite URL printed by `pnpm dev`.

## Try it on an iPhone

1. Open the deployed AquaGuard URL in Safari.
2. Tap **Share**.
3. Choose **Add to Home Screen**.
4. Open AquaGuard from the new home-screen icon.
5. Complete the four setup steps shown after first launch.

The guide is saved on that device after completion. To see it again, open **Settings** in AquaGuard and tap **Replay setup guide**.

## First-time setup flow

1. Read the supervision warning and start the two-minute setup.
2. Put the phone on a stable tripod, show the full pool, connect power, and confirm the view.
3. Allow rear-camera access, then drag the four points around the live water surface.
4. Confirm the zone and keep the live monitor open while testing.

Use **Test Alarm** to verify the local siren and emergency screen before any poolside trial. **Device alert banners** can be enabled from Settings after the app is installed to the Home Screen.

## Verification

- Mobile runtime integrity check: passed
- TypeScript check: passed
- Production Vite build: passed
- Sites worker tests: 4/4 passed
- Core onboarding and guarded emergency handoff interactions: passed
- Live camera start/stop, one-person pose detection, live calibration, and persisted calibrated state: passed in the local browser test
- Original Stitch visual-fidelity QA: passed before the camera-MVP controls were added

## Production boundary

The camera, pose landmark detection, local alarm, notification permission, snapshots, calibration storage, and Phone handoff are functional web capabilities. Risk assessment is an unvalidated heuristic: it estimates entry from calibrated polygon position and escalates when a previously-in-pool pose disappears. It is not a trained drowning detector and will produce false positives and false negatives.

The app must remain open, visible, powered, and pointed at the pool. iOS can pause camera processing when the web app is backgrounded or the phone is locked. Remote contact push, automatic emergency calling, a trained temporal model, account-backed event storage, React Native/Swift integration, and certified safety validation are not included.

A production iOS build should keep the UI and state model in React Native while moving frame acquisition, Vision requests, tracking, feature extraction, and Core ML inference into a Swift native module. Pool-safety claims should remain limited until the system has been validated against the target dangerous-event recall, false-alarm, and latency metrics.
