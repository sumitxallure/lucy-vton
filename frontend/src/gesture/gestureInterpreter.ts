import type { GestureCommand, GestureSample } from "./gestureTypes";

const MIN_CONFIDENCE = 0.55;
const MIN_POSE_CONFIDENCE = 0.55;
const OPEN_PALM_HOLD_MS = 850;
const WAIST_CAPTURE_HOLD_MS = 1000;
const RAISED_HAND_HOLD_MS = 650;
const CANDIDATE_GRACE_MS = 650;
const RELEASE_MS = 850;
const COMMAND_COOLDOWN_MS = 2600;

export class GestureInterpreter {
  private candidate: "open-palm" | "waist-capture" | "left-hand-raised" | "right-hand-raised" | null = null;
  private candidateStartedAt = 0;
  private candidateLastSeenAt = 0;
  private awaitingRelease = false;
  private releaseStartedAt: number | null = null;
  private cooldownUntil = 0;

  reset() {
    this.candidate = null;
    this.candidateStartedAt = 0;
    this.candidateLastSeenAt = 0;
    this.awaitingRelease = false;
    this.releaseStartedAt = null;
    this.cooldownUntil = 0;
  }

  push(sample: GestureSample): GestureCommand | null {
    const hasGesture = (
      sample.gesture === "Open_Palm" && sample.confidence >= MIN_CONFIDENCE
    );
    const hasPose = sample.pose !== "None" && sample.poseConfidence >= MIN_POSE_CONFIDENCE;

    if (!hasGesture && !hasPose) {
      if (this.candidate && sample.timestamp - this.candidateLastSeenAt > CANDIDATE_GRACE_MS) {
        this.clearCandidate();
      }
      if (this.awaitingRelease) {
        this.releaseStartedAt ??= sample.timestamp;
        if (sample.timestamp - this.releaseStartedAt >= RELEASE_MS) {
          this.awaitingRelease = false;
          this.releaseStartedAt = null;
        }
      }
      return null;
    }

    if (this.awaitingRelease) {
      this.releaseStartedAt = null;
      return null;
    }

    this.releaseStartedAt = null;
    if (sample.timestamp < this.cooldownUntil) return null;

    if (sample.pose === "Left_Hand_Raised" && sample.poseConfidence >= MIN_POSE_CONFIDENCE) {
      if (this.candidate !== "left-hand-raised") this.beginCandidate("left-hand-raised", sample);
      else this.candidateLastSeenAt = sample.timestamp;
      if (sample.timestamp - this.candidateStartedAt >= RAISED_HAND_HOLD_MS) {
        return this.complete("previous-garment", sample.timestamp);
      }
      return null;
    }

    if (sample.pose === "Right_Hand_Raised" && sample.poseConfidence >= MIN_POSE_CONFIDENCE) {
      if (this.candidate !== "right-hand-raised") this.beginCandidate("right-hand-raised", sample);
      else this.candidateLastSeenAt = sample.timestamp;
      if (sample.timestamp - this.candidateStartedAt >= RAISED_HAND_HOLD_MS) {
        return this.complete("next-garment", sample.timestamp);
      }
      return null;
    }

    if (sample.pose === "Both_Hands_On_Waist" && sample.poseConfidence >= MIN_POSE_CONFIDENCE) {
      if (this.candidate !== "waist-capture") this.beginCandidate("waist-capture", sample);
      else this.candidateLastSeenAt = sample.timestamp;
      if (sample.timestamp - this.candidateStartedAt >= WAIST_CAPTURE_HOLD_MS) {
        return this.complete("capture-look", sample.timestamp);
      }
      return null;
    }

    if (sample.gesture === "Open_Palm" && sample.confidence >= MIN_CONFIDENCE) {
      if (this.candidate !== "open-palm") {
        this.beginCandidate("open-palm", sample);
        return null;
      }

      this.candidateLastSeenAt = sample.timestamp;
      const elapsed = sample.timestamp - this.candidateStartedAt;

      if (elapsed >= OPEN_PALM_HOLD_MS) {
        return this.complete("toggle-live", sample.timestamp);
      }

      return null;
    }

    this.clearCandidate();
    return null;
  }

  private beginCandidate(candidate: "open-palm" | "waist-capture" | "left-hand-raised" | "right-hand-raised", sample: GestureSample) {
    this.candidate = candidate;
    this.candidateStartedAt = sample.timestamp;
    this.candidateLastSeenAt = sample.timestamp;
  }

  private clearCandidate() {
    this.candidate = null;
    this.candidateStartedAt = 0;
    this.candidateLastSeenAt = 0;
  }

  private complete(command: GestureCommand, timestamp: number) {
    this.clearCandidate();
    this.awaitingRelease = true;
    this.cooldownUntil = timestamp + COMMAND_COOLDOWN_MS;
    return command;
  }
}
