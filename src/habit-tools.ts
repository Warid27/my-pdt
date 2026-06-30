import type { HabitFrequency } from "./habits";

type HabitToolName =
  | "create_habit"
  | "checkin_habit"
  | "get_habits_today"
  | "get_habit_streak";

type HabitToolCall = {
  name: HabitToolName;
  arguments: Record<string, unknown>;
};

type HabitToolDefinition = {
  type: "function";
  function: {
    name: HabitToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const habitTools: HabitToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_habit",
      description: "Buat habit baru untuk dilacak setiap hari atau minggu.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama habit, e.g. 'olahraga', 'baca buku'" },
          description: { type: "string", description: "Deskripsi tambahan (opsional)" },
          frequency: { type: "string", enum: ["daily", "weekly"], description: "Frekuensi habit" },
          targetDays: {
            type: "array",
            items: { type: "number" },
            description: "Untuk weekly: hari dalam seminggu (1=Senin, 7=Minggu)",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkin_habit",
      description: "Catat bahwa habit sudah dilakukan hari ini.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama habit yang sudah dilakukan" },
          note: { type: "string", description: "Catatan tambahan (opsional)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_habits_today",
      description: "Tampilkan semua habit dan status check-in hari ini.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_habit_streak",
      description: "Lihat streak dan statistik sebuah habit.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama habit" },
        },
        required: ["name"],
      },
    },
  },
];

const habitToolNames = new Set<HabitToolName>(habitTools.map((tool) => tool.function.name));

function isHabitToolName(value: string): value is HabitToolName {
  return habitToolNames.has(value as HabitToolName);
}

export { habitTools, isHabitToolName };
export type { HabitToolCall, HabitToolDefinition, HabitToolName };
