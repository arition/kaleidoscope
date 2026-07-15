export const MAX_TIME_INPUT_LENGTH = 32;

function clampFrame(frame: bigint, numFrames: number): number {
  if (frame <= 0n) {
    return 0;
  }
  const lastFrame = BigInt(numFrames - 1);
  return Number(frame >= lastFrame ? lastFrame : frame);
}

function floorDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n
    ? quotient - 1n
    : quotient;
}

function frameFromScaledSeconds(
  numerator: bigint,
  denominator: bigint,
  fpsNum: number,
  fpsDen: number,
  numFrames: number,
): number {
  const frame = floorDivide(
    numerator * BigInt(fpsNum),
    denominator * BigInt(fpsDen),
  );
  return clampFrame(frame, numFrames);
}

export function frameFromTime(
  milliseconds: number,
  fpsNum: number,
  fpsDen: number,
  numFrames: number,
): number {
  if (!Number.isFinite(milliseconds)) {
    return milliseconds < 0 ? 0 : numFrames - 1;
  }
  return frameFromScaledSeconds(
    BigInt(Math.trunc(milliseconds)),
    1000n,
    fpsNum,
    fpsDen,
    numFrames,
  );
}

interface ScaledSeconds {
  numerator: bigint;
  denominator: bigint;
}

function decimalScale(fraction: string): bigint {
  return 10n ** BigInt(fraction.length);
}

function parseScaledSeconds(value: string): ScaledSeconds | undefined {
  if (value.length > MAX_TIME_INPUT_LENGTH) {
    return undefined;
  }
  const trimmed = value.trim();
  const clockMatch = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(trimmed);
  if (clockMatch !== null) {
    const [, hoursText, minutesText, secondsText, fractionText = ""] = clockMatch;
    const minutes = Number(minutesText);
    const seconds = Number(secondsText);
    if (minutes >= 60 || seconds >= 60) {
      return undefined;
    }
    const denominator = decimalScale(fractionText);
    const wholeSeconds =
      (BigInt(hoursText) * 60n + BigInt(minutes)) * 60n + BigInt(seconds);
    return {
      numerator:
        wholeSeconds * denominator + BigInt(fractionText === "" ? "0" : fractionText),
      denominator,
    };
  }

  const decimalMatch = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (decimalMatch === null) {
    return undefined;
  }
  const [, sign, wholeText, fractionText = ""] = decimalMatch;
  const denominator = decimalScale(fractionText);
  const magnitude =
    BigInt(wholeText) * denominator +
    BigInt(fractionText === "" ? "0" : fractionText);
  return {
    numerator: sign === "-" ? -magnitude : magnitude,
    denominator,
  };
}

export function parseTimeToFrame(
  value: string,
  fpsNum: number,
  fpsDen: number,
  numFrames: number,
): number | undefined {
  const time = parseScaledSeconds(value);
  return time === undefined
    ? undefined
    : frameFromScaledSeconds(
        time.numerator,
        time.denominator,
        fpsNum,
        fpsDen,
        numFrames,
      );
}

export function offsetFrameBySeconds(
  frame: number,
  seconds: number,
  fpsNum: number,
  fpsDen: number,
  numFrames: number,
): number {
  const frameOffset = floorDivide(
    BigInt(Math.trunc(seconds)) * BigInt(fpsNum),
    BigInt(fpsDen),
  );
  return clampFrame(BigInt(frame) + frameOffset, numFrames);
}

export function formatFrameTime(
  frame: number,
  fpsNum: number,
  fpsDen: number,
): string {
  let precision = 3;
  let scale = 1000n;
  while (scale * BigInt(fpsDen) < BigInt(fpsNum)) {
    precision += 1;
    scale *= 10n;
  }
  const numerator = BigInt(frame) * BigInt(fpsDen) * scale;
  const denominator = BigInt(fpsNum);
  const ticks = (numerator + denominator - 1n) / denominator;
  const totalSeconds = ticks / scale;
  const hours = totalSeconds / 3600n;
  const minutes = (totalSeconds % 3600n) / 60n;
  const seconds = totalSeconds % 60n;
  const fraction = ticks % scale;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${fraction.toString().padStart(precision, "0")}`;
}