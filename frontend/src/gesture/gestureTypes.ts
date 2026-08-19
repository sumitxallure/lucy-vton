export type RecognizedGesture = "None" | "Open_Palm";
export type RecognizedPose = "None" | "Left_Hand_Raised" | "Right_Hand_Raised" | "Both_Hands_On_Waist";
export type GestureSource = "none" | "canned" | "landmarks";

export type GestureCommand =
  | "next-garment"
  | "previous-garment"
  | "toggle-live"
  | "capture-look";

export type GestureSample = {
  gesture: RecognizedGesture;
  gestureSource: GestureSource;
  extendedFingerCount: number;
  pose: RecognizedPose;
  confidence: number;
  poseConfidence: number;
  x: number | null;
  timestamp: number;
};

export type GestureWorkerRequest =
  | { type: "initialize" }
  | { type: "frame"; gestureBitmap: ImageBitmap; poseBitmap: ImageBitmap; timestamp: number };

export type GestureWorkerResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | ({ type: "result" } & GestureSample);
