import type { City, DayTemperature, Season, SeasonState, Transition } from '../types';

const beijingDateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });

export function beijingDate(now = new Date()): string {
  return beijingDateFormatter.format(now);
}
export function addDays(date: string, amount: number) {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
export function rollingMeans(days: DayTemperature[]): (number | null)[] {
  return days.map((_, index) => {
    if (index < 4) return null;
    const window = days.slice(index - 4, index + 1);
    if (window.some((d, j) => d.mean === null || !Number.isFinite(d.mean) || (j > 0 && addDays(window[j - 1].date, 1) !== d.date))) return null;
    return window.reduce((sum, d) => sum + d.mean!, 0) / 5;
  });
}
function candidate(season: Season, temperature: number, date: string): Season | null {
  const warmingHalf = Number(date.slice(5,7)) <= 6;
  // Reverse processes must also pass five consecutive means. Otherwise an early
  // cold spell can lock the state machine into autumn all through summer.
  // Without normal dates, half-year direction is a disclosed estimate only.
  if (season === 'winter' && temperature >= 10) return warmingHalf ? 'spring' : 'autumn';
  if (season === 'spring' && temperature >= 22) return 'summer';
  if (season === 'spring' && temperature < 10) return 'winter';
  if (season === 'summer' && temperature < 22) return warmingHalf ? 'spring' : 'autumn';
  if (season === 'autumn' && temperature < 10) return 'winter';
  if (season === 'autumn' && temperature >= 22) return 'summer';
  return null;
}
function meets(from: Season, target: Season, temperature: number) {
  if (from === 'winter') return temperature >= 10;
  if (from === 'summer') return temperature < 22;
  return target === 'summer' ? temperature >= 22 : temperature < 10;
}
function advanceTransition(previous: Transition | null, target: Season, date: string): Transition {
  return previous?.target === target
    ? { ...previous, days: previous.days + 1 }
    : { target, days: 1, start: date, threshold: target === 'winter' || target === 'spring' ? 10 : 22 };
}
export function classifyCity(city: City, input: DayTemperature[], date: string): SeasonState {
  const history = input.filter(d => d.date <= date).sort((a, b) => a.date.localeCompare(b.date));
  const averages = rollingMeans(history);
  const firstIndex = averages.findIndex(v => v !== null);
  const first = averages[firstIndex] ?? 0;
  const month = Number(history[firstIndex]?.date.slice(5, 7) ?? 1);
  let season: Season = first < 10 ? 'winter' : first >= 22 ? 'summer' : month <= 6 ? 'spring' : 'autumn';
  let since: string | null = null;
  let transition: Transition | null = null;
  let estimated = true;
  for (let i = Math.max(firstIndex + 1, 0); i < history.length; i++) {
    const value = averages[i];
    if (value === null) { transition = null; continue; }
    // Without a 30-year climatology, no-summer spring/autumn cannot be formally
    // distinguished. This fallback is explicitly identified in the UI/methodology.
    const previousMonth = Number(history[i - 1]?.date.slice(5, 7));
    const currentMonth = Number(history[i].date.slice(5, 7));
    if (season === 'spring' && previousMonth === 7 && currentMonth === 8 && value < 22) {
      season = 'autumn'; since = null; estimated = true; transition = null;
    }
    if (season === 'autumn' && previousMonth === 12 && currentMonth === 1 && value >= 10) {
      season = 'spring'; since = null; estimated = true; transition = null;
    }
    const target = candidate(season, value, history[i].date);
    if (!target) { transition = null; continue; }
    transition = advanceTransition(transition, target, history[i].date);
    if (transition.days === 5) {
      // Five overlapping 5-day means contain nine daily temperatures.
      const firstDay = history.slice(Math.max(0, i - 8), i + 1).find(d => d.mean !== null && meets(season, target, d.mean));
      since = firstDay?.date ?? transition.start;
      season = target; transition = null; estimated = false;
    }
  }
  const last = history.at(-1);
  const hasCurrentDay = last?.date === date;
  return { city, season, temperature: hasCurrentDay ? last.mean : null, average: hasCurrentDay ? averages.at(-1) ?? null : null, since, transition: hasCurrentDay ? transition : null, history, averages, estimated };
}
