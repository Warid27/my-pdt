type HabitEnv = {
  DB?: D1Database;
};

type HabitFrequency = "daily" | "weekly";

type HabitRow = {
  id: number;
  name: string;
  description: string | null;
  frequency: string;
  target_days: string | null;
  is_active: number;
  created_at: string;
};

type HabitCheckinRow = {
  id: number;
  habit_id: number;
  checked_at: string;
  date: string;
  note: string | null;
};

type Habit = {
  id: number;
  name: string;
  description: string | null;
  frequency: HabitFrequency;
  targetDays: number[] | null;
  isActive: boolean;
  createdAt: string;
};

type HabitCheckin = {
  id: number;
  habitId: number;
  checkedAt: string;
  date: string;
  note: string | null;
};

type HabitWithStatus = {
  id: number;
  name: string;
  description: string | null;
  frequency: HabitFrequency;
  targetDays: number[] | null;
  checkedToday: boolean;
  currentStreak: number;
  bestStreak: number;
  completionThisMonth: number;
};

type CreateHabitInput = {
  name: string;
  description?: string;
  frequency?: HabitFrequency;
  targetDays?: number[];
};

type UpdateHabitInput = {
  name?: string;
  description?: string;
  frequency?: HabitFrequency;
  targetDays?: number[];
};

type CheckinInput = {
  date?: string;
  note?: string;
};

type HabitToolResult = {
  text: string;
  data?: unknown;
};

const WIB_OFFSET = 7 * 60 * 60 * 1000;

function requireDb(env: HabitEnv): D1Database {
  if (!env.DB) {
    throw new Error("D1 DB binding is required for habit features");
  }
  return env.DB;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function wibDate(date: Date = new Date()): string {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + WIB_OFFSET).toISOString().slice(0, 10);
}

function wibDateWithDayName(date: Date = new Date()): { date: string; dayName: string } {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const wib = new Date(utc + WIB_OFFSET);
  const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  return { date: wib.toISOString().slice(0, 10), dayName: days[wib.getDay()] };
}

function formatWibDateLong(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00+07:00");
  const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function parseTargetDays(value: string | null): number[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "number")) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function rowToHabit(row: HabitRow): Habit {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    frequency: row.frequency as HabitFrequency,
    targetDays: parseTargetDays(row.target_days),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

function rowToCheckin(row: HabitCheckinRow): HabitCheckin {
  return {
    id: row.id,
    habitId: row.habit_id,
    checkedAt: row.checked_at,
    date: row.date,
    note: row.note,
  };
}

async function createHabit(env: HabitEnv, input: CreateHabitInput): Promise<Habit> {
  const db = requireDb(env);
  const name = slug(input.name);
  if (!name) {
    throw new Error("name is required");
  }
  const frequency = input.frequency ?? "daily";
  const targetDays = frequency === "weekly" && input.targetDays ? JSON.stringify(input.targetDays) : null;

  await db
    .prepare("INSERT INTO habits (name, description, frequency, target_days) VALUES (?, ?, ?, ?)")
    .bind(name, input.description ?? null, frequency, targetDays)
    .run();

  const row = await db
    .prepare("SELECT id, name, description, frequency, target_days, is_active, created_at FROM habits WHERE name = ?")
    .bind(name)
    .first<HabitRow>();

  if (!row) {
    throw new Error("Failed to create habit");
  }

  return rowToHabit(row);
}

async function updateHabit(env: HabitEnv, id: number, input: UpdateHabitInput): Promise<Habit | null> {
  const db = requireDb(env);
  const existing = await db
    .prepare("SELECT id, name, description, frequency, target_days, is_active, created_at FROM habits WHERE id = ?")
    .bind(id)
    .first<HabitRow>();

  if (!existing) {
    return null;
  }

  const name = input.name ? slug(input.name) : existing.name;
  const description = input.description !== undefined ? input.description : existing.description;
  const frequency = input.frequency ?? existing.frequency;
  const targetDays =
    input.targetDays !== undefined
      ? input.targetDays
        ? JSON.stringify(input.targetDays)
        : null
      : existing.target_days;

  await db
    .prepare("UPDATE habits SET name = ?, description = ?, frequency = ?, target_days = ? WHERE id = ?")
    .bind(name, description, frequency, targetDays, id)
    .run();

  const row = await db
    .prepare("SELECT id, name, description, frequency, target_days, is_active, created_at FROM habits WHERE id = ?")
    .bind(id)
    .first<HabitRow>();

  return row ? rowToHabit(row) : null;
}

async function deleteHabit(env: HabitEnv, id: number): Promise<boolean> {
  const db = requireDb(env);
  const result = await db.prepare("UPDATE habits SET is_active = 0 WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

async function listActiveHabits(env: HabitEnv): Promise<Habit[]> {
  const db = requireDb(env);
  const result = await db
    .prepare("SELECT id, name, description, frequency, target_days, is_active, created_at FROM habits WHERE is_active = 1 ORDER BY name ASC")
    .all<HabitRow>();

  return result.results.map(rowToHabit);
}

async function getHabitById(env: HabitEnv, id: number): Promise<Habit | null> {
  const db = requireDb(env);
  const row = await db
    .prepare("SELECT id, name, description, frequency, target_days, is_active, created_at FROM habits WHERE id = ?")
    .bind(id)
    .first<HabitRow>();

  return row ? rowToHabit(row) : null;
}

async function getHabitByName(env: HabitEnv, name: string): Promise<Habit | null> {
  const db = requireDb(env);
  const row = await db
    .prepare("SELECT id, name, description, frequency, target_days, is_active, created_at FROM habits WHERE name = ? AND is_active = 1")
    .bind(slug(name))
    .first<HabitRow>();

  return row ? rowToHabit(row) : null;
}

async function checkinHabit(env: HabitEnv, habitId: number, input: CheckinInput): Promise<HabitCheckin> {
  const db = requireDb(env);
  const date = input.date ?? wibDate();

  await db
    .prepare("INSERT OR IGNORE INTO habit_checkins (habit_id, date, note) VALUES (?, ?, ?)")
    .bind(habitId, date, input.note ?? null)
    .run();

  const row = await db
    .prepare("SELECT id, habit_id, checked_at, date, note FROM habit_checkins WHERE habit_id = ? AND date = ?")
    .bind(habitId, date)
    .first<HabitCheckinRow>();

  if (!row) {
    throw new Error("Failed to check in habit");
  }

  return rowToCheckin(row);
}

async function getCheckinHistory(env: HabitEnv, habitId: number, page: number, pageSize: number): Promise<{ items: HabitCheckin[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const db = requireDb(env);
  const totalRow = await db
    .prepare("SELECT COUNT(*) AS total FROM habit_checkins WHERE habit_id = ?")
    .bind(habitId)
    .first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const offset = (page - 1) * pageSize;
  const result = await db
    .prepare("SELECT id, habit_id, checked_at, date, note FROM habit_checkins WHERE habit_id = ? ORDER BY date DESC LIMIT ? OFFSET ?")
    .bind(habitId, pageSize, offset)
    .all<HabitCheckinRow>();

  return {
    items: result.results.map(rowToCheckin),
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

async function isCheckedInToday(env: HabitEnv, habitId: number): Promise<boolean> {
  const db = requireDb(env);
  const today = wibDate();
  const row = await db
    .prepare("SELECT id FROM habit_checkins WHERE habit_id = ? AND date = ? LIMIT 1")
    .bind(habitId, today)
    .first<{ id: number }>();
  return Boolean(row);
}

async function getCheckinDates(env: HabitEnv, habitId: number): Promise<string[]> {
  const db = requireDb(env);
  const result = await db
    .prepare("SELECT date FROM habit_checkins WHERE habit_id = ? ORDER BY date DESC")
    .bind(habitId)
    .all<{ date: string }>();

  return result.results.map((row) => row.date);
}

function calculateStreak(dates: string[], today: string): { current: number; best: number } {
  if (dates.length === 0) {
    return { current: 0, best: 0 };
  }

  const dateSet = new Set(dates);

  let current = 0;
  let checkDate = today;
  while (dateSet.has(checkDate)) {
    current += 1;
    const d = new Date(checkDate + "T00:00:00Z");
    d.setDate(d.getDate() - 1);
    checkDate = d.toISOString().slice(0, 10);
  }

  const sorted = [...dates].sort();
  let best = 0;
  let streak = 0;
  let prev: string | null = null;
  for (const date of sorted) {
    if (prev) {
      const prevDate = new Date(prev + "T00:00:00Z");
      prevDate.setDate(prevDate.getDate() + 1);
      if (prevDate.toISOString().slice(0, 10) === date) {
        streak += 1;
      } else {
        streak = 1;
      }
    } else {
      streak = 1;
    }
    best = Math.max(best, streak);
    prev = date;
  }

  return { current, best };
}

function getMonthCompletion(dates: string[], today: string): number {
  const currentMonth = today.slice(0, 7);
  const monthCheckins = dates.filter((d) => d.startsWith(currentMonth));
  const now = new Date(today + "T00:00:00Z");
  const dayOfMonth = now.getDate();
  return dayOfMonth > 0 ? Math.round((monthCheckins.length / dayOfMonth) * 100) / 100 : 0;
}

async function getHabitsWithStatus(env: HabitEnv): Promise<HabitWithStatus[]> {
  const habits = await listActiveHabits(env);
  const today = wibDate();
  const { dayName } = wibDateWithDayName();

  const results: HabitWithStatus[] = [];
  for (const habit of habits) {
    const checkedToday = await isCheckedInToday(env, habit.id);
    const dates = await getCheckinDates(env, habit.id);
    const { current, best } = calculateStreak(dates, today);
    const completionThisMonth = getMonthCompletion(dates, today);

    results.push({
      id: habit.id,
      name: habit.name,
      description: habit.description,
      frequency: habit.frequency,
      targetDays: habit.targetDays,
      checkedToday,
      currentStreak: current,
      bestStreak: best,
      completionThisMonth,
    });
  }

  return results;
}

async function getHabitStreak(env: HabitEnv, name: string): Promise<HabitWithStatus | null> {
  const habit = await getHabitByName(env, name);
  if (!habit) {
    return null;
  }

  const today = wibDate();
  const dates = await getCheckinDates(env, habit.id);
  const { current, best } = calculateStreak(dates, today);
  const completionThisMonth = getMonthCompletion(dates, today);
  const checkedToday = await isCheckedInToday(env, habit.id);

  return {
    id: habit.id,
    name: habit.name,
    description: habit.description,
    frequency: habit.frequency,
    targetDays: habit.targetDays,
    checkedToday,
    currentStreak: current,
    bestStreak: best,
    completionThisMonth,
  };
}

async function getUncheckedHabitsToday(env: HabitEnv): Promise<Habit[]> {
  const habits = await listActiveHabits(env);
  const unchecked: Habit[] = [];
  for (const habit of habits) {
    if (!(await isCheckedInToday(env, habit.id))) {
      unchecked.push(habit);
    }
  }
  return unchecked;
}

async function getCheckedHabitsToday(env: HabitEnv): Promise<Habit[]> {
  const habits = await listActiveHabits(env);
  const checked: Habit[] = [];
  for (const habit of habits) {
    if (await isCheckedInToday(env, habit.id)) {
      checked.push(habit);
    }
  }
  return checked;
}

function formatHabitsToday(habits: HabitWithStatus[]): string {
  const { date, dayName } = wibDateWithDayName();
  const dateLong = formatWibDateLong(date);
  const lines = [`📋 Habits hari ini (${dateLong})`, ""];

  for (const habit of habits) {
    if (habit.checkedToday) {
      lines.push(`✅ ${habit.name} — sudah`);
    } else {
      lines.push(`❌ ${habit.name} — belum`);
    }
  }

  const done = habits.filter((h) => h.checkedToday).length;
  lines.push("");
  lines.push(`${done}/${habits.length} selesai`);

  return lines.join("\n");
}

function formatHabitStreak(habit: HabitWithStatus): string {
  const today = wibDate();
  const dayOfMonth = Number(today.slice(8, 10));
  const monthCheckins = Math.round(habit.completionThisMonth * dayOfMonth);
  const lines = [
    `🔥 ${habit.name}`,
    `Streak sekarang: ${habit.currentStreak} hari`,
    `Streak terbaik: ${habit.bestStreak} hari`,
    `Bulan ini: ${monthCheckins}/${dayOfMonth} hari (${Math.round(habit.completionThisMonth * 100)}%)`,
  ];

  return lines.join("\n");
}

async function executeHabitToolCall(env: HabitEnv, name: string, args: Record<string, unknown>): Promise<HabitToolResult> {
  switch (name) {
    case "create_habit": {
      const habit = await createHabit(env, {
        name: String(args.name ?? ""),
        description: args.description ? String(args.description) : undefined,
        frequency: (args.frequency as HabitFrequency) ?? "daily",
        targetDays: Array.isArray(args.targetDays) ? args.targetDays as number[] : undefined,
      });
      return { text: `Habit "${habit.name}" berhasil dibuat.`, data: habit };
    }
    case "checkin_habit": {
      const habitName = String(args.name ?? "");
      const habit = await getHabitByName(env, habitName);
      if (!habit) {
        return { text: `Habit "${habitName}" belum ada. Apakah mau dibuat habit baru?` };
      }
      const checkin = await checkinHabit(env, habit.id, { note: args.note ? String(args.note) : undefined });
      return { text: `✅ ${habit.name} sudah dicatat hari ini.`, data: checkin };
    }
    case "get_habits_today": {
      const habits = await getHabitsWithStatus(env);
      if (habits.length === 0) {
        return { text: "Belum ada habit yang dibuat." };
      }
      return { text: formatHabitsToday(habits), data: habits };
    }
    case "get_habit_streak": {
      const habitName = String(args.name ?? "");
      const habit = await getHabitStreak(env, habitName);
      if (!habit) {
        return { text: `Habit "${habitName}" tidak ditemukan.` };
      }
      return { text: formatHabitStreak(habit), data: habit };
    }
    default:
      throw new Error(`Unsupported habit tool: ${name}`);
  }
}

export {
  calculateStreak,
  checkinHabit,
  createHabit,
  deleteHabit,
  executeHabitToolCall,
  formatHabitStreak,
  formatHabitsToday,
  getCheckedHabitsToday,
  getCheckinDates,
  getCheckinHistory,
  getHabitById,
  getHabitByName,
  getHabitStreak,
  getHabitsWithStatus,
  getUncheckedHabitsToday,
  isCheckedInToday,
  listActiveHabits,
  slug,
  updateHabit,
  wibDate,
  wibDateWithDayName,
};
export type {
  CheckinInput,
  CreateHabitInput,
  Habit,
  HabitCheckin,
  HabitEnv,
  HabitFrequency,
  HabitToolResult,
  HabitWithStatus,
  UpdateHabitInput,
};
