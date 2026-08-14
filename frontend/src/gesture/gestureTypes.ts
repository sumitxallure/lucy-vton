export type RecognizedGesture = "None" | "Open_Palm" | "Thumb_Up";

export type GestureCommand =
  | "next-garment"
  | "previous-garment"
  | "toggle-live"
  | "capture-look";

export type GestureSample = {
  gesture: RecognizedGesture;
  confidence: number;
  x: number | null;
  timestamp: number;
};

export type GestureWorkerRequest =
  | { type: "initialize" }
  | { type: "frame"; bitmap: ImageBitmap; timestamp: number };

export type GestureWorkerResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | ({ type: "result" } & GestureSample);
