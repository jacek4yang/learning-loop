import type { ReviewGrade } from "./schema";

export interface ReviewState {
  readonly due: string;
  readonly intervalDays: number;
  readonly easePermille: number;
  readonly repetitions: number;
  readonly lastReviewed?: string;
}

export function initialReviewState(today: string): ReviewState {
  requireDate(today);
  return {
    due: today,
    intervalDays: 0,
    easePermille: 2_300,
    repetitions: 0,
  };
}

export function scheduleReview(
  current: ReviewState,
  grade: ReviewGrade,
  today: string,
): ReviewState {
  requireDate(today);
  const interval = nextInterval(current, grade);
  const ease = nextEase(current.easePermille, grade);
  const repetitions = grade === "不会" ? 0 : current.repetitions + 1;
  return {
    due: addDays(today, interval),
    intervalDays: interval,
    easePermille: ease,
    repetitions,
    lastReviewed: today,
  };
}

export function isDue(state: ReviewState, today: string): boolean {
  requireDate(today);
  requireDate(state.due);
  return state.due <= today;
}

function nextInterval(current: ReviewState, grade: ReviewGrade): number {
  if (grade === "不会") {
    return 1;
  }
  if (grade === "模糊") {
    return boundedInterval(
      Math.round(Math.max(1, current.intervalDays) * 1.5),
    );
  }
  if (current.repetitions === 0) {
    return 3;
  }
  if (current.repetitions === 1) {
    return 7;
  }
  return boundedInterval(
    Math.max(
      current.intervalDays + 1,
      Math.round(current.intervalDays * current.easePermille / 1_000),
    ),
  );
}

function boundedInterval(value: number): number {
  return Math.max(1, Math.min(3_650, value));
}

function nextEase(ease: number, grade: ReviewGrade): number {
  const delta = grade === "不会" ? -200 : grade === "模糊" ? -50 : 50;
  return Math.max(1_300, Math.min(3_000, ease + delta));
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function requireDate(value: string): void {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value)
    || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("invalid review date");
  }
}
