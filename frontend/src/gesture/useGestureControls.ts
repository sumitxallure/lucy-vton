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

    const worker = new Worker(new URL("./gestureWorker.ts", import.meta.url), { type: "module" });
    const interpreter = new GestureInterpreter();
    let stopped = false;
    let ready = false;
    let frameInFlight = false;
    let timer: number | null = null;

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
        const bitmap = await createImageBitmap(video);
        const request: GestureWorkerRequest = { type: "frame", bitmap, timestamp: performance.now() };
        worker.postMessage(request, [bitmap]);
      } catch {
        frameInFlight = false;
        scheduleFrame();
      }
    };

    worker.onmessage = (event: MessageEvent<GestureWorkerResponse>) => {
      const response = event.data;
      if (response.type === "ready") {
        ready = true;
        setModelStatus("ready");
        setDetectedGesture("Ready for a gesture");
        scheduleFrame();
        return;
      }
      if (response.type === "error") {
        frameInFlight = false;
        setModelStatus("error");
        setDetectedGesture(response.message);
        return;
      }

      frameInFlight = false;
      const readableGesture = response.gesture === "Open_Palm"
        ? "Open palm"
        : response.gesture === "Thumb_Up"
          ? "Thumbs up"
          : "No hand detected";
      setDetectedGesture(readableGesture);

      // The local preview is mirrored, so use mirrored coordinates for intuitive swipes.
      const command = interpreter.push({
        ...response,
        x: response.x === null ? null : 1 - response.x,
      });
      if (command) commandRef.current(command);
      scheduleFrame();
    };

    worker.onerror = (event) => {
      frameInFlight = false;
      setModelStatus("error");
      setDetectedGesture(event.message || "Gesture recognition failed to load.");
    };

    setModelStatus("loading");
    setDetectedGesture("Loading gesture recognition");
    const initializeRequest: GestureWorkerRequest = { type: "initialize" };
    worker.postMessage(initializeRequest);

    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      interpreter.reset();
      worker.terminate();
    };
  }, [enabled, videoRef]);

  return { modelStatus, detectedGesture };
}
