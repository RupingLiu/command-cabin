export function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  if (map.has(key)) {
    map.delete(key);
  }

  map.set(key, value);
  trimBoundedMap(map, maxEntries);
}

export function addBoundedSetEntry<T>(set: Set<T>, value: T, maxEntries: number): void {
  if (set.has(value)) {
    set.delete(value);
  }

  set.add(value);
  trimBoundedSet(set, maxEntries);
}

function trimBoundedMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  const normalizedMaxEntries = normalizeMaxEntries(maxEntries);

  while (map.size > normalizedMaxEntries) {
    const oldestKey = map.keys().next().value as K | undefined;

    if (oldestKey === undefined) {
      return;
    }

    map.delete(oldestKey);
  }
}

function trimBoundedSet<T>(set: Set<T>, maxEntries: number): void {
  const normalizedMaxEntries = normalizeMaxEntries(maxEntries);

  while (set.size > normalizedMaxEntries) {
    const oldestValue = set.values().next().value as T | undefined;

    if (oldestValue === undefined) {
      return;
    }

    set.delete(oldestValue);
  }
}

function normalizeMaxEntries(maxEntries: number): number {
  return Math.max(1, Math.floor(maxEntries));
}
