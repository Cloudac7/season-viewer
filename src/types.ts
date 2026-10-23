export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Region = '华北' | '东北' | '华东' | '华中' | '华南' | '西南' | '西北' | '港澳台';
export interface City {
  id: string; name: string; province: string; code: number; region: Region;
  lat: number; lon: number; annual: number; amplitude: number;
}
export interface DayTemperature { date: string; mean: number | null }
export interface WeatherDataset {
  source: 'live' | 'demo'; updatedAt: string;
  cities: Record<string, DayTemperature[]>;
}
export interface Transition {
  target: Season; days: number; start: string; threshold: number;
}
export interface SeasonState {
  city: City; season: Season; temperature: number | null; average: number | null;
  since: string | null; transition: Transition | null; history: DayTemperature[];
  averages: (number | null)[]; estimated: boolean;
}
