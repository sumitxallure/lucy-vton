import type { GestureCommand, GestureSample } from "./gestureTypes";

const MIN_CONFIDENCE = 0.75;
const OPEN_PALM_HOLD_MS = 1200;
const THUMBS_UP_HOLD_MS = 900;
const SWIPE_WINDOW_MS = 900;
const SWIPE_DISTANCE = 0.18;
const STATIC_PALM_DISTANCE = 0.1;
const RELEASE_MS = 250;
const COMMAND_COOLDOWN_MS = 1800;

export class GestureInterpreter {
  private candidate: "open-palm" | "thumbs-up" | null = null;
  private candidateStartedAt = 0;
  private candidateStartX: number | null = null;
  private maxPalmDistance = 0;
  private awaitingRelease = false;
  private releaseStartedAt: number | null = null;
  private cooldownUntil = 0;

  reset() {
    this.candidate = null;
    this.candidateStartedAt = 0;
    this.candidateStartX = null;
    this.maxPalmDistance = 0;
    this.awaitingRelease = false;
    this.releaseStartedAt = null;
    this.cooldownUntil = 0;
  }

  push(sample: GestureSample): GestureCommand | null {
    const hasGesture = sample.gesture !== "None" && sample.confidence >= MIN_CONFIDENCE;

    if (!hasGesture) {
      this.clearCandidate();
      if (this.awaitingRelease) {
        this.releaseStartedAt ??= sample.timestamp;
        if (sample.timestamp - this.releaseStartedAt >= RELEASE_MS) {
          this.awaitingRelease = false;
          this.releaseStartedAt = null;
        }
      }
      return null;
    }

    this.releaseStartedAt = null;
    if (this.awaitingRelease || sample.timestamp < this.cooldownUntil) return null;

    if (sample.gesture === "Thumb_Up") {
      if (this.candidate !== "thumbs-up") this.beginCandidate("thumbs-up", sample);
      if (sample.timestamp - this.candidateStartedAt >= THUMBS_UP_HOLD_MS) {
        return this.complete("capture-look", sample.timestamp);
      }
      return null;
    }

    if (sample.gesture !== "Open_Palm" || sample.x === null) {
      this.clearCandidate();
      return null;
    }

    if (this.candidate !== "open-palm" || this.candidateStartX === null) {
      this.beginCandidate("open-palm", sample);
      return null;
    }

    const elapsed = sample.timestamp - this.candidateStartedAt;
    const distance = sample.x - this.candidateStartX;
    this.maxPalmDistance = Math.max(this.maxPalmDistance, Math.abs(distance));

    if (elapsed <= SWIPE_WINDOW_MS && Math.abs(distance) >= SWIPE_DISTANCE) {
      return this.complete(distance < 0 ? "next-garment" : "previous-garment", sample.timestamp);
    }

    if (elapsed >= OPEN_PALM_HOLD_MS && this.maxPalmDistance <= STATIC_PALM_DISTANCE) {
      return this.complete("toggle-live", sample.timestamp);
    }

    if (elapsed > OPEN_PALM_HOLD_MS + 1000) this.beginCandidate("open-palm", sample);
    return null;
  }

  private beginCandidate(candidate: "open-palm" | "thumbs-up", sample: GestureSample) {
    this.candidate = candidate;
    this.candidateStartedAt = sample.timestamp;
    this.candidateStartX = sample.x;
    this.maxPalmDistance = 0;
  }

  private clearCandidate() {
    this.candidate = null;
    this.candidateStartedAt = 0;
    this.candidateStartX = null;
    this.maxPalmDistance = 0;
  }

  private complete(command: GestureCommand, timestamp: number) {
    this.clearCandidate();
    this.awaitingRelease = true;
    this.cooldownUntil = timestamp + COMMAND_COOLDOWN_MS;
    return command;
  }
}
