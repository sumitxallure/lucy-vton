import { useEffect, useRef, useState, type RefObject } from "react";
import { GestureInterpreter } from "./gestureInterpreter";
import type { GestureCommand, GestureWorkerRequest, GestureWorkerResponse } from "./gestureTypes";

type GestureModelStatus = "disabled" | "loading" | "ready" | "error";

type UseGestureControlsOptions = {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  onCommand: (command: GestureCommand) => void;
};

const FRAME_INTERVAL_MS = 90;
const DEBUG_LOG_INTERVAL_MS = 500;

export function useGestureControls({ enabled, videoRef, onCommand }: UseGestureControlsOptions) {
  const [modelStatus, setModelStatus] = useState<GestureModelStatus>(enabled ? "loading" : "disabled");
  const [detectedGesture, setDetectedGesture] = useState("No hand detected");
  const commandRef = useRef(onCommand);

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    if (!enabled) {
      setModelStatus("disabled");
      setDetectedGesture("Gesture controls are off");
      return undefined;
    }

    const worker = new Worker("/gesture-worker.js");
    const interpreter = new GestureInterpreter();
    let stopped = false;
    let ready = false;
    let frameInFlight = false;
    let timer: number | null = null;
    let framesSent = 0;
    let resultsReceived = 0;
    let lastLogAt = 0;

    const scheduleFrame = () => {
      if (stopped || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void sendFrame();
      }, FRAME_INTERVAL_MS);
    };

    const sendFrame = async () => {
      const video = videoRef.current;
      if (stopped || !ready || frameInFlight || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        scheduleFrame();
        return;
      }

      frameInFlight = true;
      try {
        const [gestureBitmap, poseBitmap] = await Promise.all([
          createImageBitmap(video),
          createImageBitmap(video),
        ]);
        const request: GestureWorkerRequest = { type: "frame", gestureBitmap, poseBitmap, timestamp: performance.now() };
        framesSent += 1;
        if (framesSent === 1) {
          console.info("[gesture] first frame sent", {
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            readyState: video.readyState,
          });
        }
        worker.postMessage(request, [gestureBitmap, poseBitmap]);
      } catch (error) {
        console.warn("[gesture] failed to create/send frame", error);
        frameInFlight = false;
        scheduleFrame();
      }
    };

    worker.onmessage = (event: MessageEvent<GestureWorkerResponse>) => {
      const response = event.data;
      if (response.type === "ready") {
        ready = true;
        console.info("[gesture] worker ready");
        setModelStatus("ready");
        setDetectedGesture("Ready for a gesture");
        scheduleFrame();
        return;
      }
      if (response.type === "error") {
        frameInFlight = false;
        console.error("[gesture] worker error", response.message);
        setModelStatus("error");
        setDetectedGesture(response.message);
        return;
      }

      frameInFlight = false;
      resultsReceived += 1;
      const now = performance.now();
      if (now - lastLogAt >= DEBUG_LOG_INTERVAL_MS || response.gesture !== "None") {
        lastLogAt = now;
        console.info("[gesture] result", {
          gesture: response.gesture,
          gestureSource: response.gestureSource,
          extendedFingerCount: response.extendedFingerCount,
          confidence: Number(response.confidence.toFixed(3)),
          pose: response.pose,
          poseConfidence: Number(response.poseConfidence.toFixed(3)),
          x: response.x === null ? null : Number(response.x.toFixed(3)),
          framesSent,
          resultsReceived,
        });
      }
      const readableGesture = response.gesture === "Open_Palm"
        ? "Open palm"
        : response.gesture === "Thumb_Up"
          ? "Thumbs up"
          : response.pose === "Left_Hand_Raised"
            ? "Left hand raised"
            : response.pose === "Right_Hand_Raised"
              ? "Right hand raised"
              : "No gesture detected";
      setDetectedGesture(readableGesture);

      // The local preview is mirrored, so use mirrored coordinates for intuitive swipes.
      const command = interpreter.push({
        ...response,
        x: response.x === null ? null : 1 - response.x,
      });
      if (command) {
        console.info("[gesture] command", command);
        commandRef.current(command);
      }
      scheduleFrame();
    };

    worker.onerror = (event) => {
      frameInFlight = false;
      console.error("[gesture] worker onerror", event.message || event);
      setModelStatus("error");
      setDetectedGesture(event.message || "Gesture recognition failed to load.");
    };

    console.info("[gesture] starting worker");
    setModelStatus("loading");
    setDetectedGesture("Loading gesture recognition");
    const initializeRequest: GestureWorkerRequest = { type: "initialize" };
    worker.postMessage(initializeRequest);

    return () => {
      stopped = true;
      console.info("[gesture] stopping worker", { framesSent, resultsReceived });
      if (timer !== null) window.clearTimeout(timer);
      interpreter.reset();
      worker.terminate();
    };
  }, [enabled, videoRef]);

  return { modelStatus, detectedGesture };
}
