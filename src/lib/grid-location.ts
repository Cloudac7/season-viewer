import type { FeatureCollection, Geometry, Position } from 'geojson';
import type { CountyBoundaries, CountyCatalog, CountyUnit } from './counties';
import { wgsToGcj } from './coordinates';
import type { TerrainGrid } from './terrain';

export interface GridLocation {
  id: string;
  province: string;
  city: string;
  county: string;
  title: string;
  kind: 'county' | 'undivided-city' | 'province';
}
export interface GridLocationLattice {
  bounds: TerrainGrid['bounds'];
  rows: number;
  cols: number;
  step: number;
}
/** Cell ids are one-based indices into units; zero means no containing region. */
export interface GridLocations extends GridLocationLattice {
  version: 1;
  crs: 'WGS84';
  boundaryCrs: 'GCJ-02';
  units: GridLocation[];
  cells: number[];
}
type ProvinceProperties = { adcode?: string | number; name?: string } | null;
export type ProvinceBoundaries = FeatureCollection<Geometry, ProvinceProperties>;
interface IndexedPolygon { rings: Position[][]; bounds: [number, number, number, number]; location: number }

function joinedTitle(parts: string[]): string {
  return parts.filter((part, index) => part && parts.indexOf(part) === index).join(' · ');
}
export function countyGridLocation(unit: CountyUnit): GridLocation {
  return {
    id: unit.id, province: unit.province, city: unit.city,
    county: unit.kind === 'undivided-city' ? '' : unit.name,
    title: joinedTitle([unit.province, unit.city, unit.name]), kind: unit.kind,
  };
}
function polygonContains(rings: Position[][], x: number, y: number): boolean {
  // Planar containment is appropriate for these local GCJ-02 polygons and is
  // independent of GeoJSON ring winding. A shared edge belongs to either side.
  let contained = false;
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    const ring = rings[ringIndex]; let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
      if (Math.abs(cross) < 1e-10 && x >= Math.min(ax, bx) - 1e-10 && x <= Math.max(ax, bx) + 1e-10 &&
        y >= Math.min(ay, by) - 1e-10 && y <= Math.max(ay, by) + 1e-10) return true;
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    if (ringIndex === 0) { if (!inside) return false; contained = true; }
    else if (inside) return false;
  }
  return contained;
}
function polygonIndex(features: { geometry: Geometry; location: number }[]) {
  const buckets = new Map<string, IndexedPolygon[]>();
  for (const { geometry, location } of features) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const rings of polygons) {
      if (!rings[0]?.length) continue;
      const bounds: IndexedPolygon['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of rings[0]) { bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y); }
      const polygon = { rings, bounds, location };
      for (let x = Math.floor(bounds[0]); x <= Math.floor(bounds[2]); x++) for (let y = Math.floor(bounds[1]); y <= Math.floor(bounds[3]); y++) {
        const key = `${x},${y}`, candidates = buckets.get(key);
        if (candidates) candidates.push(polygon); else buckets.set(key, [polygon]);
      }
    }
  }
  return (x: number, y: number): number => {
    for (const polygon of buckets.get(`${Math.floor(x)},${Math.floor(y)}`) ?? []) {
      const [west, south, east, north] = polygon.bounds;
      if (x >= west && x <= east && y >= south && y <= north && polygonContains(polygon.rings, x, y)) return polygon.location;
    }
    return 0;
  };
}

/** Build once at deployment. Missing county coverage may fall back only to an
 * actually containing province; offshore points never borrow a nearby county. */
export function buildGridLocations({ grid, catalog, boundaries, provinces }: {
  grid: GridLocationLattice; catalog: CountyCatalog; boundaries: CountyBoundaries; provinces: ProvinceBoundaries;
}): GridLocations {
  const units = catalog.units.map(countyGridLocation), unitIds = new Map(units.map((unit, i) => [unit.id, i + 1]));
  const countyLookup = polygonIndex(boundaries.features.flatMap(shape => {
    const location = unitIds.get(shape.properties.id);
    return location ? [{ geometry: shape.geometry, location }] : [];
  }));
  const provinceShapes = provinces.features.flatMap(shape => {
    const properties = shape.properties;
    if (!properties?.name || !/^\d{6}$/.test(String(properties.adcode))) return [];
    const location = units.push({ id: String(properties.adcode), province: properties.name, city: '', county: '', title: properties.name, kind: 'province' });
    return [{ geometry: shape.geometry, location }];
  });
  const provinceLookup = polygonIndex(provinceShapes);
  const cells = Array.from({ length: grid.rows * grid.cols }, (_, index) => {
    const lon = grid.bounds.west + index % grid.cols * grid.step, lat = grid.bounds.south + Math.floor(index / grid.cols) * grid.step;
    const [x, y] = wgsToGcj(lon, lat);
    return countyLookup(x, y) || provinceLookup(x, y);
  });
  return { version: 1, crs: 'WGS84', boundaryCrs: 'GCJ-02', bounds: { ...grid.bounds }, rows: grid.rows, cols: grid.cols, step: grid.step, units, cells };
}

/** Read the precomputed region for the same nearest display node used by the
 * map. This is a table lookup; no polygon work occurs in the browser. */
export function lookupGridLocation(index: GridLocations | null | undefined, longitude: number, latitude: number): GridLocation | null {
  if (!index || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const { west, east, south, north } = index.bounds;
  if (longitude < west - 1e-8 || longitude > east + 1e-8 || latitude < south - 1e-8 || latitude > north + 1e-8) return null;
  const col = Math.round((longitude - west) / index.step), row = Math.round((latitude - south) / index.step);
  return index.units[index.cells[row * index.cols + col] - 1] ?? null;
}

export function validGridLocations(value: unknown): value is GridLocations {
  if (!value || typeof value !== 'object') return false;
  const index = value as GridLocations;
  if (index.version !== 1 || index.crs !== 'WGS84' || index.boundaryCrs !== 'GCJ-02' || !index.bounds ||
    !Number.isInteger(index.rows) || index.rows < 1 || !Number.isInteger(index.cols) || index.cols < 1 ||
    !Number.isFinite(index.step) || index.step <= 0 || !Array.isArray(index.units) || !Array.isArray(index.cells) || index.cells.length !== index.rows * index.cols) return false;
  const { west, east, south, north } = index.bounds;
  if (![west, east, south, north].every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north ||
    Math.abs(west + (index.cols - 1) * index.step - east) > 1e-7 || Math.abs(south + (index.rows - 1) * index.step - north) > 1e-7) return false;
  return index.units.every(unit => unit && ['id', 'province', 'city', 'county', 'title'].every(key => typeof unit[key as keyof GridLocation] === 'string') &&
    ['county', 'undivided-city', 'province'].includes(unit.kind)) && index.cells.every(id => Number.isInteger(id) && id >= 0 && id <= index.units.length);
}
