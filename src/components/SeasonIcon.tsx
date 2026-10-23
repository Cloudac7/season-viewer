import { Flower2, Leaf, Snowflake, Sun } from 'lucide-react';
import type { Season } from '../types';
export default function SeasonIcon({ season, size = 22, className = '' }: { season: Season; size?: number; className?: string }) {
  const Icon = { spring: Flower2, summer: Sun, autumn: Leaf, winter: Snowflake }[season];
  return <Icon size={size} strokeWidth={1.6} className={className} />;
}
