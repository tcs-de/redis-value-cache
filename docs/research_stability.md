# Stability Research Report — `redis-value-cache`

**Date:** 2026-03-04
**Scope:** Deep analysis of `index.ts` for bugs, memory leaks, race conditions, and edge cases.

---

## Critical Bugs

### 1. ~~`promiseMap` memory leak on rejection~~ ✅ FIXED

**Location:** `get()` method (~line 288–311)

```ts
const currentAttempt = this.fetch(key, fetchOpts);
this.promiseMap[key] = currentAttempt;
value = await currentAttempt;
delete this.promiseMap[key]; // ← never reached if fetch throws
```

If `this.fetch()` throws (e.g. when `errorHandlerStrategy` is `"throw"`, or when `assertConnected()` inside `fetch()` throws), `delete this.promiseMap[key]` is never executed. The rejected promise remains in `promiseMap` permanently.

**Consequences:**
- Every subsequent `get()` call for the same key enters the `if (previousAttempt)` branch and re-awaits the already-rejected promise, perpetually re-throwing the same error.
- The key becomes permanently un-fetchable for the lifetime of the instance.
- The rejected promise object itself is never garbage-collected — a memory leak.

**Fix:** Wrap in try/finally:
```ts
try {
    value = await currentAttempt;
} finally {
    delete this.promiseMap[key];
}
```

> **Status:** Fixed. `get()` now uses `try/finally`. Note: there is a redundant `delete this.promiseMap[key]` after the `try/finally` block that could be cleaned up.

---

### 2. ~~`HGETALL` returns empty object `{}` for non-existent keys in real Redis~~ ✅ FIXED

**Location:** `fetchMethod()` (~line 526)

```ts
if (redisValue) {
    value = this.deserialize(redisValue, key);
}
```

In node-redis v4, `HGETALL` returns `{}` (empty object) for keys that do not exist. An empty object is **truthy**, so `this.deserialize()` is called with `{}` for non-existent keys.

The test mock returns `null` for missing keys, hiding this discrepancy. In production with a real Redis server, the `deserialize` function receives an unexpected empty object and may return incorrect data or throw.

**Fix:** Add an explicit empty-object check:
```ts
if (redisValue && !(typeof redisValue === "object" && Object.keys(redisValue).length === 0)) {
    value = this.deserialize(redisValue, key);
}
```

> **Status:** Fixed. `fetchMethod()` now checks `redisValue !== null && redisValue !== undefined` and explicitly checks for empty HGETALL objects.

---

### 3. ~~Falsy value handling — `!savedValue` treats `0`, `""`, `false` as missing~~ ✅ FIXED

**Location:** `fetch()` method (~line 434) and `get()` method (~line 304)

The type constraint `storedValueType extends NonNullable<unknown>` permits falsy non-null values like `0`, `""`, and `false`.

In `fetch()`:
```ts
if (!savedValue && this.fallbackFetchMethod) {
```
If `savedValue` is `0` or `""`, this evaluates to `true`, unnecessarily invoking the fallback fetch method.

In `get()`:
```ts
if (value && opts?.clone) {
    value = cloneDeep(value);
}
```
If `value` is `0` or `""`, cloning is silently skipped even when `clone: true` is requested.

In `fetchMethod()`:
```ts
if (redisValue) {
    value = this.deserialize(redisValue, key);
}
```
If Redis returns `""` (valid in Redis), deserialization is skipped entirely.

**Fix:** Use explicit null/undefined checks:
```ts
if ((savedValue === null || savedValue === undefined) && this.fallbackFetchMethod) { ... }
if (value !== undefined && opts?.clone) { ... }
if (redisValue !== null && redisValue !== undefined) { ... }
```

> **Status:** Fixed. `get()` now uses `value !== undefined`, `fetch()` uses explicit `=== null || === undefined`, and `fetchMethod()` uses `!== null && !== undefined`.

---

### 4. ~~Test mock `isOpen` is a method; real redis v4 uses a getter property~~ ✅ FIXED

**Location:** `test/redisV4Mock.ts` (~line 45) vs `disconnect()` in `index.ts` (~line 319)

The mock defines `isOpen()` as a method:
```ts
public isOpen() { return this.open; }
```

But the production code (and real redis v4 client) accesses it as a **property**:
```ts
if (this.subscriber.isOpen) { ... }
```

On the mock, `this.subscriber.isOpen` evaluates to the **function reference**, which is always truthy regardless of actual connection state. This means `disconnect()` tests never validate the "already disconnected" branch. Tests pass but disconnect edge cases are not actually covered.

**Fix (mock):** Change to a getter:
```ts
public get isOpen() { return this.open; }
```

> **Status:** Fixed. Mock now uses `public get isOpen() { return this.open; }`.

---

## Medium Severity Bugs

### 5. `promiseMap` deduplication ignores differing `redisGetOpts` for concurrent same-key requests ❌ NOT FIXED

**Location:** `get()` method (~line 290)

```ts
const previousAttempt = this.promiseMap[key];
if (previousAttempt) {
    value = await previousAttempt; // ← silently ignores caller's opts
}
```

When two concurrent `get("sameKey", ...)` calls provide different `redisGetOpts`, the second caller piggybacks on the first caller's promise. The second caller's `redisGetOpts` are silently discarded. This produces incorrect data if the two callers expected different Redis commands (e.g. `GET` vs `HGET`).

**Suggested fix:** Include the serialized `redisGetOpts` in the `promiseMap` key to differentiate concurrent requests with different options:
```ts
const promiseKey = opts?.redisGetOpts
    ? `${key}::${opts.redisGetOpts.type}${"argument" in opts.redisGetOpts ? ":" + opts.redisGetOpts.argument : ""}`
    : key;
const previousAttempt = this.promiseMap[promiseKey];
```
Alternatively, if mixing `redisGetOpts` per key is not an intended use case, document that `redisGetOpts` must be consistent per key and consider throwing if a mismatch is detected.

Comment: it is not intended to mix different getOpts for the same key. To save on the overhead of checking every fetch and saving previous getOpts the additional check will not be added for now.
WONT FIX

---

### 6. ~~`onMessage` emits `"refetched"` / `"fetched"` even when the fetch failed~~ ✅ FIXED

**Location:** `onMessage()` (~line 396–403)

```ts
await this.valueCache.fetch(key, { context: specialFetchOptions });

if (this.onMessageStrategy === "refetch" && wasInCache) {
    this.emit("refetched", key);
} else {
    this.emit("fetched", key);
}
```

If the LRU cache's `fetchMethod` fails (and the error handler doesn't throw), `valueCache.fetch()` resolves with `undefined` — the value was **not** actually fetched or cached. Yet `"refetched"` or `"fetched"` is emitted unconditionally, misleading consumers into thinking the cache was updated.

**Fix:** Check the fetch result:
```ts
const result = await this.valueCache.fetch(key, { context: specialFetchOptions });
if (result !== undefined) {
    if (this.onMessageStrategy === "refetch" && wasInCache) {
        this.emit("refetched", key);
    } else {
        this.emit("fetched", key);
    }
}
```

> **Status:** Fixed. `onMessage()` now checks `value !== undefined && value !== null` before emitting events.

---

### 7. ~~`checkOpts` accepts invalid `cacheMaxSize` values (0, negative, NaN, Infinity)~~ ✅ FIXED

**Location:** `checkOpts()` (~line 580)

```ts
if (typeof opts.cacheMaxSize === "number") {
    cacheMaxSize = opts.cacheMaxSize;
}
```

`typeof NaN === "number"`, `typeof Infinity === "number"`, and negative numbers all pass this check. Invalid values are forwarded to LRU cache's `max` option. `lru-cache` v11 requires `max` to be a positive finite integer; invalid values will cause it to throw or behave unexpectedly at runtime.

**Fix:**
```ts
if (typeof opts.cacheMaxSize === "number") {
    if (!Number.isFinite(opts.cacheMaxSize) || opts.cacheMaxSize < 1 || !Number.isInteger(opts.cacheMaxSize)) {
        throw new TypeError("OPTS_CACHE_MAX_SIZE_INVALID");
    }
    cacheMaxSize = opts.cacheMaxSize;
}
```

> **Status:** Fixed. `checkOpts()` now validates `Number.isFinite`, `>= 1`, and `Number.isInteger`.

---

### 8. ~~`connect()` race condition when called concurrently~~ ✅ FIXED

**Location:** `connect()` method (~line 244–271)

If `connect()` is called twice concurrently (e.g. from `new()` and user code):
1. Both see `clientConnected === false`
2. Both call `await this.client.connect()`
3. The second `connect()` call fails because the client is already connecting

There is no mutex or guard preventing concurrent `connect()` invocations. The `listenersAdded` flag only prevents duplicate event listeners, not duplicate connection attempts.

**Fix:** Add a connecting guard promise:
```ts
private connectingPromise: Promise<void> | undefined;

public async connect() {
    if (this.connectingPromise) {
        return this.connectingPromise;
    }
    this.connectingPromise = this._connect();
    try {
        await this.connectingPromise;
    } finally {
        this.connectingPromise = undefined;
    }
}

private async _connect() {
    // ... existing connect logic ...
}
```

> **Status:** Fixed. `connect()` now uses a `connectingPromise` guard — concurrent callers await the same connection attempt.

---

### 9. ~~`quit()` doesn't guarantee connected-state update on partial failure~~ ✅ FIXED

**Location:** `quit()` (~line 330–342)

```ts
const results = await Promise.allSettled([this.subscriber.quit(), this.client.quit()]);
```

If one of the `quit()` calls fails (caught by `allSettled`), the corresponding `"end"` event might not fire, leaving `clientConnected` or `subscriberConnected` as `true`. The instance is then in an inconsistent state — it believes it's connected but the Redis client may be in a broken state.

**Fix:** Explicitly update the connection state after `quit()` regardless of whether the `"end"` event fires:
```ts
public async quit() {
    this.assertConnected();
    const results = await Promise.allSettled([this.subscriber.quit(), this.client.quit()]);

    // Force state update in case "end" events didn't fire
    this.subscriberConnected = false;
    this.clientConnected = false;
    this.valueCache.clear();
    this.promiseMap = {};

    if (results[0].status === "rejected") {
        this.emit("error", new Error("CLIENT_FAILED_TO_QUIT"), "subscriber");
    }
    if (results[1].status === "rejected") {
        this.emit("error", new Error("CLIENT_FAILED_TO_QUIT"), "client");
    }
}
```

> **Status:** Fixed. `quit()` now explicitly sets `subscriberConnected = false`, `clientConnected = false`, clears `valueCache`, and resets `promiseMap` after `allSettled`.

---

### 10. ~~`onMessage` bypasses `promiseMap` deduplication~~ ✅ FIXED

**Location:** `onMessage()` (~line 393)

When `onMessageStrategy` is `"refetch"` or `"fetchAlways"`, `onMessage` calls `this.valueCache.fetch()` directly, bypassing the `promiseMap` deduplication used by `get()`. If a `get()` call for the same key is in-flight simultaneously, two concurrent Redis fetches execute for the same key.

> **Status:** Fixed. `onMessage()` now checks `if (this.promiseMap[key]) { return; }` before fetching, avoiding concurrent duplicates.

---

## Edge Cases & Design Issues

### 11. ~~`promiseMap` is not cleared on disconnect/reconnect~~ ✅ FIXED

**Location:** `disconnect()` (~line 319), error handlers (~line 252)

When disconnecting or on connection error, the `valueCache` is cleared but `promiseMap` is not. If there are in-flight promises at disconnect time, they will either resolve with stale data or reject. Combined with Bug #1, rejected entries remain permanently. After reconnecting, `get()` may re-await stale/rejected promises.

> **Status:** Fixed. `disconnect()` now resets `this.promiseMap = {}` before disconnecting clients. Note: the `promiseMap` is still not cleared in the `"error"` / `"end"` event handlers, so transient connection errors (without a full `disconnect()` call) may still leave stale entries. However, with Bug #1 fixed (`try/finally`), these entries will self-clean when their promise settles.

---

### 12. `fetch()` with `errorHandlerStrategy: "throw"` never reaches fallback method ❌ NOT FIXED

**Location:** `fetch()` method (~line 420–426)

```ts
try {
    savedValue = await this.valueCache.fetch(key, { context: specialFetchOptions });
} catch (error) {
    this.errorHandler(error, { key }); // re-throws when strategy is "throw"
}

if (!savedValue && this.fallbackFetchMethod) {
    // ← never reached if errorHandler re-threw above
```

When the primary Redis fetch fails and `errorHandlerStrategy` is `"throw"`, the error is re-thrown immediately. The fallback fetch method is never invoked, even though it exists specifically to handle cases where Redis can't provide a value.

**Suggested fix:** If the intent is that the fallback should always have a chance to run, restructure the error handling so the Redis fetch error is recorded rather than immediately re-thrown:
```ts
private async fetch(key: string, specialFetchOptions?: { redisGetOptions?: RedisGetOpts }) {
    this.assertConnected();
    let savedValue: storedValueType | undefined | null;
    let fetchError: unknown;

    try {
        savedValue = await this.valueCache.fetch(key, { context: specialFetchOptions });
    } catch (error) {
        fetchError = error;
    }

    if ((savedValue === null || savedValue === undefined) && this.fallbackFetchMethod) {
        try {
            savedValue = await this.fallbackFetchMethod(key);
        } catch (error) {
            this.errorHandler(error, { key });
        }
        // ... cache fallback value logic ...
    }

    // Only now surface the original fetch error if no value was found
    if (fetchError && (savedValue === null || savedValue === undefined)) {
        this.errorHandler(fetchError, { key });
    }

    return savedValue ?? undefined;
}
```
Alternatively, document that the `"throw"` strategy intentionally bypasses fallback, if that is the desired behavior.

Comment: The intent is for the fallbackMethod to only run on null or undefined values. If the error is removed and a fetch Method with errors is provided it will always run the fallbackMethod and stop caching the values.
WONT FIX

---

### 13. ~~Client validation by `constructor.name` is fragile~~ ✅ FIXED

**Location:** `checkOpts()` (~line 677)

```ts
if (!(opts.redis.client.constructor && opts.redis.client.constructor.name === "Commander")) {
    throw new TypeError("OPTS_REDIS_CLIENT_INVALID");
}
```

This breaks when:
- Code is minified/obfuscated (constructor names may be mangled)
- A different version of node-redis uses a different internal class name
- The client is a subclass or wrapper around the redis client

**Fix:** Use duck-typing to validate the client has the required methods instead of checking the constructor name:
```ts
if ("client" in opts.redis && opts.redis.client) {
    const c = opts.redis.client;
    if (
        typeof c.duplicate !== "function" ||
        typeof c.connect !== "function" ||
        typeof c.disconnect !== "function" ||
        typeof c.on !== "function"
    ) {
        throw new TypeError("OPTS_REDIS_CLIENT_INVALID");
    }
    client = c as ReturnType<typeof createClient>;
}
```

> **Status:** Fixed. `checkOpts()` now uses duck-typing (`typeof c.duplicate/connect/disconnect/on !== "function"`) instead of `constructor.name`.

---

### 14. ~~Empty string key processing~~ ✅ FIXED

**Location:** `onMessage()` (~line 376–381) and general key handling

If `genKeyFromMsg` returns `""`, it is falsy so the `if (generatedKey && typeof generatedKey === "object")` check fails, and `key = ""`. However, `""` passes the `key !== null && key !== undefined` check, causing a Redis fetch for key `""` — almost certainly unintended.

Similarly, `{ key: "" }` from `genKeyFromMsg` would also result in processing an empty-string key.

> **Status:** Fixed. `onMessage()` now checks `key !== null && key !== undefined && key !== "" && typeof key === "string"`. Note: the `{ key: "" }` object return case from `genKeyFromMsg` would still set `key = ""`, but the empty-string guard catches it before processing.

---

### 15. ~~Empty string channel name is not validated~~ ✅ FIXED

**Location:** `checkOpts()` (~line 665)

```ts
typeof opts.redis.channelOpts.name === "string"
```

An empty string (`""`) passes this check. Subscribing to `""` is likely an error and would produce unpredictable behavior.

> **Status:** Fixed. `checkOpts()` now includes `&& opts.redis.channelOpts.name !== ""` in the validation.

---

### 16. `"ready"` event fires on every reconnect, not just initial connection

**Location:** `connect()` method (~line 228–237)

Each time both client **and** subscriber emit `"ready"` (including auto-reconnects after transient failures), the `RedisValueCache` emits its own `"ready"` event. Consumers using `once("ready", ...)` or expecting a single `"ready"` event may miss reconnections, while consumers using `on("ready", ...)` may execute initialization logic multiple times.

Comment: Wont fix because the ready event is thought of more as a way to pass on the redis ready event for both clients

---

### 17. ~~`onMessage` race condition — `clientConnected` check is stale for async operations~~ ✅ FIXED

**Location:** `onMessage()` (~line 365)

```ts
if (this.clientConnected) {
    // ... async operations using this.client below ...
}
```

`clientConnected` is checked once at entry, but the subsequent `await this.valueCache.fetch(...)` is async. By the time the Redis command actually executes, the client may have disconnected. The error is caught by the LRU `fetchMethod` try/catch, but it produces confusing error events.

**Fix:**
```ts
private async fetchMethod(key: string, specialFetchOptions?: RedisGetOpts) {
    if (!this.clientConnected) {
        return; // bail silently if disconnected, LRU will treat as cache miss
    }
    // ... rest of fetch logic ...
}
```

> **Status:** Fixed. `fetchMethod()` now checks `if (!this.clientConnected) { return; }` at entry, preventing Redis commands from being issued on a disconnected client.

---

### 18. ~~`deepFreeze` skips non-own properties but processes non-enumerable own properties~~ 📝 DOCUMENTED

**Location:** `deepFreeze()` function (~line 762)

`Object.getOwnPropertyNames()` returns **all** own properties including non-enumerable ones. This means internal/non-enumerable properties of objects returned by `deserialize` are also frozen, which may cause issues with objects that have non-enumerable state used internally.

**Suggested fix:** If only enumerable properties should be frozen (the common case for plain data objects), switch to `Object.keys()`:
```ts
for (const prop of Object.keys(o)) { ... }
```
Alternatively, keep the current behavior but document that `deepFreeze` freezes all own properties including non-enumerable ones, so users' `deserialize` functions should only return plain data objects.

> **Status:** Documented. A JSDoc comment has been added to `deepFreeze()` explaining that `Object.getOwnPropertyNames()` is used (includes non-enumerable own properties) and that objects passed in should be plain data objects.

---

### 19. ~~No cleanup of Redis client/subscriber event listeners~~ 📝 DOCUMENTED

**Location:** `connect()` method (~line 221–261)

When `disconnect()` or `quit()` is called, the event listeners (`"ready"`, `"end"`, `"error"`) added to client and subscriber in `connect()` are never removed. The `listenersAdded` flag prevents adding them again, but the stale listeners remain if the underlying redis client fires events after disconnect (e.g., during the teardown process). This could cause state mutations on a supposedly-disconnected instance.

**Suggested fix:** Store listener references and remove them on disconnect/quit:
```ts
private clientListeners?: { ready: () => void; end: () => void; error: (e: Error) => void };
private subscriberListeners?: { ready: () => void; end: () => void; error: (e: Error) => void };

public async disconnect() {
    this.promiseMap = {};
    if (this.clientListeners) {
        this.client.off("ready", this.clientListeners.ready);
        this.client.off("end", this.clientListeners.end);
        this.client.off("error", this.clientListeners.error);
    }
    // ... same for subscriber, then existing disconnect logic ...
    this.listenersAdded = false;
}
```
Alternatively, since the `listenersAdded` flag already prevents duplicates, and reconnection relies on these listeners remaining active, this may be intentional. If so, document that listeners persist for the instance lifetime to enable reconnect scenarios.

> **Status:** Documented. A JSDoc comment has been added to `_connect()` explaining that event listeners are intentionally never removed — they must persist across disconnect/reconnect cycles for accurate connection state tracking, and `listenersAdded` prevents duplicates.

---

## Summary Table

| # | Severity | Category | Status | Description |
|---|----------|----------|--------|-------------|
| 1 | **Critical** | Memory Leak / Bug | ✅ Fixed | `promiseMap` entry never deleted on rejection — key permanently broken |
| 2 | **Critical** | Bug | ✅ Fixed | `HGETALL` returns `{}` for missing keys (truthy) — mock hides this |
| 3 | **Critical** | Bug | ✅ Fixed | Falsy valid values (`0`, `""`, `false`) treated as missing |
| 4 | **Critical** | Test Bug | ✅ Fixed | Mock `isOpen` is method, not getter — tests don't cover disconnect logic |
| 5 | Medium | Bug | Won't Fix | `promiseMap` dedup ignores different `redisGetOpts` |
| 6 | Medium | Bug | ✅ Fixed | `"refetched"`/`"fetched"` emitted even on failed fetches |
| 7 | Medium | Bug | ✅ Fixed | `cacheMaxSize` accepts NaN, Infinity, negative, zero |
| 8 | Medium | Race Cond. | ✅ Fixed | Concurrent `connect()` calls cause double-connect error |
| 9 | Medium | Bug | ✅ Fixed | `quit()` partial failure leaves inconsistent connected state |
| 10 | Medium | Race Cond. | ✅ Fixed | `onMessage` bypasses `promiseMap`, allows duplicate fetches |
| 11 | Low | Memory/State | ✅ Fixed | `promiseMap` not cleared on disconnect |
| 12 | Low | Design | Won't Fix | `"throw"` strategy prevents fallback from ever running |
| 13 | Low | Fragility | ✅ Fixed | Client validated by `constructor.name` — breaks with minification |
| 14 | Low | Edge Case | ✅ Fixed | Empty string `""` key is processed as valid |
| 15 | Low | Edge Case | ✅ Fixed | Empty string channel name not rejected |
| 16 | Low | Design | Won't Fix | `"ready"` event fires on every reconnect |
| 17 | Low | Race Cond. | ✅ Fixed | `clientConnected` check stale for async `onMessage` body |
| 18 | Low | Edge Case | Documented | `deepFreeze` freezes non-enumerable own properties |
| 19 | Low | Leak | Documented | Event listeners on redis clients never removed |
