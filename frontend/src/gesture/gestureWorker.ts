/// <reference lib="webworker" />

import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";
import type { GestureWorkerRequest, GestureWorkerResponse, RecognizedGesture } from "./gestureTypes";

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";

let recognizer: GestureRecognizer | null = null;

function post(message: GestureWorkerResponse) {
  self.postMessage(message);
}

async function initialize() {
  if (recognizer) {
    post({ type: "ready" });
    return;
  }

  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  recognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
    cannedGesturesClassifierOptions: {
      categoryAllowlist: ["Open_Palm", "Thumb_Up"],
      scoreThreshold: 0.6,
    },
  });
  post({ type: "ready" });
}

function recognize(bitmap: ImageBitmap, timestamp: number) {
  try {
    if (!recognizer) throw new Error("Gesture recognizer is not ready.");
    const result = recognizer.recognizeForVideo(bitmap, timestamp);
    const category = result.gestures[0]?.[0];
    const landmarks = result.landmarks[0];
    const palmIndices = [0, 5, 9, 13, 17];
    const palmX = landmarks
      ? palmIndices.reduce((total, index) => total + landmarks[index].x, 0) / palmIndices.length
      : null;
    const gesture = category?.categoryName === "Open_Palm" || category?.categoryName === "Thumb_Up"
      ? category.categoryName as RecognizedGesture
      : "None";

    post({
      type: "result",
      gesture,
      confidence: category?.score ?? 0,
      x: palmX,
      timestamp,
    });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (event: MessageEvent<GestureWorkerRequest>) => {
  const request = event.data;
  if (request.type === "initialize") {
    void initialize().catch((error) => {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }

  try {
    recognize(request.bitmap, request.timestamp);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

export {};
