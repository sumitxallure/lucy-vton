/* global Vision */

const VISION_BUNDLE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.js";
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const GESTURE_MODEL_URL = "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

let gestureRecognizer = null;
let poseLandmarker = null;
let loading = null;
let framesProcessed = 0;

function post(message) {
  self.postMessage(message);
}

async function initialize() {
  if (gestureRecognizer && poseLandmarker) {
    post({ type: "ready" });
    return;
  }

  if (loading) {
    await loading;
    post({ type: "ready" });
    return;
  }

  loading = (async () => {
    console.info("[gesture-worker] loading MediaPipe bundle");
    importScripts(VISION_BUNDLE_URL);

    console.info("[gesture-worker] loading MediaPipe wasm");
    const vision = await Vision.FilesetResolver.forVisionTasks(WASM_ROOT);

    console.info("[gesture-worker] loading gesture model");
    gestureRecognizer = await Vision.GestureRecognizer.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: GESTURE_MODEL_URL,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      cannedGesturesClassifierOptions: {
        categoryAllowlist: ["Open_Palm"],
        scoreThreshold: 0.3,
      },
    });

    console.info("[gesture-worker] loading pose model");
    poseLandmarker = await Vision.PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: POSE_MODEL_URL,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    console.info("[gesture-worker] gesture model ready");
  })();

  await loading;
  post({ type: "ready" });
}

function recognize(gestureBitmap, poseBitmap, timestamp) {
  try {
    if (!gestureRecognizer || !poseLandmarker) throw new Error("Gesture recognition is not ready.");
    const result = gestureRecognizer.recognizeForVideo(gestureBitmap, timestamp);
    const poseResult = poseLandmarker.detectForVideo(poseBitmap, timestamp);
    framesProcessed += 1;
    const category = result.gestures[0]?.[0];
    const landmarks = result.landmarks[0];
    const palmIndices = [0, 5, 9, 13, 17];
    const palmX = landmarks
      ? palmIndices.reduce((total, index) => total + landmarks[index].x, 0) / palmIndices.length
      : null;
    const landmarkPalm = getLandmarkOpenPalm(result.worldLandmarks[0] || landmarks);
    const recognizedGesture = resolveGesture(category, landmarkPalm);
    const pose = getPoseCommand(poseResult.landmarks[0]);

    post({
      type: "result",
      gesture: recognizedGesture.gesture,
      gestureSource: recognizedGesture.source,
      extendedFingerCount: landmarkPalm.extendedFingerCount,
      pose: pose.pose,
      confidence: recognizedGesture.confidence,
      poseConfidence: pose.confidence,
      x: palmX,
      timestamp,
    });
  } finally {
    gestureBitmap.close();
    poseBitmap.close();
  }
}

function resolveGesture(category, landmarkPalm) {
  if (category?.categoryName === "Open_Palm") {
    if (landmarkPalm.isOpen && landmarkPalm.confidence > (category.score ?? 0)) {
      return { gesture: "Open_Palm", confidence: landmarkPalm.confidence, source: "landmarks" };
    }
    return { gesture: "Open_Palm", confidence: category.score ?? 0, source: "canned" };
  }

  if (landmarkPalm.isOpen) {
    return { gesture: "Open_Palm", confidence: landmarkPalm.confidence, source: "landmarks" };
  }

  return { gesture: "None", confidence: category?.score ?? 0, source: "none" };
}

function getPoseCommand(landmarks) {
  const raisedHand = getRaisedHand(landmarks);
  if (raisedHand.pose !== "None") return raisedHand;

  const waistPose = getHandsOnWaist(landmarks);
  if (waistPose.confidence >= 0.55) {
    return { pose: "Both_Hands_On_Waist", confidence: waistPose.confidence };
  }

  return { pose: "None", confidence: Math.max(raisedHand.confidence, waistPose.confidence) };
}

function getLandmarkOpenPalm(landmarks) {
  if (!landmarks || landmarks.length < 21) {
    return { isOpen: false, confidence: 0, extendedFingerCount: 0 };
  }

  // Joint angles work even when the palm is rotated; requiring three fingers
  // also keeps a thumbs-up or victory sign from becoming an open-palm command.
  const fingers = [
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
  ];
  const wrist = landmarks[0];
  const fingerScores = fingers.map(([mcpIndex, pipIndex, dipIndex, tipIndex]) => {
    const mcp = landmarks[mcpIndex];
    const pip = landmarks[pipIndex];
    const dip = landmarks[dipIndex];
    const tip = landmarks[tipIndex];
    const pipAngle = jointAngle(mcp, pip, dip);
    const dipAngle = jointAngle(pip, dip, tip);
    const reachRatio = distance(wrist, tip) / Math.max(distance(wrist, mcp), 0.0001);
    const isExtended = pipAngle >= 145 && dipAngle >= 140 && reachRatio >= 1.25;
    const straightness = Math.min(1, Math.max(0, (Math.min(pipAngle, dipAngle) - 120) / 55));
    return { isExtended, straightness };
  });
  const extendedFingerCount = fingerScores.filter((finger) => finger.isExtended).length;
  const averageStraightness = fingerScores.reduce((total, finger) => total + finger.straightness, 0) / fingers.length;
  const confidence = extendedFingerCount >= 4
    ? Math.min(0.92, 0.72 + averageStraightness * 0.2)
    : extendedFingerCount === 3
      ? Math.min(0.74, 0.58 + averageStraightness * 0.15)
      : 0;

  return {
    isOpen: extendedFingerCount >= 3,
    confidence,
    extendedFingerCount,
  };
}

function jointAngle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const denominator = vectorLength(ab) * vectorLength(cb);
  if (denominator <= 0.000001) return 0;
  const cosine = Math.max(-1, Math.min(1, dot(ab, cb) / denominator));
  return Math.acos(cosine) * (180 / Math.PI);
}

function distance(a, b) {
  return vectorLength({
    x: a.x - b.x,
    y: a.y - b.y,
    z: (a.z ?? 0) - (b.z ?? 0),
  });
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function vectorLength(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function getRaisedHand(landmarks) {
  if (!landmarks) return { pose: "None", confidence: 0 };

  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];

  const leftScore = scoreRaisedHand(leftWrist, leftShoulder);
  const rightScore = scoreRaisedHand(rightWrist, rightShoulder);

  if (leftScore < 0.55 && rightScore < 0.55) return { pose: "None", confidence: Math.max(leftScore, rightScore) };
  if (leftScore >= rightScore + 0.08) return { pose: "Left_Hand_Raised", confidence: leftScore };
  if (rightScore >= leftScore + 0.08) return { pose: "Right_Hand_Raised", confidence: rightScore };

  return { pose: "None", confidence: Math.max(leftScore, rightScore) };
}

function getHandsOnWaist(landmarks) {
  if (!landmarks) return { confidence: 0 };

  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftElbow = landmarks[13];
  const rightElbow = landmarks[14];
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  const required = [leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, leftHip, rightHip];
  if (required.some((point) => !point || (point.visibility ?? 0) < 0.35)) return { confidence: 0 };

  const shoulderWidth = Math.max(distance2d(leftShoulder, rightShoulder), 0.08);
  const torsoHeight = Math.max(((leftHip.y + rightHip.y) / 2) - ((leftShoulder.y + rightShoulder.y) / 2), 0.12);
  const midX = (leftHip.x + rightHip.x) / 2;
  const leftScore = scoreHandOnWaistSide(leftWrist, leftElbow, leftShoulder, leftHip, midX, shoulderWidth, torsoHeight);
  const rightScore = scoreHandOnWaistSide(rightWrist, rightElbow, rightShoulder, rightHip, midX, shoulderWidth, torsoHeight);
  const bothScore = Math.min(leftScore, rightScore);
  const balancePenalty = Math.abs(leftScore - rightScore) * 0.25;

  return { confidence: Math.max(0, Math.min(1, bothScore - balancePenalty)) };
}

function scoreHandOnWaistSide(wrist, elbow, shoulder, hip, midX, shoulderWidth, torsoHeight) {
  const wristVisibility = wrist.visibility ?? 0;
  const elbowVisibility = elbow.visibility ?? 0;
  const hipVisibility = hip.visibility ?? 0;
  if (wristVisibility < 0.35 || elbowVisibility < 0.35 || hipVisibility < 0.35) return 0;

  const waistTargetX = hip.x * 0.65 + midX * 0.35;
  const waistTargetY = shoulder.y + torsoHeight * 0.68;
  const dx = Math.abs(wrist.x - waistTargetX);
  const dy = Math.abs(wrist.y - waistTargetY);
  const wristNearWaist = 1 - clamp01((dx / (shoulderWidth * 0.78) + dy / (torsoHeight * 0.52)) / 2);
  const wristInWaistBand = wrist.y > shoulder.y + torsoHeight * 0.34 && wrist.y < hip.y + torsoHeight * 0.16;
  const elbowOutsideWrist = Math.abs(elbow.x - midX) > Math.abs(wrist.x - midX) + shoulderWidth * 0.05;
  const elbowInUpperTorso = elbow.y > shoulder.y + torsoHeight * 0.1 && elbow.y < hip.y + torsoHeight * 0.18 ? 1 : 0;
  const elbowAngle = jointAngle(shoulder, elbow, wrist);
  const elbowBent = elbowAngle >= 45 && elbowAngle <= 145;
  const visibilityScore = Math.min(wristVisibility, elbowVisibility, hipVisibility);
  if (wristNearWaist < 0.42 || !wristInWaistBand || !elbowBent) return 0;

  const elbowBendScore = 1 - clamp01(Math.abs(elbowAngle - 95) / 55);
  const elbowIntentScore = elbowOutsideWrist ? 0.14 : 0.04;
  return Math.min(1, wristNearWaist * 0.46 + 0.2 + elbowIntentScore + elbowBendScore * 0.12 + elbowInUpperTorso * 0.03 + visibilityScore * 0.05);
}

function scoreRaisedHand(wrist, shoulder) {
  if (!wrist || !shoulder) return 0;
  const wristVisibility = wrist.visibility ?? 0;
  const shoulderVisibility = shoulder.visibility ?? 0;
  if (wristVisibility < 0.35 || shoulderVisibility < 0.35) return 0;

  const verticalLift = shoulder.y - wrist.y;
  if (verticalLift < 0.08) return 0;

  const liftScore = Math.min(1, verticalLift / 0.22);
  const visibilityScore = Math.min(wristVisibility, shoulderVisibility);
  return Math.min(1, liftScore * 0.75 + visibilityScore * 0.25);
}

self.onmessage = (event) => {
  const request = event.data;
  if (request.type === "initialize") {
    void initialize().catch((error) => {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }

  try {
    recognize(request.gestureBitmap, request.poseBitmap, request.timestamp);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
