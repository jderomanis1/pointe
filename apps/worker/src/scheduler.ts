import type { DurableObjectStorage } from '@cloudflare/workers-types';

/**
 * Reusable storage-backed alarm scheduler for the Room Durable Object.
 *
 * A DO has exactly one alarm. Naive setAlarm() calls collide — last writer
 * wins, siblings silently never fire. This module multiplexes the single
 * alarm across an arbitrary list of pending tasks: each schedule/cancel
 * recomputes MIN(at) and arms (or clears) the alarm to match.
 *
 * The scheduler is domain-agnostic. It dispatches by `type` string through
 * a caller-supplied function — S7.i registers only the synthetic `__test_marker`
 * for tests; consumers like `host_vacant` (S7.ii) extend the switch.
 *
 * Handlers MUST be idempotent: re-firing a task (e.g. after a transient error
 * that prevented deletion) should be safe. Consumers re-check current state
 * before acting (see HostVacancy in S7.ii).
 */

export type ScheduledTask = {
  id: string;
  at: number;
  type: string;
  payload: unknown;
};

/** Subset of DurableObjectStorage the scheduler needs. */
export type SchedulerStorage = Pick<
  DurableObjectStorage,
  'sql' | 'setAlarm' | 'getAlarm' | 'deleteAlarm'
>;

/** Schedule a task to fire at or after `at` (ms epoch). Returns the task id. */
export async function scheduleTask(
  storage: SchedulerStorage,
  type: string,
  at: number,
  payload?: unknown,
): Promise<string> {
  const id = crypto.randomUUID();
  storage.sql.exec(
    `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
    id,
    at,
    type,
    payload === undefined ? null : JSON.stringify(payload),
  );
  await rescheduleAlarm(storage);
  return id;
}

/** Cancel a single task by id. No-op if it doesn't exist. */
export async function cancelTask(storage: SchedulerStorage, id: string): Promise<void> {
  storage.sql.exec(`DELETE FROM scheduled_task WHERE id = ?`, id);
  await rescheduleAlarm(storage);
}

/** Cancel every pending task of a given type. */
export async function cancelTasksByType(storage: SchedulerStorage, type: string): Promise<void> {
  storage.sql.exec(`DELETE FROM scheduled_task WHERE type = ?`, type);
  await rescheduleAlarm(storage);
}

/** Internal: align the DO's alarm with the earliest pending task. */
async function rescheduleAlarm(storage: SchedulerStorage): Promise<void> {
  const rows = storage.sql
    .exec<{ min_at: number | null }>(`SELECT MIN(at) AS min_at FROM scheduled_task`)
    .toArray();
  const min = rows[0]?.min_at ?? null;
  if (min === null) {
    await storage.deleteAlarm();
  } else {
    await storage.setAlarm(min);
  }
}

export type TaskDispatcher = (task: ScheduledTask) => void | Promise<void>;

/**
 * Run every task with `at <= now`, in order. Each dispatch is wrapped in
 * try/catch so a thrown handler does not strand its siblings (logged, the
 * task is still deleted, processing continues). The alarm is re-armed to
 * the next pending task at the end.
 */
export async function runDueTasks(
  storage: SchedulerStorage,
  now: number,
  dispatch: TaskDispatcher,
): Promise<void> {
  const rows = storage.sql
    .exec<{ id: string; at: number; type: string; payload: string | null }>(
      `SELECT id, at, type, payload FROM scheduled_task WHERE at <= ? ORDER BY at ASC`,
      now,
    )
    .toArray();
  for (const row of rows) {
    const task: ScheduledTask = {
      id: row.id,
      at: row.at,
      type: row.type,
      payload: row.payload !== null ? JSON.parse(row.payload) : null,
    };
    try {
      await dispatch(task);
    } catch (err) {
      // Don't let one bad handler strand the rest; consumers must be idempotent.
      console.error(`scheduler: dispatch failed for type=${row.type} id=${row.id}:`, err);
    }
    storage.sql.exec(`DELETE FROM scheduled_task WHERE id = ?`, row.id);
  }
  await rescheduleAlarm(storage);
}
