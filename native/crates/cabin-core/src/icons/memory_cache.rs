//! 插入序驱动的有界内存缓存。移植自
//! `apps/desktop/src/main/icons/boundedMemoryCache.ts`（`setBoundedMapEntry` /
//! `addBoundedSetEntry`：删除重插以刷新插入序，超限逐最早插入的条目）。

use std::collections::HashMap;
use std::hash::Hash;

/// 有界的插入序 Map。`set` 已存在的键时先删后插（刷新插入序），
/// 超过 `max_entries` 时逐最早插入的键。
pub struct BoundedMemoryCache<K, V> {
    map: HashMap<K, V>,
    order: Vec<K>,
    max_entries: usize,
}

impl<K, V> BoundedMemoryCache<K, V>
where
    K: Eq + Hash + Clone,
{
    /// `max_entries` 会被钳制到至少 1（对齐 TS `normalizeMaxEntries`）。
    pub fn new(max_entries: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
            max_entries: normalize_max_entries(max_entries),
        }
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.map.get(key)
    }

    pub fn contains_key(&self, key: &K) -> bool {
        self.map.contains_key(key)
    }

    /// 插入/刷新条目；已存在的键先删后插，随后超限逐最早插入的键。
    pub fn set(&mut self, key: K, value: V) {
        if self.map.remove(&key).is_some() {
            self.order.retain(|existing| existing != &key);
        }
        self.map.insert(key.clone(), value);
        self.order.push(key);
        while self.order.len() > self.max_entries {
            let oldest_key = self.order.remove(0);
            self.map.remove(&oldest_key);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

fn normalize_max_entries(max_entries: usize) -> usize {
    max_entries.max(1)
}

/// 有界的插入序 Set。`add` 已存在的值时先删后插（刷新插入序），
/// 超过 `max_entries` 时逐最早插入的值。
pub struct BoundedMemorySet<T> {
    entries: Vec<T>,
    max_entries: usize,
}

impl<T> BoundedMemorySet<T>
where
    T: PartialEq + Clone,
{
    /// `max_entries` 会被钳制到至少 1（对齐 TS `normalizeMaxEntries`）。
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Vec::new(),
            max_entries: normalize_max_entries(max_entries),
        }
    }

    pub fn contains(&self, value: &T) -> bool {
        self.entries.contains(value)
    }

    /// 插入/刷新值；已存在的值先删后插，随后超限逐最早插入的值。
    pub fn add(&mut self, value: T) {
        if let Some(position) = self.entries.iter().position(|existing| existing == &value) {
            self.entries.remove(position);
        }
        self.entries.push(value);
        while self.entries.len() > self.max_entries {
            self.entries.remove(0);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::super::MEMORY_CACHE_MAX_ENTRIES;

    #[test]
    fn evicts_oldest_inserted_beyond_max() {
        let mut cache = super::BoundedMemoryCache::new(3);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        cache.set("d", 4);
        assert_eq!(cache.len(), 3);
        assert!(!cache.contains_key(&"a"));
        assert_eq!(cache.get(&"b"), Some(&2));
        assert_eq!(cache.get(&"d"), Some(&4));
    }

    #[test]
    fn resetting_existing_key_refreshes_insertion_order() {
        // 对齐 TS setBoundedMapEntry：delete 后再 set，刷新插入序。
        let mut cache = super::BoundedMemoryCache::new(3);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        cache.set("a", 10);
        cache.set("d", 4);
        assert!(!cache.contains_key(&"b"));
        assert_eq!(cache.get(&"a"), Some(&10));
        assert_eq!(cache.get(&"c"), Some(&3));
        assert_eq!(cache.get(&"d"), Some(&4));
    }

    #[test]
    fn max_entries_is_clamped_to_at_least_one() {
        let mut cache = super::BoundedMemoryCache::new(0);
        cache.set("a", 1);
        cache.set("b", 2);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get(&"b"), Some(&2));
    }

    #[test]
    fn empty_cache_reports_empty() {
        let cache: super::BoundedMemoryCache<String, u8> =
            super::BoundedMemoryCache::new(MEMORY_CACHE_MAX_ENTRIES);
        assert!(cache.is_empty());
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.get(&"missing".to_string()), None);
    }

    #[test]
    fn set_evicts_oldest_inserted_beyond_max() {
        let mut set = super::BoundedMemorySet::new(2);
        set.add("a");
        set.add("b");
        assert!(set.contains(&"a"));
        set.add("a"); // 刷新插入序
        set.add("c");
        assert_eq!(set.len(), 2);
        assert!(!set.contains(&"b"));
        assert!(set.contains(&"a"));
        assert!(set.contains(&"c"));
    }

    #[test]
    fn set_clamps_max_entries_to_one() {
        let mut set = super::BoundedMemorySet::new(0);
        set.add("a");
        set.add("b");
        assert_eq!(set.len(), 1);
        assert!(set.contains(&"b"));
    }
}
