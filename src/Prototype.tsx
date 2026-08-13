import { useEffect, useRef, useState } from "react";
import type { PoseLandmarker as PoseLandmarkerType } from "@mediapipe/tasks-vision";
import {
  ActivityLogIcon,
  ArrowLeftIcon,
  BellIcon,
  CameraIcon,
  CheckCircledIcon,
  ClockIcon,
  Cross1Icon,
  Crosshair2Icon,
  ExclamationTriangleIcon,
  EyeOpenIcon,
  GearIcon,
  InfoCircledIcon,
  LockClosedIcon,
  PersonIcon,
  QuestionMarkCircledIcon,
  ResetIcon,
  SewingPinIcon,
  SpeakerLoudIcon,
  StopwatchIcon,
  TargetIcon,
  VideoIcon,
} from "@radix-ui/react-icons";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import { MobileScroll } from "./mobile";

type Tab = "monitor" | "activity" | "setup" | "settings";
type RiskState = "outside" | "edge" | "entry" | "suspicious" | "critical";
type CameraState = "idle" | "starting" | "live" | "error";
type PoolPoint = { x: number; y: number };

const defaultPoolPoints: PoolPoint[] = [
  { x: 10, y: 20 },
  { x: 90, y: 15 },
  { x: 85, y: 80 },
  { x: 15, y: 85 },
];

function pointInPolygon(point: PoolPoint, polygon: PoolPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y || 0.0001) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: PoolPoint, start: PoolPoint, end: PoolPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const position = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + position * dx), point.y - (start.y + position * dy));
}

function distanceToPolygon(point: PoolPoint, polygon: PoolPoint[]) {
  return Math.min(...polygon.map((start, index) => distanceToSegment(point, start, polygon[(index + 1) % polygon.length])));
}

const riskContent: Record<RiskState, { label: string; caption: string; tone: string }> = {
  outside: { label: "Outside pool", caption: "No people inside the safety zone", tone: "safe" },
  edge: { label: "Near edge", caption: "Tracking movement with increased sensitivity", tone: "watch" },
  entry: { label: "Pool entry", caption: "Temporal risk window started", tone: "watch" },
  suspicious: { label: "Suspicious", caption: "Head visibility and motion are being checked", tone: "warning" },
  critical: { label: "Critical", caption: "Persistent submersion threshold reached", tone: "critical" },
};

const navItems = [
  { id: "monitor" as const, label: "Monitor", Icon: EyeOpenIcon },
  { id: "activity" as const, label: "Activity", Icon: ClockIcon },
  { id: "setup" as const, label: "Setup", Icon: TargetIcon },
  { id: "settings" as const, label: "Settings", Icon: GearIcon },
];

export default function Prototype() {
  const [tab, setTab] = useState<Tab>("monitor");
  const [risk, setRisk] = useState<RiskState>("outside");
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [calibrated, setCalibrated] = useState(() => {
    try {
      return window.localStorage.getItem("aquaguard-calibrated-v1") === "true";
    } catch {
      return false;
    }
  });
  const [moreEvents, setMoreEvents] = useState(false);
  const [localProcessing, setLocalProcessing] = useState(true);
  const [remoteAlerts, setRemoteAlerts] = useState(() => "Notification" in window && Notification.permission === "granted");
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    try {
      return window.localStorage.getItem("aquaguard-onboarding-v1") !== "complete";
    } catch {
      return true;
    }
  });
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [mountConfirmed, setMountConfirmed] = useState(false);
  const [resumeOnboardingAfterCalibration, setResumeOnboardingAfterCalibration] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState("");
  const [poolPoints, setPoolPoints] = useState<PoolPoint[]>(() => {
    try {
      const saved = window.localStorage.getItem("aquaguard-pool-points-v1");
      return saved ? JSON.parse(saved) as PoolPoint[] : defaultPoolPoints;
    } catch {
      return defaultPoolPoints;
    }
  });
  const [incidentImage, setIncidentImage] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const alarmTimerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2300);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const phoneScreen = document.querySelector<HTMLElement>("[data-phone-screen]");
    if (phoneScreen) phoneScreen.scrollTop = 0;
  }, [tab, emergencyOpen, onboardingStep]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => () => {
    cameraStream?.getTracks().forEach((track) => track.stop());
    if (alarmTimerRef.current !== null) window.clearInterval(alarmTimerRef.current);
    void wakeLockRef.current?.release();
  }, [cameraStream]);

  const primeAlarmAudio = () => {
    const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    if (!audioContextRef.current) audioContextRef.current = new AudioContextConstructor();
    void audioContextRef.current.resume();
  };

  const startCamera = async () => {
    if (cameraStream?.active) return true;
    primeAlarmAudio();
    setCameraState("starting");
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("error");
      setCameraError("Camera access requires Safari or another modern browser over HTTPS.");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
        audio: false,
      });
      setCameraStream(stream);
      setCameraState("live");
      try {
        const wakeLockNavigator = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
        wakeLockRef.current = await wakeLockNavigator.wakeLock?.request("screen") ?? null;
      } catch {
        wakeLockRef.current = null;
      }
      return true;
    } catch (error) {
      setCameraState("error");
      setCameraError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Camera permission was not granted. Allow camera access in Safari settings and try again."
        : "The camera could not start. Close other camera apps and try again.");
      return false;
    }
  };

  const stopCamera = () => {
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCameraState("idle");
    setRisk("outside");
    void wakeLockRef.current?.release();
    wakeLockRef.current = null;
  };

  const stopAlarmFeedback = () => {
    if (alarmTimerRef.current !== null) window.clearInterval(alarmTimerRef.current);
    alarmTimerRef.current = null;
    navigator.vibrate?.(0);
    const badgeNavigator = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    void badgeNavigator.clearAppBadge?.();
  };

  const startAlarmFeedback = () => {
    stopAlarmFeedback();
    primeAlarmAudio();
    const beep = () => {
      const context = audioContextRef.current;
      if (!context || context.state !== "running") return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "square";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.35, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.38);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.4);
    };
    beep();
    alarmTimerRef.current = window.setInterval(beep, 650);
    window.setTimeout(stopAlarmFeedback, 15000);
    navigator.vibrate?.([700, 180, 700, 180, 1100]);
    const badgeNavigator = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void> };
    void badgeNavigator.setAppBadge?.(1);
    if (remoteAlerts && "Notification" in window && Notification.permission === "granted" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.ready.then((registration) => registration.showNotification("AquaGuard critical alert", {
        body: "Possible persistent submersion detected. Verify the pool immediately.",
        icon: "/icons/aquaguard-192.png",
        tag: "aquaguard-critical",
        requireInteraction: true,
      }));
    }
  };

  const chooseTab = (next: Tab) => {
    setTab(next);
    if (next !== "setup") setEmergencyOpen(false);
  };

  const triggerEmergency = (capture?: string) => {
    setToast("");
    setRisk("critical");
    setIncidentImage(capture ?? null);
    setEmergencyOpen(true);
    startAlarmFeedback();
  };

  const dismissEmergency = () => {
    stopAlarmFeedback();
    setEmergencyOpen(false);
    setRisk("outside");
    setTab("monitor");
    setToast("Alert dismissed and added to Activity History");
  };

  const finishOnboarding = () => {
    try {
      window.localStorage.setItem("aquaguard-onboarding-v1", "complete");
    } catch {
      // The guide still completes when browser storage is unavailable.
    }
    setOnboardingOpen(false);
    setOnboardingStep(0);
    setMountConfirmed(false);
    setTab("monitor");
    setToast("Setup complete — monitoring demo is ready");
  };

  const replayOnboarding = () => {
    setOnboardingStep(0);
    setMountConfirmed(false);
    setOnboardingOpen(true);
    setTab("monitor");
  };

  const requestDeviceNotifications = async () => {
    if (!("Notification" in window)) {
      setToast("Notifications are unavailable in this browser. Add AquaGuard to your Home Screen and try again.");
      return;
    }
    if (Notification.permission === "denied") {
      setToast("Notifications are blocked. Enable them for AquaGuard in iPhone Settings.");
      return;
    }
    const permission = await Notification.requestPermission();
    setRemoteAlerts(permission === "granted");
    setToast(permission === "granted" ? "Device alerts enabled" : "Notification permission was not enabled");
  };

  if (tab === "setup") {
    return (
      <CalibrationScreen
        cameraStream={cameraStream}
        initialPoints={poolPoints}
        onBack={() => setTab("monitor")}
        onConfirm={(points) => {
          setCalibrated(true);
          setPoolPoints(points);
          try {
            window.localStorage.setItem("aquaguard-calibrated-v1", "true");
            window.localStorage.setItem("aquaguard-pool-points-v1", JSON.stringify(points));
          } catch {
            // Calibration remains available for the current session.
          }
          setTab("monitor");
          if (resumeOnboardingAfterCalibration) {
            setResumeOnboardingAfterCalibration(false);
            setOnboardingStep(3);
            setOnboardingOpen(true);
          } else {
            setToast("Safety zone calibrated — monitoring is ready");
          }
        }}
      />
    );
  }

  return (
    <div className="aquaguard-shell" data-testid="aquaguard-app">
      <AppHeader />

      <MobileScroll className="aquaguard-page">
        {tab === "monitor" && (
          <MonitorScreen
            risk={risk}
            calibrated={calibrated}
            cameraStream={cameraStream}
            cameraState={cameraState}
            cameraError={cameraError}
            poolPoints={poolPoints}
            localProcessing={localProcessing}
            onStartCamera={startCamera}
            onStopCamera={stopCamera}
            onRiskChange={(next) => {
              setRisk(next);
              if (next === "critical") triggerEmergency();
            }}
            onSnapshot={() => setToast("Live snapshot saved locally")}
            onAlarm={triggerEmergency}
            onCalibrate={() => {
              if (cameraStream?.active) {
                setTab("setup");
              } else {
                void startCamera().then((started) => {
                  if (started) setTab("setup");
                });
              }
            }}
          />
        )}
        {tab === "activity" && (
          <ActivityScreen moreEvents={moreEvents} onLoadMore={() => setMoreEvents((value) => !value)} />
        )}
        {tab === "settings" && (
          <SettingsScreen
            localProcessing={localProcessing}
            remoteAlerts={remoteAlerts}
            onLocalProcessing={() => setLocalProcessing((value) => !value)}
            onRemoteAlerts={() => {
              if (remoteAlerts) {
                setRemoteAlerts(false);
                setToast("Device alert banners paused");
              } else {
                void requestDeviceNotifications();
              }
            }}
            onToast={setToast}
            onReplayOnboarding={replayOnboarding}
          />
        )}
      </MobileScroll>

      <BottomNav active={tab} onChange={chooseTab} />
      {toast && <div className="app-toast" role="status">{toast}</div>}
      {emergencyOpen && (
        <EmergencyScreen
          incidentImage={incidentImage}
          onDismiss={dismissEmergency}
        />
      )}
      {onboardingOpen && (
        <OnboardingGuide
          step={onboardingStep}
          mountConfirmed={mountConfirmed}
          onMountConfirmed={() => setMountConfirmed((value) => !value)}
          onBack={() => setOnboardingStep((value) => Math.max(0, value - 1))}
          onNext={() => setOnboardingStep((value) => Math.min(3, value + 1))}
          onCalibrate={() => {
            void startCamera().then((started) => {
              if (!started) return;
              setOnboardingOpen(false);
              setResumeOnboardingAfterCalibration(true);
              setTab("setup");
            });
          }}
          cameraState={cameraState}
          cameraError={cameraError}
          alertsEnabled={remoteAlerts}
          onEnableAlerts={() => void requestDeviceNotifications()}
          onFinish={finishOnboarding}
        />
      )}
    </div>
  );
}

function OnboardingGuide({
  step,
  mountConfirmed,
  onMountConfirmed,
  onBack,
  onNext,
  onCalibrate,
  onFinish,
  cameraState,
  cameraError,
  alertsEnabled,
  onEnableAlerts,
}: {
  step: number;
  mountConfirmed: boolean;
  onMountConfirmed: () => void;
  onBack: () => void;
  onNext: () => void;
  onCalibrate: () => void;
  onFinish: () => void;
  cameraState: CameraState;
  cameraError: string;
  alertsEnabled: boolean;
  onEnableAlerts: () => void;
}) {
  const action = step === 0
    ? <button className="button button-primary onboarding-primary" onClick={onNext}>Start 2-minute setup</button>
    : step === 1
      ? <button className="button button-primary onboarding-primary" disabled={!mountConfirmed} onClick={onNext}>Continue</button>
      : step === 2
        ? <button className="button button-primary onboarding-primary" disabled={cameraState === "starting"} onClick={onCalibrate}><VideoIcon />{cameraState === "starting" ? "Starting camera…" : "Start camera & calibrate"}</button>
        : <button className="button button-primary onboarding-primary" onClick={onFinish}><CheckCircledIcon />Open live monitor</button>;

  return (
    <section className="onboarding-screen" role="dialog" aria-modal="true" aria-label="AquaGuard first-time setup">
      <header className="onboarding-header">
        <div className="brand-lockup"><span className="brand-mark"><ActivityLogIcon /></span><span>AquaGuard AI</span></div>
        <span>Step {step + 1} of 4</span>
      </header>
      <div className="onboarding-progress" aria-label={`Setup progress: step ${step + 1} of 4`}>
        {[0, 1, 2, 3].map((index) => <span key={index} className={index <= step ? "active" : ""} />)}
      </div>

      <div className="onboarding-body">
        {step === 0 && (
          <>
            <span className="onboarding-hero-icon"><EyeOpenIcon /></span>
            <span className="eyebrow">WELCOME</span>
            <h1>Turn this phone into an extra set of eyes</h1>
            <p>We’ll help you position the camera, outline the pool, and understand alerts.</p>
            <div className="onboarding-feature-grid">
              <span><VideoIcon /><strong>Monitor</strong></span>
              <span><BellIcon /><strong>Alert</strong></span>
              <span><ClockIcon /><strong>Review</strong></span>
            </div>
            <div className="onboarding-safety-note"><InfoCircledIcon /><p><strong>Always supervise swimmers.</strong><br />AquaGuard is an additional safety layer, not a replacement for an adult or certified safety equipment.</p></div>
          </>
        )}

        {step === 1 && (
          <>
            <span className="eyebrow">POSITION THE PHONE</span>
            <h1>Give the camera a clear, stable view</h1>
            <p>Place your iPhone before starting a monitoring session.</p>
            <div className="mount-preview"><img src="/assets/aquaguard/live-camera-2.jpg" alt="Example of a clear full-pool camera view" draggable={false} /><span>Good camera view</span></div>
            <ol className="setup-list">
              <li><strong>Use a stable tripod</strong><small>Keep the phone still and protected from water.</small></li>
              <li><strong>Show the whole water surface</strong><small>Include the pool edge and remove visual obstructions.</small></li>
              <li><strong>Connect power</strong><small>Keep AquaGuard open during the session.</small></li>
            </ol>
            <button className={`mount-check ${mountConfirmed ? "checked" : ""}`} aria-pressed={mountConfirmed} onClick={onMountConfirmed}>
              <span>{mountConfirmed && <CheckCircledIcon />}</span>I have a stable, clear pool view
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <span className="eyebrow">DEFINE THE POOL</span>
            <h1>Allow the camera, then outline the water</h1>
            <p>Your video stays on this device. After you allow access, drag four points around the live pool view.</p>
            <div className="zone-guide-card">
              <img src="/assets/aquaguard/calibration-pool.jpg" alt="Example pool boundary calibration" draggable={false} />
              <div className="zone-guide-outline" />
              <span><Crosshair2Icon /> Cover the complete pool</span>
            </div>
            <p className="onboarding-tip"><InfoCircledIcon />You can reset the corners if the outline does not look right.</p>
            {cameraError && <p className="camera-error"><ExclamationTriangleIcon />{cameraError}</p>}
          </>
        )}

        {step === 3 && (
          <>
            <span className="onboarding-hero-icon success"><CheckCircledIcon /></span>
            <span className="eyebrow">SETUP COMPLETE</span>
            <h1>You’re ready to try live monitoring</h1>
            <p>The monitor now uses this phone’s camera and runs pose detection locally while the app stays open.</p>
            <div className="ready-list">
              <span><CheckCircledIcon /><strong>Phone position confirmed</strong></span>
              <span><CheckCircledIcon /><strong>Pool boundary saved</strong></span>
              <span><CheckCircledIcon /><strong>Local alarm ready to try</strong></span>
            </div>
            <button className={`mount-check onboarding-alert-toggle ${alertsEnabled ? "checked" : ""}`} aria-pressed={alertsEnabled} onClick={onEnableAlerts}>
              <span>{alertsEnabled ? <CheckCircledIcon /> : <BellIcon />}</span>{alertsEnabled ? "Device alert banners enabled" : "Enable device alert banners"}
            </button>
            <p className="onboarding-tip"><InfoCircledIcon />On iPhone, notifications require AquaGuard to be added to the Home Screen.</p>
            <div className="onboarding-demo-note"><BellIcon /><p><strong>Experimental safety preview.</strong><br />Camera and pose detection are live, but risk classification is not certified. Keep supervising swimmers at all times.</p></div>
          </>
        )}
      </div>

      <footer className="onboarding-footer">
        {step > 0 && step < 3 && <button className="button button-secondary onboarding-back" onClick={onBack}><ArrowLeftIcon />Back</button>}
        {action}
      </footer>
    </section>
  );
}

function AppHeader() {
  return (
    <header className="app-header">
      <div className="brand-lockup" aria-label="AquaGuard AI">
        <span className="brand-mark"><ActivityLogIcon /></span>
        <span>AquaGuard AI</span>
      </div>
      <button className="profile-button" aria-label="Open account profile">
        <img src="/assets/aquaguard/history-event.jpg" alt="Account profile" draggable={false} />
      </button>
    </header>
  );
}

function MonitorScreen({
  risk,
  calibrated,
  cameraStream,
  cameraState,
  cameraError,
  poolPoints,
  localProcessing,
  onStartCamera,
  onStopCamera,
  onRiskChange,
  onSnapshot,
  onAlarm,
  onCalibrate,
}: {
  risk: RiskState;
  calibrated: boolean;
  cameraStream: MediaStream | null;
  cameraState: CameraState;
  cameraError: string;
  poolPoints: PoolPoint[];
  localProcessing: boolean;
  onStartCamera: () => Promise<boolean>;
  onStopCamera: () => void;
  onRiskChange: (risk: RiskState) => void;
  onSnapshot: () => void;
  onAlarm: (capture?: string) => void;
  onCalibrate: () => void;
}) {
  const current = riskContent[risk];
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const detectorRef = useRef<PoseLandmarkerType | null>(null);
  const poseConnectionsRef = useRef<Array<{ start: number; end: number }>>([]);
  const lastVideoTimeRef = useRef(-1);
  const lastAnalysisRef = useRef(0);
  const lastInsideRef = useRef(false);
  const missingInsideSinceRef = useRef<number | null>(null);
  const lowHeadSinceRef = useRef<number | null>(null);
  const reportedRiskRef = useRef<RiskState>("outside");
  const onRiskChangeRef = useRef(onRiskChange);
  const onAlarmRef = useRef(onAlarm);
  const [modelState, setModelState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [peopleCount, setPeopleCount] = useState(0);

  useEffect(() => { onRiskChangeRef.current = onRiskChange; }, [onRiskChange]);
  useEffect(() => { onAlarmRef.current = onAlarm; }, [onAlarm]);
  useEffect(() => () => {
    detectorRef.current?.close();
    detectorRef.current = null;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraStream) return;
    video.srcObject = cameraStream;
    void video.play().catch(() => undefined);
  }, [cameraStream]);

  useEffect(() => {
    if (!cameraStream || detectorRef.current) return;
    let cancelled = false;
    setModelState("loading");
    void (async () => {
      try {
        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
        const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm");
        const detector = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
          },
          runningMode: "VIDEO",
          numPoses: 4,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
          outputSegmentationMasks: false,
        });
        if (cancelled) {
          detector.close();
          return;
        }
        detectorRef.current = detector;
        poseConnectionsRef.current = PoseLandmarker.POSE_CONNECTIONS;
        setModelState("ready");
      } catch {
        setModelState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [cameraStream]);

  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.86);
  };

  const saveSnapshot = () => {
    const image = captureFrame();
    if (!image) return;
    const download = document.createElement("a");
    download.href = image;
    download.download = `aquaguard-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    download.click();
    onSnapshot();
  };

  useEffect(() => {
    if (!cameraStream || modelState !== "ready" || !localProcessing) return;
    let animationFrame = 0;
    let stopped = false;

    const reportRisk = (next: RiskState, captureOnCritical = false) => {
      if (reportedRiskRef.current === next) return;
      reportedRiskRef.current = next;
      onRiskChangeRef.current(next);
      if (next === "critical" && captureOnCritical) onAlarmRef.current(captureFrame());
    };

    const drawAndAnalyze = (timestamp: number) => {
      if (stopped) return;
      animationFrame = window.requestAnimationFrame(drawAndAnalyze);
      const video = videoRef.current;
      const canvas = overlayRef.current;
      const detector = detectorRef.current;
      if (!video || !canvas || !detector || video.readyState < 2 || video.currentTime === lastVideoTimeRef.current || timestamp - lastAnalysisRef.current < 180) return;
      lastVideoTimeRef.current = video.currentTime;
      lastAnalysisRef.current = timestamp;

      try {
        const result = detector.detectForVideo(video, timestamp);
        const poses = result.landmarks;
        setPeopleCount(poses.length);
        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
        canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.clearRect(0, 0, cssWidth, cssHeight);
        const coverScale = Math.max(cssWidth / video.videoWidth, cssHeight / video.videoHeight);
        const offsetX = (cssWidth - video.videoWidth * coverScale) / 2;
        const offsetY = (cssHeight - video.videoHeight * coverScale) / 2;
        const mapPoint = (point: { x: number; y: number }) => ({
          x: offsetX + point.x * video.videoWidth * coverScale,
          y: offsetY + point.y * video.videoHeight * coverScale,
        });

        poses.forEach((pose, poseIndex) => {
          context.strokeStyle = poseIndex === 0 ? "#007aff" : "#ff5a5f";
          context.fillStyle = context.strokeStyle;
          context.lineWidth = 2;
          poseConnectionsRef.current.forEach(({ start, end }) => {
            const first = pose[start];
            const second = pose[end];
            if (!first || !second || first.visibility < 0.45 || second.visibility < 0.45) return;
            const from = mapPoint(first);
            const to = mapPoint(second);
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.stroke();
          });
          pose.forEach((landmark) => {
            if (landmark.visibility < 0.55) return;
            const point = mapPoint(landmark);
            context.beginPath();
            context.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
            context.fill();
          });
          const visible = pose.filter((landmark) => landmark.visibility > 0.45);
          if (visible.length > 0) {
            const left = Math.min(...visible.map((point) => point.x));
            const right = Math.max(...visible.map((point) => point.x));
            const top = Math.min(...visible.map((point) => point.y));
            const bottom = Math.max(...visible.map((point) => point.y));
            const boxStart = mapPoint({ x: left, y: top });
            const boxEnd = mapPoint({ x: right, y: bottom });
            context.strokeRect(boxStart.x, boxStart.y, boxEnd.x - boxStart.x, boxEnd.y - boxStart.y);
            context.fillRect(boxStart.x, Math.max(0, boxStart.y - 20), 78, 20);
            context.fillStyle = "#ffffff";
            context.font = "600 11px Hanken Grotesk";
            context.fillText(`Person #${poseIndex + 1}`, boxStart.x + 7, Math.max(14, boxStart.y - 6));
          }
        });

        if (poses.length === 0) {
          if (lastInsideRef.current) {
            missingInsideSinceRef.current ??= timestamp;
            const missingFor = timestamp - missingInsideSinceRef.current;
            if (missingFor > 5500) reportRisk("critical", true);
            else if (missingFor > 2200) reportRisk("suspicious");
          } else {
            reportRisk("outside");
          }
          return;
        }

        missingInsideSinceRef.current = null;
        const primary = poses[0];
        const feet = [primary[27], primary[28]].filter((landmark) => landmark && landmark.visibility > 0.35);
        const rawAnchor = feet.length > 0
          ? { x: feet.reduce((sum, landmark) => sum + landmark.x, 0) / feet.length * 100, y: feet.reduce((sum, landmark) => sum + landmark.y, 0) / feet.length * 100 }
          : { x: (primary[23].x + primary[24].x) * 50, y: (primary[23].y + primary[24].y) * 50 };
        const anchor = {
          x: (offsetX + rawAnchor.x / 100 * video.videoWidth * coverScale) / cssWidth * 100,
          y: (offsetY + rawAnchor.y / 100 * video.videoHeight * coverScale) / cssHeight * 100,
        };
        const inside = calibrated && pointInPolygon(anchor, poolPoints);
        const nearEdge = calibrated && distanceToPolygon(anchor, poolPoints) < 8;
        const headVisibility = Math.max(primary[0]?.visibility ?? 0, primary[7]?.visibility ?? 0, primary[8]?.visibility ?? 0);

        if (inside) {
          if (!lastInsideRef.current) reportRisk("entry");
          else if (headVisibility < 0.3) {
            lowHeadSinceRef.current ??= timestamp;
            reportRisk(timestamp - lowHeadSinceRef.current > 3500 ? "suspicious" : "entry");
          } else {
            lowHeadSinceRef.current = null;
            reportRisk("entry");
          }
        } else if (nearEdge) {
          reportRisk("edge");
        } else {
          reportRisk("outside");
        }
        lastInsideRef.current = inside;
      } catch {
        setModelState("error");
      }
    };

    animationFrame = window.requestAnimationFrame(drawAndAnalyze);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [cameraStream, modelState, calibrated, poolPoints, localProcessing]);

  const monitorLabel = cameraState === "live"
    ? !localProcessing ? "Camera live • AI paused" : modelState === "ready" ? `${peopleCount} ${peopleCount === 1 ? "person" : "people"} detected` : modelState === "error" ? "Camera live • AI unavailable" : "Loading on-device AI…"
    : "Camera off";

  return (
    <main className="screen-content monitor-content" data-testid="monitor-screen">
      <div className="title-row">
        <h1>Live Monitor</h1>
        <span className={`armed-pill ${cameraState !== "live" ? "inactive" : ""}`}><span className="pulse-dot" />{cameraState === "live" ? "System Armed" : "Not Armed"}</span>
      </div>

      <section className="camera-card" aria-label="Live pool camera">
        <div className="camera-viewport live-camera-viewport">
          {cameraStream
            ? <video ref={videoRef} aria-label="Live rear camera view" autoPlay playsInline muted />
            : <img src="/assets/aquaguard/live-camera-2.jpg" alt="Example pool camera view" draggable={false} />}
          <canvas ref={overlayRef} className="pose-overlay" aria-hidden="true" />
          <span className="live-pill"><VideoIcon /> {monitorLabel}</span>
          {risk !== "outside" && <span className={`risk-overlay-label tone-${current.tone}`}>{current.label}</span>}
          {!cameraStream && (
            <div className="camera-start-panel">
              <span className="icon-disc black"><VideoIcon /></span>
              <strong>Use this phone’s rear camera</strong>
              <small>Video is processed locally and is not uploaded.</small>
              <button className="button button-primary" disabled={cameraState === "starting"} onClick={() => void onStartCamera()}>
                <VideoIcon />{cameraState === "starting" ? "Starting…" : "Start camera"}
              </button>
            </div>
          )}
        </div>
        {cameraError && <p className="camera-error"><ExclamationTriangleIcon />{cameraError}</p>}
        <div className="camera-actions">
          {cameraStream
            ? <button className="button button-secondary" onClick={saveSnapshot}><CameraIcon />Snapshot</button>
            : <button className="button button-secondary" onClick={() => void onStartCamera()}><VideoIcon />Camera</button>}
          <button className="button button-primary" onClick={() => onAlarm(captureFrame())}><SpeakerLoudIcon />Test Alarm</button>
        </div>
        {cameraStream && <button className="stop-monitoring-button" onClick={onStopCamera}>Stop camera monitoring</button>}
      </section>

      {!calibrated && (
        <button className="calibration-nudge" onClick={onCalibrate}>
          <span className="icon-disc blue"><Crosshair2Icon /></span>
          <span><strong>Calibrate the live pool view</strong><small>Outline the water before relying on entry-state testing.</small></span>
          <ArrowLeftIcon className="nudge-arrow" />
        </button>
      )}

      <section className="section-block">
        <div className="section-heading"><h2>Safety state</h2><span className={`state-dot ${current.tone}`} /></div>
        <div className="safety-state-card">
          <div className={`icon-disc state-${current.tone}`}><PersonIcon /></div>
          <div className="state-copy"><strong>{current.label}</strong><span>{current.caption}</span></div>
          <span className="latency-chip">Live</span>
        </div>
        <div className="scenario-controls" aria-label="Manual alert test controls">
          <button aria-pressed={risk === "outside"} onClick={() => onRiskChange("outside")}>Reset state</button>
          <button className="critical-scenario" aria-pressed={risk === "critical"} onClick={() => onAlarm(captureFrame())}>Test critical alert</button>
        </div>
      </section>

      <section className="section-block recent-section">
        <div className="section-heading"><h2>System checks</h2></div>
        <ActivityRow tone={cameraStream ? "red" : "gray"} Icon={VideoIcon} title={cameraStream ? "Rear Camera Active" : "Camera Not Started"} meta={cameraStream ? "Local video stream • Live" : "Tap Start camera to begin"} />
        <ActivityRow tone={modelState === "ready" ? "red" : "gray"} Icon={PersonIcon} title={modelState === "ready" ? "Pose Detection Active" : "Pose Model Waiting"} meta={modelState === "ready" ? `${peopleCount} detected in current frame` : "Loads after camera permission"} />
        <ActivityRow tone={calibrated ? "red" : "gray"} Icon={Crosshair2Icon} title={calibrated ? "Pool Zone Calibrated" : "Calibration Required"} meta={calibrated ? "Entry heuristic enabled" : "Outline the live water surface"} />
      </section>

      <p className="safety-disclaimer"><InfoCircledIcon />Experimental additional safety layer only. Keep the app open, keep the phone powered, and always supervise swimmers.</p>
    </main>
  );
}

function ActivityRow({ Icon, title, meta, tone }: { Icon: typeof PersonIcon; title: string; meta: string; tone: "red" | "gray" }) {
  return (
    <div className="activity-row">
      <span className={`icon-disc ${tone}`}><Icon /></span>
      <span><strong>{title}</strong><small>{meta}</small></span>
    </div>
  );
}

function ActivityScreen({ moreEvents, onLoadMore }: { moreEvents: boolean; onLoadMore: () => void }) {
  return (
    <main className="screen-content activity-content" data-testid="activity-screen">
      <h1>Activity History</h1>
      <p className="page-subtitle">Review recent events and system diagnostics.</p>
      <div className="timeline">
        <TimelineCard
          tone="critical"
          badge="Critical"
          time="Today, 2:14 PM"
          title="Submersion Risk Detected"
          body="Unusual movement pattern consistent with submersion identified in Deep End Zone B. Alert triggered immediately."
          Icon={ExclamationTriangleIcon}
        />
        <TimelineCard
          tone="warning"
          badge="Warning"
          time="Today, 11:30 AM"
          title="Edge Proximity Alert"
          body="Subject lingered near Shallow End edge for a prolonged period. No submersion was detected."
          Icon={BellIcon}
        />
        <TimelineCard
          tone="info"
          badge="Info"
          time="Yesterday, 4:00 AM"
          title="System diagnostic complete"
          body="Routine nightly scan finished successfully. All cameras and safety checks are operating normally."
          Icon={CheckCircledIcon}
        />
        {moreEvents && (
          <TimelineCard
            tone="info"
            badge="Info"
            time="Tuesday, 8:22 PM"
            title="Monitoring session ended"
            body="A 2h 36m monitoring session ended normally. Video was processed locally and was not uploaded."
            Icon={StopwatchIcon}
          />
        )}
      </div>
      <button className="button load-button" onClick={onLoadMore}>{moreEvents ? "Show recent only" : "Load previous"}</button>
    </main>
  );
}

function TimelineCard({
  tone,
  badge,
  time,
  title,
  body,
  Icon,
}: {
  tone: "critical" | "warning" | "info";
  badge: string;
  time: string;
  title: string;
  body: string;
  Icon: typeof PersonIcon;
}) {
  return (
    <article className={`timeline-item timeline-${tone}`}>
      <span className="timeline-dot" />
      <div className="timeline-card">
        <div className="timeline-meta"><span className="event-badge">{badge}</span><time>{time}</time></div>
        <div className="timeline-title-row"><h2>{title}</h2></div>
        <p>{body}</p>
        <span className="event-icon"><Icon /></span>
      </div>
    </article>
  );
}

function SettingsScreen({
  localProcessing,
  remoteAlerts,
  onLocalProcessing,
  onRemoteAlerts,
  onToast,
  onReplayOnboarding,
}: {
  localProcessing: boolean;
  remoteAlerts: boolean;
  onLocalProcessing: () => void;
  onRemoteAlerts: () => void;
  onToast: (message: string) => void;
  onReplayOnboarding: () => void;
}) {
  return (
    <main className="screen-content settings-content" data-testid="settings-screen">
      <span className="eyebrow">SYSTEM</span>
      <h1>Safety Settings</h1>
      <p className="page-subtitle">Tune how AquaGuard monitors and escalates events.</p>

      <section className="settings-card privacy-card">
        <span className="icon-disc black"><LockClosedIcon /></span>
        <div><h2>Privacy first</h2><p>Camera frames and pose landmarks are processed on this phone and are not uploaded.</p></div>
      </section>

      <section className="settings-group">
        <h2>Monitoring</h2>
        <SettingToggle icon={<ActivityLogIcon />} label="On-device pose detection" detail="Google MediaPipe • runs while app is open" value={localProcessing} onChange={onLocalProcessing} />
        <SettingToggle icon={<BellIcon />} label="Device alert banners" detail="Home Screen app notification permission" value={remoteAlerts} onChange={onRemoteAlerts} />
        <button className="settings-row" onClick={() => onToast("Experimental loss-of-pose threshold: 5.5 seconds")}>
          <span className="row-icon"><StopwatchIcon /></span><span><strong>Loss-of-pose threshold</strong><small>5.5 seconds • experimental</small></span><span className="row-value">Info</span>
        </button>
        <button className="settings-row" onClick={() => onToast("Camera target: 720p at 30 FPS")}>
          <span className="row-icon"><VideoIcon /></span><span><strong>Camera quality</strong><small>Up to 720p • 30 FPS</small></span><span className="row-value">Auto</span>
        </button>
      </section>

      <section className="settings-group">
        <h2>Emergency plan</h2>
        <button className="contact-row" onClick={() => onToast("Remote contact messaging needs a production alert service and is not enabled yet")}>
          <span className="contact-avatar"><BellIcon /></span><span><strong>Remote contacts</strong><small>Requires production push service</small></span><span className="row-value">Unavailable</span>
        </button>
      </section>

      <button className="button replay-guide-button" onClick={onReplayOnboarding}><InfoCircledIcon />Replay setup guide</button>
    </main>
  );
}

function SettingToggle({ icon, label, detail, value, onChange }: { icon: React.ReactNode; label: string; detail: string; value: boolean; onChange: () => void }) {
  return (
    <div className="settings-row">
      <span className="row-icon">{icon}</span><span><strong>{label}</strong><small>{detail}</small></span>
      <button className="toggle" role="switch" aria-checked={value} onClick={onChange}><span /></button>
    </div>
  );
}

function CalibrationScreen({
  cameraStream,
  initialPoints,
  onBack,
  onConfirm,
}: {
  cameraStream: MediaStream | null;
  initialPoints: PoolPoint[];
  onBack: () => void;
  onConfirm: (points: PoolPoint[]) => void;
}) {
  const [points, setPoints] = useState<PoolPoint[]>(initialPoints);
  const [active, setActive] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const polygon = `polygon(${points.map((point) => `${point.x}% ${point.y}%`).join(", ")})`;

  const reset = () => setPoints(defaultPoolPoints);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraStream) return;
    video.srcObject = cameraStream;
    void video.play().catch(() => undefined);
  }, [cameraStream]);

  const movePoint = (event: React.PointerEvent<HTMLDivElement>) => {
    if (active === null || !stageRef.current) return;
    const bounds = stageRef.current.getBoundingClientRect();
    const x = Math.max(6, Math.min(94, ((event.clientX - bounds.left) / bounds.width) * 100));
    const y = Math.max(6, Math.min(94, ((event.clientY - bounds.top) / bounds.height) * 100));
    setPoints((current) => current.map((point, index) => index === active ? { x, y } : point));
  };

  return (
    <div className="calibration-screen" data-testid="calibration-screen">
      <div className="calibration-stage">
        <div
          ref={stageRef}
          className="calibration-camera-frame"
          onPointerMove={movePoint}
          onPointerUp={() => setActive(null)}
          onPointerCancel={() => setActive(null)}
        >
          {cameraStream
            ? <video ref={videoRef} aria-label="Live camera view for pool calibration" autoPlay playsInline muted />
            : <img src="/assets/aquaguard/calibration-pool.jpg" alt="Example high-angle camera view of a pool" draggable={false} />}
          <div className="zone-fill" style={{ clipPath: polygon }} />
          <div className="zone-outline" style={{ clipPath: polygon }} />
          {points.map((point, index) => (
            <button
              key={index}
              className="drag-point"
              aria-label={`Pool boundary point ${index + 1}`}
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setActive(index);
              }}
            />
          ))}
          <span className="center-reticle"><Crosshair2Icon /></span>
        </div>
      </div>
      <header className="calibration-header">
        <button aria-label="Back to monitor" onClick={onBack}><ArrowLeftIcon /></button>
        <h1>Calibration</h1>
        <button aria-label="Calibration help"><QuestionMarkCircledIcon /></button>
      </header>
      <section className="calibration-sheet">
        <span className="sheet-grabber" />
        <div className="sheet-heading"><h2>Define Safety Zone</h2></div>
        <p>Drag the corners to outline the perimeter of your pool. Ensure the entire water surface is covered.</p>
        <div className="calibration-actions">
          <button className="button button-secondary" onClick={reset}><ResetIcon />Reset</button>
          <button className="button button-primary" onClick={() => onConfirm(points)}><CheckCircledIcon />Confirm Zone</button>
        </div>
      </section>
    </div>
  );
}

function BottomNav({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {navItems.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={active === id ? "active" : ""}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onChange(id)}
          aria-current={active === id ? "page" : undefined}
        >
          <Icon /><span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function EmergencyScreen({ incidentImage, onDismiss }: { incidentImage: string | null; onDismiss: () => void }) {
  const [confirmCall, setConfirmCall] = useState(false);

  const continueToPhone = () => {
    window.location.href = "tel:911";
  };

  return (
    <div className="emergency-screen" role="dialog" aria-modal="true" aria-labelledby="critical-title" data-testid="emergency-screen">
      <div className="emergency-content">
        <div className="alert-heading">
          <span className="alert-icon"><ExclamationTriangleIcon /></span>
          <span className="eyebrow critical-text">IMMEDIATE ACTION REQUIRED</span>
          <h1 id="critical-title">Critical alert</h1>
          <p>Possible persistent submersion detected.</p>
        </div>
        <section className="incident-card">
          <div className="incident-image">
            <img src={incidentImage ?? "/assets/aquaguard/emergency-capture.jpg"} alt={incidentImage ? "Camera capture from the detected event" : "Example pool alert capture"} draggable={false} />
            <span className="capture-pill"><VideoIcon /> Live capture</span>
            <time>Now • 14:32</time>
          </div>
          <div className="incident-location"><SewingPinIcon /><span><strong>Backyard Pool</strong><small>Zone 1 • Main deep end</small></span></div>
        </section>
        {confirmCall ? (
          <div className="call-confirmation" role="alert">
            <strong>Continue to the Phone app?</strong>
            <p>This opens the dialer with 911. You must review and place the call yourself.</p>
            <div><button className="button button-secondary" onClick={() => setConfirmCall(false)}>Cancel</button><button className="button call-button" onClick={continueToPhone}>Continue</button></div>
          </div>
        ) : (
          <div className="emergency-actions">
            <button className="button call-button" onClick={() => setConfirmCall(true)}><SpeakerLoudIcon />Call emergency services</button>
            <button className="button dismiss-button" onClick={onDismiss}><Cross1Icon />Dismiss — I verified safety</button>
          </div>
        )}
        <p className="demo-note"><InfoCircledIcon />AquaGuard cannot call automatically. Verify the pool immediately before using the Phone handoff.</p>
      </div>
    </div>
  );
}
