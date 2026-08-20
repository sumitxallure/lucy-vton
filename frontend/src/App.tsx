import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CameraOff,
  Check,
  CircleStop,
  Download,
  FileText,
  Hand,
  LoaderCircle,
  Mic,
  Plus,
  Radio,
  RefreshCw,
  Shirt,
  Sparkles,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import { createDecartClient, models, type RealTimeClient } from "@decartai/sdk";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useGestureControls } from "./gesture/useGestureControls";
import type { GestureCommand, GestureIntent } from "./gesture/gestureTypes";

type Garment = {
  id: string;
  file?: File;
  originalFileName?: string;
  imageUrl?: string;
  imageFileName?: string;
  imageMimeType?: string;
  createdAt?: string;
  name: string;
  previewUrl: string;
  storageId?: string;
  description?: GarmentDescription;
  descriptionFileName?: string;
  rawDescription?: string;
};

type GarmentOperation = "substitute" | "add";
type GarmentRegion = "upper_body" | "lower_body" | "outfit" | "footwear" | "hat" | "necklace" | "accessory";
type IntendedWearer = "men" | "women" | "unisex" | "not_specified";

type GarmentDescription = {
  schema_version: 1;
  display_name: string;
  operation: GarmentOperation;
  target_region: GarmentRegion;
  intended_wearer?: IntendedWearer;
  description: string;
};

type AppStatus = "idle" | "camera" | "connecting" | "live" | "error";
type OutputResolution = "720p" | "1080p";
type VideoFrameAspect = "empty" | "portrait" | "landscape";

type CameraInputDiagnostics = {
  label: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  aspectRatio: number | null;
  facingMode: string | null;
};

type SessionDiagnostics = {
  sessionStartedAt: number | null;
  connectedAt: number | null;
  lastApplyLatencyMs: number | null;
  lastApplyPrepareLatencyMs: number | null;
  lastApplySetLatencyMs: number | null;
  lastMotionLatencyMs: number | null;
  motionLatenciesMs: number[];
  motionSamples: number;
  outputWidth: number | null;
  outputHeight: number | null;
  outputFps: number | null;
  inputCamera: CameraInputDiagnostics;
  recordingBytes: number | null;
  events: string[];
};

type TokenResponse = {
  apiKey: string;
  expiresAt: string;
};

type StoredGarment = {
  id: string;
  name: string;
  imageUrl: string;
  imageFileName: string;
  imageMimeType: string;
  descriptionFileName: string | null;
  description: GarmentDescription;
  rawDescription: string;
  prompt: string;
  isVisible: boolean;
  createdAt: string;
};

type WardrobeResponse = {
  garments: StoredGarment[];
};

type DescriptionCandidate = {
  data: GarmentDescription;
  fileName: string;
  rawText: string;
};

type GestureCommandFlash = {
  command: GestureCommand;
  id: number;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";
const GARMENT_IMAGE_MAX_SIDE = 1280;
const GARMENT_IMAGE_QUALITY = 0.9;
const VTON_PROMPT_MAX_WORDS = 62;
const DESKTOP_CAMERA_WIDTH = 1920;
const DESKTOP_CAMERA_HEIGHT = 1080;
const DESKTOP_CAMERA_FPS = 30;
const vtonModel = models.realtime("lucy-vton-latest");
const regionLabels: Record<GarmentRegion, string> = {
  upper_body: "upper body garment",
  lower_body: "lower body garment",
  outfit: "outfit",
  footwear: "footwear",
  hat: "hat",
  necklace: "necklace",
  accessory: "accessory",
};

const preserveRegionInstructions: Record<GarmentRegion, string> = {
  upper_body: "Keep lower body and shoes unchanged.",
  lower_body: "Keep upper body and shoes unchanged.",
  outfit: "Keep face, body, pose, background, and lighting unchanged.",
  footwear: "Keep clothing unchanged.",
  hat: "Keep clothing and face unchanged.",
  necklace: "Keep clothing and face unchanged.",
  accessory: "Keep clothing and face unchanged.",
};

const closureSensitiveTerms = [
  "jacket",
  "coat",
  "blazer",
  "vest",
  "cardigan",
  "hoodie",
  "zip",
  "zipper",
  "button",
  "button-up",
  "shirt",
  "overshirt",
  "tuxedo",
  "suit",
];

const intendedWearerLabels: Record<IntendedWearer, string> = {
  men: "menswear",
  women: "womenswear",
  unisex: "unisex",
  not_specified: "original",
};

function fileStem(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").trim().toLowerCase();
}

function garmentMatchName(garment: Garment) {
  return garment.originalFileName ?? garment.file?.name ?? garment.imageFileName ?? garment.name;
}

function optimizedFileName(fileName: string) {
  return `${fileName.replace(/\.[^.]+$/, "")}.jpg`;
}

function frameAspectFromSize(width?: number, height?: number): VideoFrameAspect {
  if (!width || !height) return "empty";
  return height > width ? "portrait" : "landscape";
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not optimize garment image."));
    }, type, quality);
  });
}

async function optimizeGarmentImage(file: File) {
  if (!file.type.startsWith("image/")) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, GARMENT_IMAGE_MAX_SIDE / longestSide);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare garment image optimization.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, "image/jpeg", GARMENT_IMAGE_QUALITY);

    return new File([blob], optimizedFileName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

function normalizeFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function lowerFirst(value: string) {
  const trimmed = value.trim();
  return trimmed ? `${trimmed[0].toLowerCase()}${trimmed.slice(1)}` : "";
}

function withArticle(value: string) {
  const normalized = lowerFirst(value);
  if (!normalized || /^(a|an|the)\s/i.test(normalized)) return normalized;
  return `${/^[aeiou]/i.test(normalized) ? "an" : "a"} ${normalized}`;
}

function normalizeIntendedWearer(value?: string): IntendedWearer | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  if (["men", "mens", "male", "man"].includes(normalized)) return "men";
  if (["women", "womens", "female", "woman", "ladies"].includes(normalized)) return "women";
  if (["unisex", "genderneutral", "neutral", "all"].includes(normalized)) return "unisex";
  if (["notspecified", "unspecified", "unknown", "na"].includes(normalized)) return "not_specified";
  return undefined;
}

function inferIntendedWearer(...values: Array<string | undefined>): IntendedWearer {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  if (/\b(unisex|gender[-\s]?neutral)\b/.test(text)) return "unisex";
  if (/\b(mens|men's|men|male|man)\b/.test(text)) return "men";
  if (/\b(womens|women's|women|female|woman|ladies)\b/.test(text)) return "women";
  return "not_specified";
}

function limitWords(value: string, maxWords: number) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return value.trim();
  return `${words.slice(0, maxWords).join(" ").replace(/[,;:.]+$/, "")}.`;
}

function cleanPromptText(value: string) {
  return value
    .replace(/Ã©/g, "e")
    .replace(/Ã¨/g, "e")
    .replace(/Ãª/g, "e")
    .replace(/Ã«/g, "e")
    .replace(/Ã¡/g, "a")
    .replace(/Ã /g, "a")
    .replace(/Ã¢/g, "a")
    .replace(/Ã¤/g, "a")
    .replace(/Ã­/g, "i")
    .replace(/Ã®/g, "i")
    .replace(/Ã¯/g, "i")
    .replace(/Ã³/g, "o")
    .replace(/Ã´/g, "o")
    .replace(/Ã¶/g, "o")
    .replace(/Ãº/g, "u")
    .replace(/Ã¼/g, "u")
    .replace(/Ã±/g, "n")
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ/g, "\"")
    .replace(/â€�/g, "\"")
    .replace(/â€“/g, "-")
    .replace(/â€”/g, "-")
    .replace(/�/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseGarmentDescription(text: string): GarmentDescription {
  const fields = new Map<string, string>();
  for (const line of cleanPromptText(text).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = normalizeFieldName(line.slice(0, separator));
    const value = line.slice(separator + 1).trim();
    if (key && value && !/^(none|not visible|n\/a)$/i.test(value)) fields.set(key, value);
  }

  const required = (label: string) => {
    const value = fields.get(normalizeFieldName(label));
    if (!value) throw new Error(`${label} is required.`);
    return value;
  };

  const displayName = required("Garment Name");
  const action = required("Action").toLowerCase();
  const wornArea = required("Worn Area").toLowerCase();
  const garmentType = required("Garment Type");
  const operation: GarmentOperation = /^(replace|substitute)$/.test(action)
    ? "substitute"
    : action === "add"
      ? "add"
      : (() => { throw new Error("Action must be Replace or Add."); })();

  const regionAliases: Array<[GarmentRegion, string[]]> = [
    ["upper_body", ["upper body", "top", "tops"]],
    ["lower_body", ["lower body", "bottom", "bottoms"]],
    ["outfit", ["full outfit", "outfit", "full look"]],
    ["footwear", ["footwear", "shoes", "shoe"]],
    ["hat", ["hat or headwear", "hat", "headwear"]],
    ["necklace", ["necklace"]],
    ["accessory", ["accessory", "accessories"]],
  ];
  const targetRegion = regionAliases.find(([, aliases]) => aliases.includes(wornArea))?.[0];
  if (!targetRegion) throw new Error("Worn Area is not supported. Use Upper body, Lower body, Full outfit, Footwear, Hat or headwear, Necklace, or Accessory.");

  const optional = (label: string) => fields.get(normalizeFieldName(label));
  const intendedWearer = normalizeIntendedWearer(optional("Intended wearer"));
  const color = optional("Color");
  const material = optional("Material or Texture");
  const base = withArticle([color, garmentType].filter(Boolean).map((value) => lowerFirst(value!)).join(" "));
  const pattern = optional("Pattern");
  const details = [
    optional("Fit") ? withArticle(optional("Fit")!) : undefined,
    optional("Length"),
    optional("Sleeves"),
    optional("Neckline or Collar") ? withArticle(optional("Neckline or Collar")!) : undefined,
    optional("Closure") ? withArticle(optional("Closure")!) : undefined,
    optional("Open or Closed"),
    optional("Pockets"),
    pattern ? (/^solid$/i.test(pattern) ? "a solid design" : `${lowerFirst(pattern)} pattern`) : undefined,
    optional("Visible Logo, Graphic, or Text"),
    optional("Other Visible Details"),
  ].filter((value): value is string => Boolean(value)).map(lowerFirst);
  const description = `${base}${material ? ` in ${lowerFirst(material)}` : ""}${details.length ? `, with ${details.join(", ")}` : ""}`;

  return {
    schema_version: 1,
    display_name: displayName,
    operation,
    target_region: targetRegion,
    intended_wearer: intendedWearer ?? inferIntendedWearer(displayName, garmentType, description),
    description,
  };
}

async function readGarmentDescription(file: File) {
  try {
    const rawText = cleanPromptText(await file.text());
    return {
      data: parseGarmentDescription(rawText),
      fileName: file.name,
      rawText,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid garment description.";
    throw new Error(`${file.name}: ${detail}`);
  }
}

function generateVtonPrompt(description: GarmentDescription) {
  const rawDetails = cleanPromptText(description.description).replace(/[.\s]+$/, "");
  const details = limitWords(rawDetails, VTON_PROMPT_MAX_WORDS);
  const lowerDetails = details.toLowerCase();
  const canBeClosed = closureSensitiveTerms.some((term) => lowerDetails.includes(term));
  const alreadyStatesOpenOrClosed = /\b(open|opened|closed|zipped|buttoned|fastened|unbuttoned)\b/i.test(details);
  const closureInstruction = canBeClosed && !alreadyStatesOpenOrClosed
    ? "Closed/fastened if possible."
    : "Keep reference closure.";
  const modestyInstruction = "No bare chest, stomach, underwear, or skin gaps. If open, transparent, cutout, or motion exposes skin, add fitted opaque matching inner layer.";
  const fitInstruction = "Natural fit, aligned shoulders, waist, sleeves, hems.";
  const preserveInstruction = preserveRegionInstructions[description.target_region];
  const intendedWearer = description.intended_wearer ?? inferIntendedWearer(description.display_name, description.description);
  const wearerInstruction = intendedWearer === "not_specified"
    ? "Fit visible adult wearer; preserve original design."
    : `Fit visible adult wearer; preserve ${intendedWearerLabels[intendedWearer]} design.`;
  const safetyTail = [wearerInstruction, closureInstruction, modestyInstruction, fitInstruction, preserveInstruction]
    .filter(Boolean)
    .join(" ");

  if (description.operation === "add") return `Add ${details} to the outfit. ${safetyTail}`;
  return `Substitute the ${regionLabels[description.target_region]} with ${details}. ${safetyTail}`;
}

function readableError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Camera permission was denied. Allow camera access in your browser and try again.";
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function recordingMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function formatMilliseconds(value: number | null) {
  return value === null ? "Waiting" : `${Math.round(value)} ms`;
}

function formatDuration(startedAt: number | null, now: number) {
  if (!startedAt) return "0s";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes ? `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s` : `${remainingSeconds}s`;
}

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatBytes(value: number | null) {
  if (value === null) return "Not recorded";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function formatPixels(width: number | null, height: number | null) {
  return width && height ? `${width} x ${height}` : "Not reported";
}

function formatFps(value: number | null) {
  return value ? `${Math.round(value)} FPS` : "Not reported";
}

function gestureCommandLabel(command: GestureCommand) {
  if (command === "previous-garment") return "Previous garment selected";
  if (command === "next-garment") return "Next garment selected";
  if (command === "toggle-live") return "Live try-on toggled";
  return "Look captured";
}

function createMotionReader(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  const width = 48;
  const height = 27;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let previous: Uint8ClampedArray | null = null;

  return () => {
    if (!context || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return 0;
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const current = new Uint8ClampedArray(width * height);
    let diff = 0;
    for (let index = 0; index < current.length; index += 1) {
      const pixelIndex = index * 4;
      current[index] = Math.round((pixels[pixelIndex] + pixels[pixelIndex + 1] + pixels[pixelIndex + 2]) / 3);
      if (previous) diff += Math.abs(current[index] - previous[index]);
    }
    previous = current;
    return previous ? diff / current.length : 0;
  };
}

async function readJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    const errorMessage = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : fallbackMessage;
    throw new Error(errorMessage);
  }
  return body as T;
}

function apiFetch(pathOrUrl: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("ngrok-skip-browser-warning", "true");
  return fetch(pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE_URL}${pathOrUrl}`, {
    ...init,
    headers,
  });
}

async function saveStoredGarment(file: File, description: DescriptionCandidate) {
  const formData = new FormData();
  formData.append("image", file);
  formData.append("rawDescription", description.rawText);
  formData.append("description", JSON.stringify(description.data));
  formData.append("descriptionFileName", description.fileName);
  formData.append("prompt", generateVtonPrompt(description.data));

  const response = await apiFetch("/api/wardrobe", {
    method: "POST",
    body: formData,
  });
  return readJsonResponse<{ garment: StoredGarment }>(response, "Could not save garment.");
}

function storedGarmentToLocal(stored: StoredGarment): Garment {
  return {
    id: stored.id,
    storageId: stored.id,
    originalFileName: stored.imageFileName,
    imageUrl: stored.imageUrl,
    imageFileName: stored.imageFileName,
    imageMimeType: stored.imageMimeType,
    createdAt: stored.createdAt,
    name: stored.name,
    previewUrl: `${API_BASE_URL}${stored.imageUrl}`,
    description: stored.description,
    descriptionFileName: stored.descriptionFileName ?? undefined,
    rawDescription: stored.rawDescription,
  };
}

export default function App() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedGarment, setSelectedGarment] = useState<Garment | null>(null);
  const [enhance, setEnhance] = useState(false);
  const [outputResolution, setOutputResolution] = useState<OutputResolution>("720p");
  const [status, setStatus] = useState<AppStatus>("idle");
  const [message, setMessage] = useState("Add one or more garment images to begin.");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [capturedLookUrl, setCapturedLookUrl] = useState<string | null>(null);
  const [capturedLookFileName, setCapturedLookFileName] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isApplying, setIsApplying] = useState(false);
  const [isWardrobeLoading, setIsWardrobeLoading] = useState(true);
  const [isWardrobeSaving, setIsWardrobeSaving] = useState(false);
  const [isOutputStreamAttached, setIsOutputStreamAttached] = useState(false);
  const [isOutputVideoReady, setIsOutputVideoReady] = useState(false);
  const [gestureEnabled, setGestureEnabled] = useState(true);
  const [localFrameAspect, setLocalFrameAspect] = useState<VideoFrameAspect>("empty");
  const [outputFrameAspect, setOutputFrameAspect] = useState<VideoFrameAspect>("empty");
  const [gestureCommandFlash, setGestureCommandFlash] = useState<GestureCommandFlash | null>(null);
  const [captureFlashId, setCaptureFlashId] = useState(0);
  const [diagnostics, setDiagnostics] = useState<SessionDiagnostics>({
    sessionStartedAt: null,
    connectedAt: null,
    lastApplyLatencyMs: null,
    lastApplyPrepareLatencyMs: null,
    lastApplySetLatencyMs: null,
    lastMotionLatencyMs: null,
    motionLatenciesMs: [],
    motionSamples: 0,
    outputWidth: null,
    outputHeight: null,
    outputFps: null,
    inputCamera: {
      label: null,
      width: null,
      height: null,
      frameRate: null,
      aspectRatio: null,
      facingMode: null,
    },
    recordingBytes: null,
    events: [],
  });
  const [clockNow, setClockNow] = useState(() => performance.now());

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLInputElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const lucyInputStreamRef = useRef<MediaStream | null>(null);
  const outputStreamRef = useRef<MediaStream | null>(null);
  const realtimeRef = useRef<RealTimeClient | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const garmentUrlsRef = useRef(new Set<string>());
  const recordingUrlRef = useRef<string | null>(null);
  const capturedLookUrlRef = useRef<string | null>(null);
  const applyStartedAtRef = useRef<number | null>(null);
  const isApplyingRef = useRef(false);
  const queuedGarmentRef = useRef<Garment | null>(null);
  const outputFrameStatsRef = useRef({ lastCount: 0, lastTime: 0 });
  const garmentsRef = useRef<Garment[]>([]);
  const preloadingIdsRef = useRef(new Set<string>());
  const isPreloadingWardrobeRef = useRef(false);
  const garmentCardRefs = useRef(new Map<string, HTMLDivElement>());

  const generatedPrompt = selectedGarment?.description ? generateVtonPrompt(selectedGarment.description) : "";

  const captureOutputVideoMetrics = useCallback((eventName: string) => {
    const video = outputVideoRef.current;
    if (!video) return;
    const width = video.videoWidth || null;
    const height = video.videoHeight || null;
    if (width && height) setOutputFrameAspect(frameAspectFromSize(width, height));
    setDiagnostics((current) => ({
      ...current,
      outputWidth: width ?? current.outputWidth,
      outputHeight: height ?? current.outputHeight,
      events: [
        ...current.events,
        `${new Date().toISOString()} ${eventName}${width && height ? ` (${width} x ${height})` : ""}`,
      ],
    }));
  }, []);

  const startOutputFpsSampler = useCallback(() => {
    const video = outputVideoRef.current;
    if (!video || !("requestVideoFrameCallback" in video)) return;
    outputFrameStatsRef.current = { lastCount: 0, lastTime: performance.now() };
    const sample = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      const stats = outputFrameStatsRef.current;
      if (stats.lastCount && metadata.presentedFrames > stats.lastCount) {
        const elapsedSeconds = (performance.now() - stats.lastTime) / 1000;
        if (elapsedSeconds >= 1) {
          const fps = (metadata.presentedFrames - stats.lastCount) / elapsedSeconds;
          setDiagnostics((current) => ({
            ...current,
            outputFps: fps,
          }));
          outputFrameStatsRef.current = {
            lastCount: metadata.presentedFrames,
            lastTime: performance.now(),
          };
        }
      } else if (!stats.lastCount) {
        outputFrameStatsRef.current = {
          lastCount: metadata.presentedFrames,
          lastTime: performance.now(),
        };
      }
      if (outputStreamRef.current && outputVideoRef.current?.srcObject) {
        video.requestVideoFrameCallback(sample);
      }
    };
    video.requestVideoFrameCallback(sample);
  }, []);

  const rememberPreviewUrl = useCallback((url: string) => {
    garmentUrlsRef.current.add(url);
    return url;
  }, []);

  const clearRecordingTimer = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    clearRecordingTimer();
    setIsRecording(false);
  }, [clearRecordingTimer]);

  const stopSession = useCallback(() => {
    stopRecording();
    realtimeRef.current?.disconnect();
    realtimeRef.current = null;
    lucyInputStreamRef.current?.getTracks().forEach((track) => track.stop());
    lucyInputStreamRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    outputStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    outputStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (outputVideoRef.current) outputVideoRef.current.srcObject = null;
    setIsOutputStreamAttached(false);
    setIsOutputVideoReady(false);
    setLocalFrameAspect("empty");
    setOutputFrameAspect("empty");
    setStatus("idle");
    setMessage(garments.length ? "Camera stopped. Ready when you are." : "Add one or more garment images to begin.");
  }, [garments.length, stopRecording]);

  const stopLiveTryOn = useCallback(() => {
    stopRecording();
    const realtime = realtimeRef.current;
    realtimeRef.current = null;
    realtime?.disconnect();
    lucyInputStreamRef.current?.getTracks().forEach((track) => track.stop());
    lucyInputStreamRef.current = null;
    outputStreamRef.current?.getTracks().forEach((track) => track.stop());
    outputStreamRef.current = null;
    if (outputVideoRef.current) outputVideoRef.current.srcObject = null;
    setIsOutputStreamAttached(false);
    setIsOutputVideoReady(false);
    setOutputFrameAspect("empty");
    setStatus(localStreamRef.current ? "camera" : "idle");
    setMessage("Live try-on stopped. Your camera and gesture controls remain active.");
  }, [stopRecording]);

  const ensureGarmentFile = useCallback(async (garment: Garment) => {
    if (garment.file) return garment;
    if (!garment.imageUrl) throw new Error(`Could not load image for ${garment.name}.`);

    const response = await apiFetch(garment.imageUrl);
    if (!response.ok) throw new Error(`Could not load image for ${garment.name}.`);
    const blob = await response.blob();
    const file = new File([blob], garment.imageFileName ?? `${garment.name}.png`, {
      type: garment.imageMimeType || blob.type,
      lastModified: garment.createdAt ? Date.parse(garment.createdAt) : Date.now(),
    });
    const optimizedFile = await optimizeGarmentImage(file);
    const updated = { ...garment, file: optimizedFile };
    setGarments((current) => current.map((item) => (item.id === garment.id ? updated : item)));
    setSelectedGarment((current) => (current?.id === garment.id ? updated : current));
    return updated;
  }, []);

  const preloadWardrobeFiles = useCallback(async (priorityId?: string | null) => {
    if (isPreloadingWardrobeRef.current) return;
    isPreloadingWardrobeRef.current = true;
    try {
      while (true) {
        const currentGarments = garmentsRef.current;
        const orderedGarments = [
          ...currentGarments.filter((garment) => garment.id === priorityId),
          ...currentGarments.filter((garment) => garment.id !== priorityId),
        ];
        const nextGarment = orderedGarments.find((garment) => (
          !garment.file
          && garment.imageUrl
          && !preloadingIdsRef.current.has(garment.id)
        ));
        if (!nextGarment) return;

        preloadingIdsRef.current.add(nextGarment.id);
        const startedAt = performance.now();
        try {
          const readyGarment = await ensureGarmentFile(nextGarment);
          const elapsed = Math.round(performance.now() - startedAt);
          setDiagnostics((current) => ({
            ...current,
            events: [
              ...current.events,
              `${new Date().toISOString()} Preloaded ${readyGarment.name} in ${elapsed} ms`,
            ],
          }));
        } catch (error) {
          setDiagnostics((current) => ({
            ...current,
            events: [
              ...current.events,
              `${new Date().toISOString()} Preload failed for ${nextGarment.name}: ${readableError(error)}`,
            ],
          }));
        }
      }
    } finally {
      isPreloadingWardrobeRef.current = false;
    }
  }, [ensureGarmentFile]);

  useEffect(() => {
    return () => {
      realtimeRef.current?.disconnect();
      lucyInputStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      outputStreamRef.current?.getTracks().forEach((track) => track.stop());
      garmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
      if (capturedLookUrlRef.current) URL.revokeObjectURL(capturedLookUrlRef.current);
      clearRecordingTimer();
    };
  }, [clearRecordingTimer]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    garmentsRef.current = garments;
  }, [garments]);

  useEffect(() => {
    if (!selectedId) return;
    garmentCardRefs.current.get(selectedId)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [selectedId]);

  useEffect(() => {
    if (!gestureCommandFlash) return undefined;
    const timer = window.setTimeout(() => setGestureCommandFlash(null), 1200);
    return () => window.clearTimeout(timer);
  }, [gestureCommandFlash]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedGarment(null);
      return;
    }

    const matchingGarment = garments.find((garment) => garment.id === selectedId) ?? null;
    setSelectedGarment(matchingGarment);
  }, [garments, selectedId]);

  useEffect(() => {
    let cancelled = false;

    const loadWardrobe = async () => {
      setIsWardrobeLoading(true);
      try {
        const response = await apiFetch("/api/wardrobe");
        const body = await readJsonResponse<WardrobeResponse>(response, "Could not load stored wardrobe.");
        const hydrated = body.garments.map(storedGarmentToLocal);

        if (cancelled) {
          return;
        }

        setGarments(hydrated);
        setSelectedId(hydrated[0]?.id ?? null);
        setSelectedGarment(hydrated[0] ?? null);
        setMessage(
          hydrated.length
            ? `${hydrated.length} saved garment${hydrated.length === 1 ? "" : "s"} loaded.`
            : "No saved garments could be loaded. Check the backend or Supabase image files.",
        );
      } catch (error) {
        if (!cancelled) {
          setMessage(`Stored wardrobe is not ready yet: ${readableError(error)}`);
        }
      } finally {
        if (!cancelled) setIsWardrobeLoading(false);
      }
    };

    void loadWardrobe();
    return () => {
      cancelled = true;
    };
  }, [rememberPreviewUrl]);

  useEffect(() => {
    if (!garments.length || isWardrobeLoading) return;
    void preloadWardrobeFiles(selectedId);
  }, [garments.length, isWardrobeLoading, preloadWardrobeFiles, selectedId]);

  useEffect(() => {
    if (status !== "live" || !localVideoRef.current || !outputVideoRef.current) return undefined;

    const readLocalMotion = createMotionReader(localVideoRef.current);
    const readOutputMotion = createMotionReader(outputVideoRef.current);
    let pendingLocalMotionAt: number | null = null;
    let localCooldownUntil = 0;
    const localMotionThreshold = 8;
    const outputMotionThreshold = 5;

    const timer = window.setInterval(() => {
      const now = performance.now();
      const localEnergy = readLocalMotion();
      const outputEnergy = readOutputMotion();

      if (!pendingLocalMotionAt && now > localCooldownUntil && localEnergy > localMotionThreshold) {
        pendingLocalMotionAt = now;
        localCooldownUntil = now + 1200;
      }

      if (pendingLocalMotionAt && now - pendingLocalMotionAt > 60 && outputEnergy > outputMotionThreshold) {
        const latency = now - pendingLocalMotionAt;
        pendingLocalMotionAt = null;
        setDiagnostics((current) => ({
          ...current,
          lastMotionLatencyMs: latency,
          motionLatenciesMs: [...current.motionLatenciesMs, latency],
          motionSamples: current.motionSamples + 1,
        }));
      }

      if (pendingLocalMotionAt && now - pendingLocalMotionAt > 3500) pendingLocalMotionAt = null;
    }, 80);

    return () => window.clearInterval(timer);
  }, [status]);

  const addGarments = async (files: FileList | File[]) => {
    const uploadedFiles = Array.from(files);
    const imageFiles = uploadedFiles.filter((file) => file.type.startsWith("image/"));
    const descriptionFiles = uploadedFiles.filter((file) => file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt"));
    if (!imageFiles.length && !descriptionFiles.length) {
      setStatus("error");
      setMessage("Choose garment images and matching text description files.");
      return;
    }

    const descriptions = new Map<string, DescriptionCandidate>();
    try {
      for (const file of descriptionFiles) {
        descriptions.set(fileStem(file.name), await readGarmentDescription(file));
      }
    } catch (error) {
      setStatus("error");
      setMessage(readableError(error));
      return;
    }

    setIsWardrobeSaving(true);
    const saveErrors: string[] = [];
    const additions = await Promise.all(imageFiles.map(async (file) => {
      const optimizedFile = await optimizeGarmentImage(file);
      const previewUrl = rememberPreviewUrl(URL.createObjectURL(optimizedFile));
      const matchingDescription = descriptions.get(fileStem(file.name));
      if (matchingDescription) {
        try {
          const { garment } = await saveStoredGarment(optimizedFile, matchingDescription);
          return {
            ...storedGarmentToLocal(garment),
            file: optimizedFile,
            previewUrl,
          };
        } catch (error) {
          saveErrors.push(readableError(error));
        }
      }
      return {
        id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        file: optimizedFile,
        originalFileName: file.name,
        name: matchingDescription?.data.display_name ?? file.name.replace(/\.[^.]+$/, ""),
        previewUrl,
        description: matchingDescription?.data,
        descriptionFileName: matchingDescription?.fileName,
        rawDescription: matchingDescription?.rawText,
      };
    }));
    setIsWardrobeSaving(false);

    setGarments((current) => {
      const updated = current.map((garment) => {
        const matchingDescription = descriptions.get(fileStem(garmentMatchName(garment)));
        return matchingDescription
          ? { ...garment, description: matchingDescription.data, descriptionFileName: matchingDescription.fileName, rawDescription: matchingDescription.rawText }
          : garment;
      });
      return [...updated, ...additions];
    });
    if (!selectedGarment && additions[0]) {
      setSelectedId(additions[0].id);
      setSelectedGarment(additions[0]);
    }
    setStatus((current) => (current === "error" ? "idle" : current));
    const attachedCount = descriptions.size;
    setMessage(
      saveErrors.length
        ? `${additions.length} garment${additions.length === 1 ? "" : "s"} added locally. Supabase save needs attention: ${saveErrors[0]}`
        : `${additions.length} garment${additions.length === 1 ? "" : "s"} added${attachedCount ? `; ${attachedCount} description${attachedCount === 1 ? "" : "s"} saved` : ""}.`,
    );
  };

  const attachDescriptions = async (files: FileList | File[]) => {
    const descriptionFiles = Array.from(files).filter((file) => file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt"));
    if (!descriptionFiles.length) {
      setStatus("error");
      setMessage("Choose one or more TXT description files.");
      return;
    }

    try {
      const descriptions = new Map<string, DescriptionCandidate>();
      for (const file of descriptionFiles) {
        descriptions.set(fileStem(file.name), await readGarmentDescription(file));
      }

      const selectedOnly = descriptionFiles.length === 1 && selectedGarment && !descriptions.has(fileStem(garmentMatchName(selectedGarment)));
      const firstDescription = Array.from(descriptions.values())[0];
      const willAttach = (garment: Garment) => Boolean(
        selectedOnly && garment.id === selectedGarment.id ? firstDescription : descriptions.get(fileStem(garmentMatchName(garment))),
      );
      const attachedCount = garments.filter(willAttach).length;
      const saveErrors: string[] = [];
      setIsWardrobeSaving(true);
      const updatedGarments = await Promise.all(garments.map(async (garment) => {
        const matchingDescription = selectedOnly && garment.id === selectedGarment.id
          ? firstDescription
          : descriptions.get(fileStem(garmentMatchName(garment)));
        if (!matchingDescription) return garment;

        const updated = {
          ...garment,
          description: matchingDescription.data,
          descriptionFileName: matchingDescription.fileName,
          rawDescription: matchingDescription.rawText,
          name: matchingDescription.data.display_name,
        };
        if (garment.storageId) return updated;

        try {
          if (!garment.file) throw new Error(`Image is not loaded for ${garment.name}.`);
          const { garment: stored } = await saveStoredGarment(garment.file, matchingDescription);
          return {
            ...updated,
            id: stored.id,
            storageId: stored.id,
          };
        } catch (error) {
          saveErrors.push(readableError(error));
          return updated;
        }
      }));
      setIsWardrobeSaving(false);

      setGarments(updatedGarments);
      if (selectedGarment) {
        const updatedSelected = updatedGarments.find((garment) => garment.previewUrl === selectedGarment.previewUrl);
        if (updatedSelected) {
          setSelectedId(updatedSelected.id);
          setSelectedGarment(updatedSelected);
        }
      }
      setStatus((current) => (current === "error" ? (localStreamRef.current ? "camera" : "idle") : current));
      setMessage(
        saveErrors.length
          ? `${attachedCount} description${attachedCount === 1 ? "" : "s"} attached locally. Supabase save needs attention: ${saveErrors[0]}`
          : attachedCount
            ? `${attachedCount} description${attachedCount === 1 ? "" : "s"} attached and saved.`
          : "No matching garment image was found for those TXT files.",
      );
    } catch (error) {
      setIsWardrobeSaving(false);
      setStatus("error");
      setMessage(readableError(error));
    }
  };

  const startCamera = async () => {
    try {
      setMessage("Requesting camera and microphone access...");
      const isMobileViewport = window.matchMedia("(max-width: 760px)").matches;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: isMobileViewport ? 720 : DESKTOP_CAMERA_WIDTH },
          height: { ideal: isMobileViewport ? 1280 : DESKTOP_CAMERA_HEIGHT },
          aspectRatio: { ideal: isMobileViewport ? 9 / 16 : DESKTOP_CAMERA_WIDTH / DESKTOP_CAMERA_HEIGHT },
          frameRate: { ideal: DESKTOP_CAMERA_FPS },
          facingMode: "user",
        },
        audio: true,
      });
      localStreamRef.current = stream;
      const [videoTrack] = stream.getVideoTracks();
      const videoSettings = videoTrack?.getSettings();
      setLocalFrameAspect(frameAspectFromSize(videoSettings?.width, videoSettings?.height));
      setDiagnostics((current) => ({
        ...current,
        inputCamera: {
          label: videoTrack?.label || null,
          width: videoSettings?.width ?? null,
          height: videoSettings?.height ?? null,
          frameRate: videoSettings?.frameRate ?? null,
          aspectRatio: videoSettings?.aspectRatio ?? null,
          facingMode: videoSettings?.facingMode ?? null,
        },
        events: [
          ...current.events,
          `${new Date().toISOString()} Input camera ready: ${videoTrack?.label || "Unknown device"} (${formatPixels(videoSettings?.width ?? null, videoSettings?.height ?? null)}, ${formatFps(videoSettings?.frameRate ?? null)})`,
        ],
      }));
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        await localVideoRef.current.play();
        setLocalFrameAspect(frameAspectFromSize(localVideoRef.current.videoWidth, localVideoRef.current.videoHeight));
      }
      setStatus("camera");
      setMessage(selectedGarment ? "Camera is ready. Apply the selected garment." : "Camera is ready. Add a garment to continue.");
    } catch (error) {
      setStatus("error");
      setMessage(readableError(error));
    }
  };

  const fetchClientToken = async () => {
    const response = await apiFetch("/api/decart-token", { method: "POST" });
    const body = (await response.json()) as TokenResponse | { error?: string };
    if (!response.ok || !("apiKey" in body)) {
      throw new Error("error" in body && body.error ? body.error : "Could not start a Decart session.");
    }
    return body.apiKey;
  };

  const applyGarment = async (garment = selectedGarment) => {
    if (!garment) {
      setStatus("error");
      setMessage("Select a garment image first.");
      return;
    }
    if (!garment.description) {
      setStatus("error");
      setMessage(`Attach a text description to ${garment.name} before starting try-on.`);
      return;
    }
    if (!localStreamRef.current) {
      setStatus("error");
      setMessage("Start your camera first.");
      return;
    }
    if (isApplyingRef.current) {
      queuedGarmentRef.current = garment;
      setMessage(`${garment.name} queued. Applying it after the current update finishes.`);
      return;
    }

    isApplyingRef.current = true;
    setIsApplying(true);
    const applyStartedAt = performance.now();
    applyStartedAtRef.current = applyStartedAt;
    try {
      setMessage(`Preparing ${garment.name}...`);
      const readyGarment = await ensureGarmentFile(garment);
      const preparedAt = performance.now();
      const readyFile = readyGarment.file;
      if (!readyFile) throw new Error(`Could not prepare ${garment.name} for Lucy.`);
      const garmentPrompt = generateVtonPrompt(readyGarment.description!);
      setDiagnostics((current) => ({
        ...current,
        lastApplyPrepareLatencyMs: preparedAt - applyStartedAt,
        events: [
          ...current.events,
          `${new Date().toISOString()} Prepared ${readyGarment.name} in ${Math.round(preparedAt - applyStartedAt)} ms; image ${formatBytes(readyFile.size)}`,
          `${new Date().toISOString()} Applying ${readyGarment.name}; image ${formatBytes(readyFile.size)}`,
        ],
      }));
      if (realtimeRef.current?.isConnected()) {
        setMessage(`Changing to ${readyGarment.name}...`);
        const setStartedAt = performance.now();
        await realtimeRef.current.set({ image: readyFile, prompt: garmentPrompt, enhance });
        const setEndedAt = performance.now();
        setDiagnostics((current) => ({
          ...current,
          lastApplyLatencyMs: setEndedAt - applyStartedAt,
          lastApplySetLatencyMs: setEndedAt - setStartedAt,
          events: [
            ...current.events,
            `${new Date().toISOString()} Lucy set completed in ${Math.round(setEndedAt - setStartedAt)} ms; total apply ${Math.round(setEndedAt - applyStartedAt)} ms`,
          ],
        }));
        setStatus("live");
        setMessage(`${readyGarment.name} is now live.`);
        return;
      }

      setStatus("connecting");
      setMessage("Starting Lucy live try-on...");
      setIsOutputStreamAttached(false);
      setIsOutputVideoReady(false);
      setDiagnostics((current) => ({
        ...current,
        sessionStartedAt: performance.now(),
        connectedAt: null,
        lastApplyLatencyMs: null,
        lastApplyPrepareLatencyMs: null,
        lastApplySetLatencyMs: null,
        lastMotionLatencyMs: null,
        motionLatenciesMs: [],
        motionSamples: 0,
        outputWidth: null,
        outputHeight: null,
        outputFps: null,
        recordingBytes: null,
        events: [`${new Date().toISOString()} Session requested at ${outputResolution}`],
      }));
      const temporaryApiKey = await fetchClientToken();
      const decart = createDecartClient({ apiKey: temporaryApiKey });
      lucyInputStreamRef.current?.getTracks().forEach((track) => track.stop());
      lucyInputStreamRef.current = localStreamRef.current.clone();
      const realtime = await decart.realtime.connect(lucyInputStreamRef.current, {
        model: vtonModel,
        mirror: "auto",
        resolution: outputResolution,
        initialState: {
          prompt: { text: garmentPrompt, enhance },
          image: readyFile,
        },
        onRemoteStream(stream) {
          outputStreamRef.current = stream;
          setIsOutputStreamAttached(true);
          const [track] = stream.getVideoTracks();
          const settings = track?.getSettings();
          setOutputFrameAspect(frameAspectFromSize(settings?.width, settings?.height));
          const now = performance.now();
          setDiagnostics((current) => ({
            ...current,
            connectedAt: now,
            lastApplyLatencyMs: applyStartedAtRef.current ? now - applyStartedAtRef.current : current.lastApplyLatencyMs,
            lastApplySetLatencyMs: applyStartedAtRef.current ? now - preparedAt : current.lastApplySetLatencyMs,
            outputWidth: settings?.width ?? null,
            outputHeight: settings?.height ?? null,
            outputFps: settings?.frameRate ?? null,
            events: [...current.events, `${new Date().toISOString()} Remote stream connected`],
          }));
          if (outputVideoRef.current) {
            outputVideoRef.current.srcObject = stream;
            void outputVideoRef.current.play().then(() => {
              setDiagnostics((current) => ({
                ...current,
                events: [...current.events, `${new Date().toISOString()} Output video playback started`],
              }));
            }).catch((error) => {
              const playError = readableError(error);
              setDiagnostics((current) => ({
                ...current,
                events: [...current.events, `${new Date().toISOString()} Output video playback failed: ${playError}`],
              }));
              setMessage(`Lucy stream connected, but browser playback failed: ${playError}`);
            });
          }
          window.setTimeout(() => {
            const video = outputVideoRef.current;
            if (!video || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth > 0) return;
            setDiagnostics((current) => ({
              ...current,
              events: [...current.events, `${new Date().toISOString()} Output stream connected but no video frames after 8 seconds`],
            }));
            setMessage("Lucy stream connected, but no video frames arrived yet. Try Stop camera, then start the live try-on again.");
          }, 8000);
          setStatus("live");
          setMessage(`Lucy stream connected for ${readyGarment.name}. Waiting for video frames...`);
        },
        onConnectionChange(connectionState) {
          setDiagnostics((current) => ({
            ...current,
            events: [...current.events, `${new Date().toISOString()} Connection state: ${connectionState}`],
          }));
          if (connectionState === "disconnected" && realtimeRef.current) {
            setStatus("camera");
            setMessage("Lucy disconnected. Your camera is still available; apply the garment to reconnect.");
          }
        },
        onQueuePosition(queue) {
          setDiagnostics((current) => ({
            ...current,
            events: [...current.events, `${new Date().toISOString()} Queue position: ${queue.position}`],
          }));
          setMessage(`Lucy is busy. Queue position: ${queue.position}.`);
        },
      });
      realtime.on("error", (error) => {
        setDiagnostics((current) => ({
          ...current,
          events: [...current.events, `${new Date().toISOString()} Error: ${readableError(error)}`],
        }));
        setStatus("error");
        setMessage(readableError(error));
      });
      realtimeRef.current = realtime;
    } catch (error) {
      setStatus(localStreamRef.current ? "camera" : "error");
      setMessage(readableError(error));
    } finally {
      isApplyingRef.current = false;
      setIsApplying(false);
      const queuedGarment = queuedGarmentRef.current;
      queuedGarmentRef.current = null;
      if (queuedGarment && queuedGarment.id !== garment.id && localStreamRef.current) {
        void applyGarment(queuedGarment);
      }
    }
  };

  const selectGarment = (garment: Garment) => {
    setSelectedId(garment.id);
    setSelectedGarment(garment);
    if (realtimeRef.current?.isConnected()) {
      if (garment.description) void applyGarment(garment);
      else setMessage(`Attach a text description to ${garment.name} before applying it.`);
    }
  };

  const selectAdjacentGarment = (direction: "next" | "previous") => {
    const availableGarments = garmentsRef.current.filter((garment) => garment.description);
    if (!availableGarments.length) {
      setMessage("Add a garment with a description before using swipe controls.");
      return;
    }

    const currentIndex = availableGarments.findIndex((garment) => garment.id === selectedId);
    const step = direction === "next" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + step + availableGarments.length) % availableGarments.length;
    const nextGarment = availableGarments[nextIndex];
    selectGarment(nextGarment);
    setMessage(`${direction === "next" ? "Next" : "Previous"} garment: ${nextGarment.name}.`);
  };

  const removeGarment = async (garment: Garment) => {
    if (garment.storageId) {
      try {
        const response = await apiFetch(`/api/wardrobe/${garment.storageId}`, { method: "DELETE" });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? "Could not delete stored garment.");
        }
      } catch (error) {
        setStatus("error");
        setMessage(readableError(error));
        return;
      }
    }
    if (garment.previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(garment.previewUrl);
      garmentUrlsRef.current.delete(garment.previewUrl);
    }
    const remaining = garments.filter((item) => item.id !== garment.id);
    setGarments(remaining);
    if (selectedId === garment.id) {
      setSelectedId(remaining[0]?.id ?? null);
      setSelectedGarment(remaining[0] ?? null);
    }
    setMessage(remaining.length ? `${garment.name} removed from wardrobe.` : "Add one or more garment images to begin.");
  };

  const startRecording = () => {
    const output = outputStreamRef.current;
    if (!output) return;

    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = null;
    setRecordingUrl(null);
    const recordingStream = new MediaStream([
      ...output.getVideoTracks(),
      ...(localStreamRef.current?.getAudioTracks() ?? []),
    ]);
    const mimeType = recordingMimeType();
    const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    recordingChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) recordingChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, { type: mimeType || "video/webm" });
      const url = URL.createObjectURL(blob);
      recordingUrlRef.current = url;
      setRecordingUrl(url);
      setDiagnostics((current) => ({
        ...current,
        recordingBytes: blob.size,
        events: [...current.events, `${new Date().toISOString()} Recording stopped at ${blob.size} bytes`],
      }));
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setRecordingDuration(0);
    setIsRecording(true);
    recordingTimerRef.current = window.setInterval(() => setRecordingDuration((value) => value + 1), 1000);
  };

  const downloadRecording = () => {
    if (!recordingUrl) return;
    const anchor = document.createElement("a");
    anchor.href = recordingUrl;
    anchor.download = `lucy-try-on-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    anchor.click();
  };

  const captureCurrentLook = async () => {
    const video = outputVideoRef.current;
    if (!video || !isOutputVideoReady || !video.videoWidth || !video.videoHeight) {
      setMessage("Wait for the Lucy output before capturing a look.");
      return;
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare the image capture.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("Could not capture the current look."));
        }, "image/png");
      });
      const url = URL.createObjectURL(blob);
      if (capturedLookUrlRef.current) URL.revokeObjectURL(capturedLookUrlRef.current);
      const fileName = `lucy-look-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      capturedLookUrlRef.current = url;
      setCapturedLookUrl(url);
      setCapturedLookFileName(fileName);
      setCaptureFlashId((value) => value + 1);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      setMessage("Current Lucy look captured. Use Download photo if the browser did not save it automatically.");
    } catch (error) {
      setMessage(readableError(error));
    }
  };

  const downloadCapturedLook = () => {
    if (!capturedLookUrl || !capturedLookFileName) return;
    const anchor = document.createElement("a");
    anchor.href = capturedLookUrl;
    anchor.download = capturedLookFileName;
    anchor.click();
  };

  const handleGestureCommand = (command: GestureCommand) => {
    if (isApplyingRef.current || status === "connecting") {
      setMessage("Please wait for the current Lucy update to finish.");
      return;
    }

    setGestureCommandFlash({ command, id: Date.now() });

    if (command === "next-garment") {
      selectAdjacentGarment("next");
      return;
    }
    if (command === "previous-garment") {
      selectAdjacentGarment("previous");
      return;
    }
    if (command === "capture-look") {
      void captureCurrentLook();
      return;
    }

    if (realtimeRef.current?.isConnected() || status === "live") {
      stopLiveTryOn();
    } else {
      void applyGarment();
    }
  };

  const gestureActive = gestureEnabled && Boolean(localStreamRef.current);
  const { modelStatus: gestureModelStatus, detectedGesture, gestureIntent } = useGestureControls({
    enabled: gestureActive,
    videoRef: localVideoRef,
    onCommand: handleGestureCommand,
  });

  const downloadTestReport = () => {
    const now = performance.now();
    const startedAt = diagnostics.sessionStartedAt ? new Date(Date.now() - (now - diagnostics.sessionStartedAt)).toISOString() : "Not started";
    const connectedAfterMs = diagnostics.sessionStartedAt && diagnostics.connectedAt ? diagnostics.connectedAt - diagnostics.sessionStartedAt : null;
    const avgMotionLatency = average(diagnostics.motionLatenciesMs);
    const minMotionLatency = diagnostics.motionLatenciesMs.length ? Math.min(...diagnostics.motionLatenciesMs) : null;
    const maxMotionLatency = diagnostics.motionLatenciesMs.length ? Math.max(...diagnostics.motionLatenciesMs) : null;
    const report = [
      "Lucy Live Try-On Test Report",
      `Generated: ${new Date().toISOString()}`,
      "",
      "Session",
      `Model: Lucy VTON latest`,
      `SDK model dimensions: ${vtonModel.width} x ${vtonModel.height}`,
      `Requested resolution: ${outputResolution}`,
      `Actual output pixels: ${outputPixels}`,
      `Actual output FPS: ${diagnostics.outputFps ? Math.round(diagnostics.outputFps) : "Not reported"}`,
      `Started: ${startedAt}`,
      `Duration: ${formatDuration(diagnostics.sessionStartedAt, now)}`,
      `Connection latency: ${formatMilliseconds(connectedAfterMs)}`,
      `Latest garment/apply latency: ${formatMilliseconds(diagnostics.lastApplyLatencyMs)}`,
      `Latest apply prepare latency: ${formatMilliseconds(diagnostics.lastApplyPrepareLatencyMs)}`,
      `Latest Lucy set/connect latency: ${formatMilliseconds(diagnostics.lastApplySetLatencyMs)}`,
      `Selected garment: ${selectedGarment?.name ?? "None"}`,
      `Enhance prompt: ${enhance ? "On" : "Off"}`,
      "",
      "Input Camera",
      `Camera device: ${diagnostics.inputCamera.label ?? "Not reported"}`,
      `Input camera pixels: ${formatPixels(diagnostics.inputCamera.width, diagnostics.inputCamera.height)}`,
      `Input camera FPS: ${formatFps(diagnostics.inputCamera.frameRate)}`,
      `Input camera aspect ratio: ${diagnostics.inputCamera.aspectRatio ? diagnostics.inputCamera.aspectRatio.toFixed(3) : "Not reported"}`,
      `Input camera facing mode: ${diagnostics.inputCamera.facingMode ?? "Not reported"}`,
      "",
      "Motion Latency",
      `Latest motion latency: ${formatMilliseconds(diagnostics.lastMotionLatencyMs)}`,
      `Average motion latency: ${formatMilliseconds(avgMotionLatency)}`,
      `Minimum motion latency: ${formatMilliseconds(minMotionLatency)}`,
      `Maximum motion latency: ${formatMilliseconds(maxMotionLatency)}`,
      `Motion samples: ${diagnostics.motionLatenciesMs.length}`,
      `All motion samples ms: ${diagnostics.motionLatenciesMs.length ? diagnostics.motionLatenciesMs.map((value) => Math.round(value)).join(", ") : "None"}`,
      "",
      "Recording",
      `Recording duration shown in app: ${minutes}:${seconds}`,
      `Recording file size: ${formatBytes(diagnostics.recordingBytes)}`,
      "",
      "Prompt",
      generatedPrompt || "No prompt generated.",
      "",
      "Events",
      diagnostics.events.length ? diagnostics.events.join("\n") : "No events captured.",
      "",
      "Notes",
      "Motion latency is approximate. It is measured by detecting motion energy first in the local camera preview, then in the Lucy output video.",
      "Apply prepare latency is local/browser work such as loading the saved garment image and building the prompt.",
      "Lucy set/connect latency is the SDK update call for garment switches, or token + WebRTC + first remote stream work for the initial session.",
      "Decart credits/cost are not available inside this browser session unless Decart exposes account usage through API/dashboard.",
    ].join("\n");
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lucy-test-report-${outputResolution}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const updateLook = async () => {
    if (!realtimeRef.current?.isConnected() || !selectedGarment?.description) return;
    setIsApplying(true);
    try {
      const readyGarment = await ensureGarmentFile(selectedGarment);
      if (!readyGarment.file) throw new Error(`Could not prepare ${readyGarment.name} for Lucy.`);
      await realtimeRef.current.set({ image: readyGarment.file, prompt: generateVtonPrompt(readyGarment.description!), enhance });
      setMessage("Look instructions updated.");
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setIsApplying(false);
    }
  };

  const statusLabel = status === "live" ? "Live output" : status === "connecting" ? "Connecting" : status === "camera" ? "Camera ready" : "Offline";
  const minutes = Math.floor(recordingDuration / 60).toString().padStart(2, "0");
  const seconds = (recordingDuration % 60).toString().padStart(2, "0");
  const outputPixels = diagnostics.outputWidth && diagnostics.outputHeight ? `${diagnostics.outputWidth} x ${diagnostics.outputHeight}` : "Waiting";
  const gestureCue = gestureModelStatus === "ready" ? gestureIntent : null;
  const gestureCueIcon = gestureCue?.kind === "previous"
    ? <ArrowLeft size={22} />
    : gestureCue?.kind === "next"
      ? <ArrowRight size={22} />
      : gestureCue?.kind === "capture"
        ? <Camera size={22} />
        : <Hand size={22} />;
  const gestureProgressStyle = gestureCue
    ? ({ "--gesture-progress": gestureCue.progress.toString() } as CSSProperties)
    : undefined;
  const outputStageState = status === "connecting" || isApplying
    ? "working"
    : isOutputVideoReady
      ? "ready"
      : "";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={18} /></span>
          <span>Lucy Live Try-On</span>
        </div>
        <div className={`connection-badge ${status === "live" ? "connected" : ""}`}>
          <span className="status-dot" />
          {statusLabel}
        </div>
      </header>

      <main className="workspace">
        <aside className="wardrobe-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Your wardrobe</span>
              <h1>Garments</h1>
            </div>
            <button className="icon-button" type="button" title="Upload garments" onClick={() => fileInputRef.current?.click()}>
              <Plus size={19} />
            </button>
          </div>

          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp,text/plain,.txt"
            multiple
            onChange={(event) => {
              if (event.target.files) void addGarments(event.target.files);
              event.target.value = "";
            }}
          />

          {isWardrobeLoading ? (
            <div className="upload-zone loading-zone">
              <span className="upload-icon"><LoaderCircle className="spin" size={22} /></span>
              <strong>Loading wardrobe</strong>
              <span>Fetching saved garments</span>
            </div>
          ) : garments.length === 0 ? (
            <button className="upload-zone" type="button" onClick={() => fileInputRef.current?.click()}>
              <span className="upload-icon"><Upload size={22} /></span>
              <strong>Add garments + descriptions</strong>
              <span>Saved when image and TXT match</span>
            </button>
          ) : (
            <div className="garment-grid">
              {garments.map((garment) => (
                <div
                  className={`garment-card ${selectedId === garment.id ? "selected" : ""}`}
                  key={garment.id}
                  ref={(element) => {
                    if (element) garmentCardRefs.current.set(garment.id, element);
                    else garmentCardRefs.current.delete(garment.id);
                  }}
                >
                  <button type="button" className="garment-select" onClick={() => selectGarment(garment)} aria-label={`Try on ${garment.name}`}>
                    <img src={garment.previewUrl} alt={garment.name} />
                    {selectedId === garment.id && <span className="selected-mark"><Check size={14} /></span>}
                  </button>
                  <div className="garment-meta">
                    <span title={garment.name}>{garment.name}</span>
                    <span className={`description-dot ${garment.description ? "ready" : ""}`} title={garment.description ? "Description attached" : "Description missing"}>
                      <FileText size={13} />
                    </span>
                    <button type="button" title="Remove garment" onClick={() => void removeGarment(garment)}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="garment-guidance">
            <Shirt size={17} />
              <p>{isWardrobeSaving ? "Saving wardrobe changes..." : "Select an image and same-named text file together, such as jacket.jpg and jacket.txt."}</p>
          </div>
        </aside>

        <section className="studio">
          <div className="stage-grid">
            <div className={`video-stage local-stage ${localFrameAspect}-frame`}>
              <div className="stage-label"><Camera size={15} /> Camera</div>
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  setLocalFrameAspect(frameAspectFromSize(video.videoWidth, video.videoHeight));
                }}
              />
              {!localStreamRef.current && (
                <div className="stage-empty">
                  <CameraOff size={30} />
                  <span>Camera preview</span>
                </div>
              )}
            </div>

            <div className={`video-stage output-stage ${outputFrameAspect}-frame ${outputStageState}`}>
              <div className="stage-label"><Sparkles size={15} /> Lucy output</div>
              <video
                ref={outputVideoRef}
                autoPlay
                muted
                playsInline
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  setOutputFrameAspect(frameAspectFromSize(video.videoWidth, video.videoHeight));
                  captureOutputVideoMetrics("Output video metadata loaded");
                }}
                onLoadedData={() => {
                  setIsOutputVideoReady(true);
                  setStatus("live");
                  setMessage(selectedGarment ? `${selectedGarment.name} is now live.` : "Lucy output is live.");
                  captureOutputVideoMetrics("Output video first frame loaded");
                }}
                onPlaying={() => {
                  setIsOutputVideoReady(true);
                  captureOutputVideoMetrics("Output video playing");
                  startOutputFpsSampler();
                }}
                onError={() => {
                  setIsOutputVideoReady(false);
                  setMessage("Lucy output video could not render in the browser. Stop and start the live try-on again.");
                }}
              />
              {!isOutputVideoReady && (
                <div className="stage-empty output-empty">
                  {status === "connecting" || isOutputStreamAttached ? <LoaderCircle className="spin" size={31} /> : <Shirt size={31} />}
                  <span>
                    {isOutputStreamAttached
                      ? "Stream connected, waiting for video frames"
                      : status === "connecting"
                        ? "Preparing your look"
                        : "Your live try-on appears here"}
                  </span>
                </div>
              )}
              {isRecording && <div className="recording-indicator"><span /> REC {minutes}:{seconds}</div>}
              {captureFlashId > 0 && <div className="capture-flash" key={captureFlashId} />}
            </div>
          </div>

          <div className={`gesture-feedback ${gestureCue ? `visible ${gestureCue.kind}` : ""}`} aria-live="polite">
            {gestureCue ? (
              <>
                <span className="gesture-feedback-icon">{gestureCueIcon}</span>
                <span className="gesture-feedback-copy">
                  <strong>{gestureCue.label}</strong>
                  <small>{gestureCue.hint}</small>
                </span>
                <span className="gesture-progress" style={gestureProgressStyle} />
              </>
            ) : (
              <span className="gesture-feedback-copy">
                <strong>Gesture controls ready</strong>
                <small>Waiting for a clear command</small>
              </span>
            )}
          </div>

          {gestureCommandFlash && (
            <div className="gesture-command-flash" key={gestureCommandFlash.id}>
              <Check size={16} />
              {gestureCommandLabel(gestureCommandFlash.command)}
            </div>
          )}

          <div className={`notice ${status === "error" ? "notice-error" : ""}`}>
            <span className="notice-icon">{status === "error" ? "!" : status === "live" ? <Check size={14} /> : <Radio size={14} />}</span>
            <span>{message}</span>
          </div>

          <div className="control-bar">
            {!localStreamRef.current ? (
              <button className="primary-button" type="button" onClick={startCamera}>
                <Video size={18} /> Start camera
              </button>
            ) : (
              <button className="secondary-button" type="button" onClick={stopSession}>
                <CameraOff size={18} /> Stop camera
              </button>
            )}

            <button
              className={`primary-button ${status === "live" ? "" : "accent"}`}
              type="button"
              disabled={status === "connecting" || isApplying || (status !== "live" && (!localStreamRef.current || !selectedGarment?.description))}
              onClick={() => {
                if (status === "live") stopLiveTryOn();
                else void applyGarment();
              }}
            >
              {isApplying
                ? <LoaderCircle className="spin" size={18} />
                : status === "live"
                  ? <CircleStop size={18} />
                  : <Sparkles size={18} />}
              {status === "live" ? "Stop live try-on" : "Start live try-on"}
            </button>

            <div className="control-spacer" />
            {status === "live" && !isRecording && (
              <button className="record-button" type="button" onClick={startRecording}>
                <span /> Record
              </button>
            )}
            {isRecording && (
              <button className="record-button active" type="button" onClick={stopRecording}>
                <CircleStop size={18} /> Stop recording
              </button>
            )}
            {recordingUrl && !isRecording && (
              <button className="secondary-button" type="button" onClick={downloadRecording}>
                <Download size={18} /> Download
              </button>
            )}
            {capturedLookUrl && (
              <button className="secondary-button" type="button" onClick={downloadCapturedLook}>
                <Download size={18} /> Download photo
              </button>
            )}
          </div>
        </section>

        <aside className="settings-panel">
          <div className="panel-heading compact">
            <div>
              <span className="eyebrow">Fine tune</span>
              <h2>Look settings</h2>
            </div>
          </div>

          <input
            ref={descriptionInputRef}
            className="visually-hidden"
            type="file"
            accept="text/plain,.txt"
            multiple
            onChange={(event) => {
              if (event.target.files) void attachDescriptions(event.target.files);
              event.target.value = "";
            }}
          />

          <label className="field-label">Garment description</label>
          <div className={`description-status ${selectedGarment?.description ? "ready" : ""}`}>
            <FileText size={17} />
            <div>
              <strong>{selectedGarment?.description?.display_name ?? "No description attached"}</strong>
              <span>{selectedGarment?.descriptionFileName ?? "Upload the matching TXT file"}</span>
            </div>
          </div>
          <div className="description-actions">
            <button className="secondary-button" type="button" disabled={!selectedGarment} onClick={() => descriptionInputRef.current?.click()}>
              <Upload size={16} /> Attach TXT files
            </button>
            <a className="template-link" href="/garment-description-template.txt" download>
              <Download size={15} /> Template
            </a>
          </div>

          <label className="field-label prompt-label" htmlFor="prompt">Production VTON prompt</label>
          <textarea
            id="prompt"
            value={generatedPrompt || "Attach a garment description to generate the VTON prompt."}
            readOnly
            rows={6}
          />

          <label className="toggle-row">
            <span>
              <strong>Enhance prompt</strong>
              <small>Keep off for detailed descriptions</small>
            </span>
            <input type="checkbox" checked={enhance} onChange={(event) => setEnhance(event.target.checked)} />
            <span className="toggle" aria-hidden="true"><span /></span>
          </label>

          <label className="toggle-row gesture-toggle">
            <span>
              <strong>Hand gestures</strong>
              <small>Raise left/right hand, open palm, or hands on waist/lower belly</small>
            </span>
            <input type="checkbox" checked={gestureEnabled} onChange={(event) => setGestureEnabled(event.target.checked)} />
            <span className="toggle" aria-hidden="true"><span /></span>
          </label>

          <div className={`gesture-status ${gestureModelStatus}`}>
            {gestureModelStatus === "loading" ? <LoaderCircle className="spin" size={17} /> : <Hand size={17} />}
            <div>
              <strong>{gestureModelStatus === "ready" ? detectedGesture : gestureModelStatus === "loading" ? "Loading gestures" : gestureModelStatus === "error" ? "Gesture error" : "Gestures waiting"}</strong>
              <span>{!localStreamRef.current && gestureEnabled ? "Start the camera to enable gestures" : detectedGesture}</span>
            </div>
          </div>

          <label className="field-label" htmlFor="resolution">Output quality</label>
          <select
            id="resolution"
            className="select-input"
            value={outputResolution}
            disabled={status === "connecting" || status === "live"}
            onChange={(event) => setOutputResolution(event.target.value as OutputResolution)}
          >
            <option value="720p">720p - 1280 x 720</option>
            <option value="1080p">1080p - 1920 x 1080</option>
          </select>

          <button className="secondary-button full-width" type="button" disabled={status !== "live" || !selectedGarment?.description || isApplying} onClick={() => void updateLook()}>
            <RefreshCw size={17} /> Update live look
          </button>

          <div className="session-info">
            <h3>Session</h3>
            <div><span>Model</span><strong>Lucy VTON latest</strong></div>
            <div><span>Requested</span><strong>{outputResolution} live</strong></div>
            <div><span>Actual pixels</span><strong>{outputPixels}</strong></div>
            <div><span>Actual FPS</span><strong>{diagnostics.outputFps ? Math.round(diagnostics.outputFps) : "Waiting"}</strong></div>
            <div><span>Session time</span><strong>{formatDuration(diagnostics.sessionStartedAt, clockNow)}</strong></div>
            <div><span>Apply latency</span><strong>{formatMilliseconds(diagnostics.lastApplyLatencyMs)}</strong></div>
            <div><span>Prepare</span><strong>{formatMilliseconds(diagnostics.lastApplyPrepareLatencyMs)}</strong></div>
            <div><span>Lucy set</span><strong>{formatMilliseconds(diagnostics.lastApplySetLatencyMs)}</strong></div>
            <div><span>Motion latency</span><strong>{formatMilliseconds(diagnostics.lastMotionLatencyMs)}</strong></div>
            <div><span>Avg motion</span><strong>{formatMilliseconds(average(diagnostics.motionLatenciesMs))}</strong></div>
            <div><span>Motion samples</span><strong>{diagnostics.motionSamples}</strong></div>
            <div><span>Recording size</span><strong>{formatBytes(diagnostics.recordingBytes)}</strong></div>
            <div><span>Audio</span><strong><Mic size={13} /> Original mic</strong></div>
            <button className="secondary-button full-width report-button" type="button" disabled={!diagnostics.sessionStartedAt} onClick={downloadTestReport}>
              <Download size={17} /> Download test report
            </button>
          </div>
        </aside>
      </main>
    </div>
  );
}
