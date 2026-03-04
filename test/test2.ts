import type { Deserialize, FallbackFetchMethode, Opts } from "../index";

import { setTimeout } from "node:timers/promises";
import { RedisValueCache } from "../index";
import redisV4Mock, { Client } from "./redisV4Mock";

// biome-ignore lint/suspicious/noExplicitAny: needed for test since client is not 100% compatible with redis client but should fake the most important parts
const mockClient = redisV4Mock.createClient() as any;

const defaultOptsString: Opts<string> = {
	redis: {
		channelOpts: {
			type: "subscribe",
			name: "channel",
		},
		getOpts: {
			type: "GET",
		},
	},
	cacheMaxSize: 100,
	genKeyFromMsg: (msg: string) => {
		return msg;
	},
	deserialize: (rVal: string) => {
		return rVal;
	},
} as const;

// ============================================================================
// checkOpts validation
// ============================================================================

describe("checkOpts validation", () => {
	test("throws OPTS_MISSING if opts is null/undefined", () => {
		// @ts-expect-error intentionally passing invalid opts
		expect(() => new RedisValueCache(null)).toThrow("OPTS_MISSING");
		// @ts-expect-error intentionally passing invalid opts
		expect(() => new RedisValueCache(undefined)).toThrow("OPTS_MISSING");
	});

	test("throws OPTS_NOT_AN_OBJECT if opts is a primitive", () => {
		// @ts-expect-error intentionally passing invalid opts
		expect(() => new RedisValueCache("bad")).toThrow("OPTS_NOT_AN_OBJECT");
		// @ts-expect-error intentionally passing invalid opts
		expect(() => new RedisValueCache(42)).toThrow("OPTS_NOT_AN_OBJECT");
	});

	test("throws OPTS_REDIS_MISSING if redis key is absent", () => {
		// @ts-expect-error intentionally passing invalid opts
		expect(() => new RedisValueCache({
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_MISSING");
	});

	test("throws OPTS_REDIS_TYPE_MISMATCH if redis is not an object", () => {
		expect(() => new RedisValueCache({
			redis: "bad" as any,
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_TYPE_MISMATCH");
	});

	test("throws OPTS_REDIS_CHANNEL_OPTS_MISSING if channelOpts is absent", () => {
		expect(() => new RedisValueCache({
			redis: { getOpts: { type: "GET" } } as any,
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_CHANNEL_OPTS_MISSING");
	});

	test("throws OPTS_REDIS_CHANNEL_OPTS_TYPE_INVALID for empty channel name", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "subscribe", name: "" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_CHANNEL_OPTS_TYPE_INVALID");
	});

	test("throws OPTS_REDIS_CHANNEL_OPTS_TYPE_INVALID for wrong type", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "invalid" as any, name: "chan" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_CHANNEL_OPTS_TYPE_INVALID");
	});

	test("throws OPTS_REDIS_FETCH_OPTIONS_MISSING if getOpts is absent", () => {
		expect(() => new RedisValueCache({
			redis: { channelOpts: { type: "subscribe", name: "chan" } } as any,
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_FETCH_OPTIONS_MISSING");
	});

	test("throws OPTS_REDIS_FETCH_OPTIONS_TYPE_INVALID for wrong getOpts type", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "subscribe", name: "chan" },
				getOpts: { type: "INVALID" as any },
			},
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_FETCH_OPTIONS_TYPE_INVALID");
	});

	test("throws OPTS_REDIS_FETCH_OPTIONS_ARGUMENT_INVALID for HGET without argument", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "subscribe", name: "chan" },
				getOpts: { type: "HGET" } as any,
			},
			genKeyFromMsg: () => null,
			deserialize: () => null,
		})).toThrow("OPTS_REDIS_FETCH_OPTIONS_ARGUMENT_INVALID");
	});

	test("throws OPTS_GEN_KEY_FROM_MSG_MISSING if genKeyFromMsg is absent", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "subscribe", name: "chan" },
				getOpts: { type: "GET" },
			},
			deserialize: () => null,
		} as any)).toThrow("OPTS_GEN_KEY_FROM_MSG_MISSING");
	});

	test("throws OPTS_GEN_KEY_FROM_MSG_INVALID if genKeyFromMsg is not a function", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "subscribe", name: "chan" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: "notAFunction" as any,
			deserialize: () => null,
		})).toThrow("OPTS_GEN_KEY_FROM_MSG_INVALID");
	});

	test("throws OPTS_DESERIALIZE_MISSING if deserialize is absent", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "subscribe", name: "chan" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => null,
		} as any)).toThrow("OPTS_DESERIALIZE_MISSING");
	});

	test("throws OPTS_DESERIALIZE_TYPE_MISMATCH if deserialize is not a function", () => {
		expect(() => new RedisValueCache({
			redis: {
				channelOpts: { type: "subscribe", name: "chan" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => null,
			deserialize: "bad" as any,
		})).toThrow("OPTS_DESERIALIZE_TYPE_MISMATCH");
	});

	test("throws OPTS_CACHE_MAX_SIZE_TYPE_MISMATCH for non-number cacheMaxSize", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			cacheMaxSize: "bad" as any,
		})).toThrow("OPTS_CACHE_MAX_SIZE_TYPE_MISMATCH");
	});

	test("throws OPTS_CACHE_MAX_SIZE_INVALID for zero", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			cacheMaxSize: 0 as any,
		})).toThrow("OPTS_CACHE_MAX_SIZE_INVALID");
	});

	test("throws OPTS_CACHE_MAX_SIZE_INVALID for negative number", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			cacheMaxSize: -5 as any,
		})).toThrow("OPTS_CACHE_MAX_SIZE_INVALID");
	});

	test("throws OPTS_CACHE_MAX_SIZE_INVALID for NaN", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			cacheMaxSize: NaN as any,
		})).toThrow("OPTS_CACHE_MAX_SIZE_INVALID");
	});

	test("throws OPTS_CACHE_MAX_SIZE_INVALID for Infinity", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			cacheMaxSize: Infinity as any,
		})).toThrow("OPTS_CACHE_MAX_SIZE_INVALID");
	});

	test("throws OPTS_CACHE_MAX_SIZE_INVALID for float", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			cacheMaxSize: 3.5 as any,
		})).toThrow("OPTS_CACHE_MAX_SIZE_INVALID");
	});

	test("throws OPTS_HANDLE_ERRORS_INVALID for bad errorHandlerStrategy", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			// @ts-expect-error intentionally passing invalid opts
			errorHandlerStrategy: "badStrategy",
		})).toThrow("OPTS_HANDLE_ERRORS_INVALID");
	});

	test("throws OPTS_FETCH_ON_MESSAGE_INVALID for bad onMessageStrategy", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			// @ts-expect-error intentionally passing invalid opts
			onMessageStrategy: "badStrategy",
		})).toThrow("OPTS_FETCH_ON_MESSAGE_INVALID");
	});

	test("throws OPTS_FALL_BACK_FETCH_METHOD_INVALID for non-function fallback", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			// @ts-expect-error intentionally passing invalid opts
			fallbackFetchMethod: "notAFunction",
		})).toThrow("OPTS_FALL_BACK_FETCH_METHOD_INVALID");
	});

	test("throws OPTS_FREEZE_TYPE_MISMATCH for non-boolean freeze", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			// @ts-expect-error intentionally passing invalid opts
			freeze: "yes",
		})).toThrow("OPTS_FREEZE_TYPE_MISMATCH");
	});

	test("throws OPTS_CACHE_FALLBACK_VALUES_TYPE_MISMATCH for non-boolean cacheFallbackValues", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			// @ts-expect-error intentionally passing invalid opts
			cacheFallbackValues: "yes",
		})).toThrow("OPTS_CACHE_FALLBACK_VALUES_TYPE_MISMATCH");
	});

	test("throws OPTS_REDIS_CLIENT_INVALID for client without required methods", () => {
		expect(() => new RedisValueCache({
			...defaultOptsString,
			redis: {
				...defaultOptsString.redis,
				// @ts-expect-error intentionally passing invalid client
				client: { notAClient: true },
			},
		})).toThrow("OPTS_REDIS_CLIENT_INVALID");
	});

	test("accepts valid pSubscribe channelOpts", async () => {
		const rvc = new RedisValueCache<string>({
			...defaultOptsString,
			redis: {
				channelOpts: {
					type: "pSubscribe",
					name: "channel:*",
				},
				getOpts: { type: "GET" },
			},
		});

		await rvc.connect();
		expect(rvc.getConnected()).toBe(true);
		await rvc.disconnect();
	});
});

// ============================================================================
// Connection lifecycle
// ============================================================================

describe("connection lifecycle", () => {
	test("getConnected returns false before connect and true after", async () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);
		expect(rvc.getConnected()).toBe(false);

		await rvc.connect();
		expect(rvc.getConnected()).toBe(true);

		await rvc.disconnect();
		expect(rvc.getConnected()).toBe(false);
	});

	test("get throws DISCONNECTED before connect", async () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);

		await expect(rvc.get("key1")).rejects.toThrow("DISCONNECTED");
	});

	test("delete throws DISCONNECTED before connect", () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);

		expect(() => rvc.delete("key1")).toThrow("DISCONNECTED");
	});

	test("quit throws DISCONNECTED before connect", async () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);

		await expect(rvc.quit()).rejects.toThrow("DISCONNECTED");
	});

	test("get throws DISCONNECTED after disconnect", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		await rvc.disconnect();

		await expect(rvc.get("key1")).rejects.toThrow("DISCONNECTED");
	});

	test("disconnect is safe when already disconnected", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);
		await rvc.disconnect();

		// should not throw
		await rvc.disconnect();
	});

	test("connect → disconnect → connect cycle works", async () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);

		await rvc.connect();
		expect(rvc.getConnected()).toBe(true);

		await rvc.disconnect();
		expect(rvc.getConnected()).toBe(false);

		await rvc.connect();
		expect(rvc.getConnected()).toBe(true);

		const value = await rvc.get("key1");
		expect(value).toBe("value1");

		await rvc.disconnect();
	});

	test("connect → quit → connect cycle works", async () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);

		await rvc.connect();
		await rvc.quit();
		expect(rvc.getConnected()).toBe(false);

		await rvc.connect();
		expect(rvc.getConnected()).toBe(true);

		await rvc.disconnect();
	});

	test("concurrent connect() calls do not throw", async () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);

		// call connect twice concurrently — should not cause double-connect error
		const [r1, r2] = await Promise.allSettled([rvc.connect(), rvc.connect()]);

		expect(r1.status).toBe("fulfilled");
		expect(r2.status).toBe("fulfilled");
		expect(rvc.getConnected()).toBe(true);

		await rvc.disconnect();
	});

	test("ready event fires on connect", async () => {
		const readyListener = jest.fn();
		const rvc = new RedisValueCache<string>(defaultOptsString);
		rvc.on("ready", readyListener);

		await rvc.connect();

		// at least 1 ready event from the connection
		expect(readyListener.mock.calls.length).toBeGreaterThanOrEqual(1);

		await rvc.disconnect();
	});
});

// ============================================================================
// has() method
// ============================================================================

describe("has() method", () => {
	test("has returns false for keys not in cache", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		expect(rvc.has("key1")).toBe(false);

		await rvc.disconnect();
	});

	test("has returns true after a key is fetched", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		await rvc.get("key1");
		expect(rvc.has("key1")).toBe(true);

		await rvc.disconnect();
	});

	test("has returns false after a key is deleted", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		await rvc.get("key1");
		expect(rvc.has("key1")).toBe(true);

		rvc.delete("key1");
		expect(rvc.has("key1")).toBe(false);

		await rvc.disconnect();
	});
});

// ============================================================================
// delete() method
// ============================================================================

describe("delete() method", () => {
	test("delete returns false for key not in cache", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		const result = rvc.delete("nonexistentKey");
		expect(result).toBe(false);

		await rvc.disconnect();
	});

	test("delete returns true for key in cache and removes it", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		await rvc.get("key1");
		expect(rvc.has("key1")).toBe(true);

		const result = rvc.delete("key1");
		expect(result).toBe(true);
		expect(rvc.has("key1")).toBe(false);

		await rvc.disconnect();
	});

	test("value is re-fetched from redis after delete", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});

		await rvc.get("key1");
		await rvc.get("key1");
		expect(testDeserialize.mock.calls).toHaveLength(1);

		rvc.delete("key1");
		await rvc.get("key1");
		expect(testDeserialize.mock.calls).toHaveLength(2);

		await rvc.disconnect();
	});
});

// ============================================================================
// get() returns undefined for nonexistent keys
// ============================================================================

describe("get returns undefined for missing keys", () => {
	test("nonexistent key returns undefined when no fallback is set", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		const value = await rvc.get("totallyMissing");
		expect(value).toBeUndefined();

		await rvc.disconnect();
	});

	test("nonexistent key returns fallback value when fallback is set", async () => {
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			fallbackFetchMethod: async () => "fallback_value",
		});

		const value = await rvc.get("totallyMissing");
		expect(value).toBe("fallback_value");

		await rvc.disconnect();
	});
});

// ============================================================================
// promiseMap deduplication and cleanup
// ============================================================================

describe("promiseMap deduplication", () => {
	test("concurrent get() for same key returns same result and only fetches once", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});

		const promises = Array.from({ length: 20 }, () => rvc.get("key1"));
		const results = await Promise.all(promises);

		// all results identical
		for (const r of results) {
			expect(r).toBe("value1");
		}

		// deserialized only once
		expect(testDeserialize.mock.calls).toHaveLength(1);

		await rvc.disconnect();
	});

	test("promiseMap is cleaned up after rejection (errorHandlerStrategy throw)", async () => {
		let callCount = 0;
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: () => {
				callCount++;
				if (callCount <= 1) {
					throw new Error("FIRST_CALL_ERROR");
				}
				return "recovered";
			},
			errorHandlerStrategy: "throw",
		});

		// first call throws
		await expect(rvc.get("key1")).rejects.toThrow("FIRST_CALL_ERROR");

		// second call should NOT re-throw the same error — promiseMap should be cleaned
		// a new fetch is made and deserialize now returns "recovered"
		const value = await rvc.get("key1");
		expect(value).toBe("recovered");

		// the deserialize was called 2 times (not stuck on stale promise)
		expect(callCount).toBe(2);

		await rvc.disconnect();
	});

	test("promiseMap is cleaned up after rejection (errorHandlerStrategy emit)", async () => {
		const errorListener = jest.fn();
		let callCount = 0;
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: () => {
				callCount++;
				throw new Error("ALWAYS_FAILS");
			},
			errorHandlerStrategy: "emit",
		});
		rvc.on("unexpectedError", errorListener);

		await rvc.get("key1");
		await rvc.get("key1");

		// each call is a fresh attempt since the previous one returned undefined
		expect(callCount).toBe(2);
		expect(errorListener.mock.calls.length).toBeGreaterThanOrEqual(2);

		await rvc.disconnect();
	});
});

// ============================================================================
// errorHandlerStrategy: ignore
// ============================================================================

describe("errorHandlerStrategy: ignore", () => {
	test("errors are silently swallowed and get returns undefined", async () => {
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => { });
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: () => {
				throw new Error("SILENT_ERROR");
			},
			errorHandlerStrategy: "ignore",
		});

		const value = await rvc.get("key1");
		expect(value).toBeUndefined();
		// console.warn should NOT be called for "ignore"
		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
		await rvc.disconnect();
	});
});

// ============================================================================
// genKeyFromMsg edge cases
// ============================================================================

describe("genKeyFromMsg edge cases", () => {
	test("null return from genKeyFromMsg is ignored (no fetch, no crash)", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => null,
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "fetchAlways",
		});

		await Client.serverSendMessage("anything");
		expect(testDeserialize.mock.calls).toHaveLength(0);

		await rvc.disconnect();
	});

	test("undefined return from genKeyFromMsg is ignored", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => undefined,
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "fetchAlways",
		});

		await Client.serverSendMessage("anything");
		expect(testDeserialize.mock.calls).toHaveLength(0);

		await rvc.disconnect();
	});

	test("empty string return from genKeyFromMsg is ignored", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => "",
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "fetchAlways",
		});

		await Client.serverSendMessage("anything");
		expect(testDeserialize.mock.calls).toHaveLength(0);

		await rvc.disconnect();
	});

	test("genKeyFromMsg returning object with key and redisGetOpts works", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => ({ key: "key1", redisGetOpts: { type: "GET" } }),
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "fetchAlways",
		});

		await Client.serverSendMessage("anything");
		expect(testDeserialize.mock.calls).toHaveLength(1);

		await rvc.disconnect();
	});

	test("genKeyFromMsg throwing error uses errorHandler", async () => {
		const errorListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: () => {
				throw new Error("BAD_MSG");
			},
			deserialize: (rVal: string) => rVal,
			errorHandlerStrategy: "emit",
			onMessageStrategy: "fetchAlways",
		});
		rvc.on("unexpectedError", errorListener);

		await Client.serverSendMessage("anything");

		expect(errorListener.mock.calls).toHaveLength(1);
		expect((errorListener.mock.calls[0][0] as Error).message).toBe("BAD_MSG");

		await rvc.disconnect();
	});
});

// ============================================================================
// onMessage with drop strategy — no emit when value is not in cache
// ============================================================================

describe("onMessage drop does not emit dropped for uncached keys", () => {
	test("message for key not in cache does not emit dropped", async () => {
		const droppedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			onMessageStrategy: "drop",
		});
		rvc.on("dropped", droppedListener);

		await Client.serverSendMessage("key1");
		expect(droppedListener.mock.calls).toHaveLength(0);

		await rvc.disconnect();
	});

	test("message for key IN cache emits dropped", async () => {
		const droppedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			onMessageStrategy: "drop",
		});
		rvc.on("dropped", droppedListener);

		// populate cache
		await rvc.get("key1");
		expect(rvc.has("key1")).toBe(true);

		// now drop via message
		await Client.serverSendMessage("key1");
		expect(droppedListener.mock.calls).toHaveLength(1);
		expect(droppedListener.mock.calls[0][0]).toBe("key1");
		expect(rvc.has("key1")).toBe(false);

		await rvc.disconnect();
	});
});

// ============================================================================
// onMessage refetch does not fetch if not in cache, does fetch + emit if in cache
// ============================================================================

describe("onMessage refetch strategy", () => {
	test("refetch does not fetch if key was not in cache", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const refetchedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "refetch",
		});
		rvc.on("refetched", refetchedListener);

		await Client.serverSendMessage("key1");

		expect(testDeserialize.mock.calls).toHaveLength(0);
		expect(refetchedListener.mock.calls).toHaveLength(0);

		await rvc.disconnect();
	});

	test("refetch does fetch and emits refetched if key was in cache", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const refetchedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "refetch",
		});
		rvc.on("refetched", refetchedListener);

		// populate cache first
		await rvc.get("key1");
		expect(testDeserialize.mock.calls).toHaveLength(1);

		await Client.serverSendMessage("key1");

		expect(testDeserialize.mock.calls).toHaveLength(2);
		expect(refetchedListener.mock.calls).toHaveLength(1);
		expect(refetchedListener.mock.calls[0][0]).toBe("key1");

		await rvc.disconnect();
	});
});

// ============================================================================
// onMessage fetchAlways emits "fetched" for keys not previously cached
// ============================================================================

describe("onMessage fetchAlways strategy", () => {
	test("fetchAlways fetches and emits fetched even for keys not in cache", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const fetchedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "fetchAlways",
		});
		rvc.on("fetched", fetchedListener);

		await Client.serverSendMessage("key1");

		expect(testDeserialize.mock.calls).toHaveLength(1);
		expect(fetchedListener.mock.calls).toHaveLength(1);

		await rvc.disconnect();
	});

	test("fetchAlways does not emit fetched when deserialize returns null for message", async () => {
		const fetchedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			deserialize: () => null,
			onMessageStrategy: "fetchAlways",
		});
		rvc.on("fetched", fetchedListener);

		await Client.serverSendMessage("key1");

		// deserialize returned null → no value cached → no "fetched" emitted
		expect(fetchedListener.mock.calls).toHaveLength(0);

		await rvc.disconnect();
	});
});

// ============================================================================
// quit() state management
// ============================================================================

describe("quit() state management", () => {
	test("quit sets connected to false and clears cache", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		await rvc.get("key1");
		expect(rvc.has("key1")).toBe(true);

		await rvc.quit();

		expect(rvc.getConnected()).toBe(false);
		// cache should be cleared
		expect(rvc.has("key1")).toBe(false);
	});

	test("after quit, get throws DISCONNECTED", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);
		await rvc.quit();

		await expect(rvc.get("key1")).rejects.toThrow("DISCONNECTED");
	});
});

// ============================================================================
// freeze + fallback interaction
// ============================================================================

describe("freeze and fallback interaction", () => {
	test("fallback values are frozen when freeze is true and cacheFallbackValues is true", async () => {
		const rvc = await RedisValueCache.new<{ name: string }>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: (msg) => msg,
			// force fallback by returning null from deserialize
			deserialize: () => null,
			fallbackFetchMethod: async () => ({ name: "fallback" }),
			freeze: true,
			cacheFallbackValues: true,
		});

		const value = await rvc.get("nonexistent");
		expect(value).toEqual({ name: "fallback" });
		expect(Object.isFrozen(value)).toBe(true);

		// second get should return same cached frozen object
		const value2 = await rvc.get("nonexistent");
		expect(value2).toBe(value);

		await rvc.disconnect();
	});

	test("fallback values are NOT frozen when freeze is false", async () => {
		const rvc = await RedisValueCache.new<{ name: string }>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: () => null,
			fallbackFetchMethod: async () => ({ name: "fallback" }),
			freeze: false,
			cacheFallbackValues: true,
		});

		const value = await rvc.get("nonexistent");
		expect(value).toEqual({ name: "fallback" });
		expect(Object.isFrozen(value)).toBe(false);

		await rvc.disconnect();
	});
});

// ============================================================================
// clone interaction with various types
// ============================================================================

describe("clone with complex objects", () => {
	test("clone creates independent nested copy", async () => {
		const rvc = await RedisValueCache.new<{ items: string[] }>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: () => ({ items: ["a", "b", "c"] }),
			freeze: false,
		});

		const original = await rvc.get("key1");
		const cloned = await rvc.get("key1", { clone: true });

		expect(original).toEqual(cloned);
		expect(original).not.toBe(cloned);
		// @ts-expect-error original can be undefined but we checked it's not
		expect(original.items).not.toBe(cloned?.items);

		await rvc.disconnect();
	});
});

// ============================================================================
// HGET with different arguments
// ============================================================================

describe("HGET with argument", () => {
	test("HGET fetches correct field from hash", async () => {
		const rvc = await RedisValueCache.new<{ value: number; info: string }>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "HGET", argument: "object" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: (rVal: string) => JSON.parse(rVal) as { value: number; info: string },
		});

		const val6 = await rvc.get("key6");
		expect(val6).toEqual({ value: 6, info: "Info 1" });

		const val7 = await rvc.get("key7");
		expect(val7).toEqual({ value: 7, info: "Info 2" });

		await rvc.disconnect();
	});

	test("HGET returns undefined for missing hash field", async () => {
		const rvc = await RedisValueCache.new<string>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "HGET", argument: "nonexistentField" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: (rVal: string) => rVal,
		});

		const value = await rvc.get("key6");
		expect(value).toBeUndefined();

		await rvc.disconnect();
	});
});

// ============================================================================
// HGETALL
// ============================================================================

describe("HGETALL", () => {
	test("HGETALL returns full hash as record", async () => {
		const rvc = await RedisValueCache.new<Record<string, string>>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "HGETALL" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: (rVal: Record<string, string>) => rVal,
		});

		const value = await rvc.get("key6");
		expect(value).toHaveProperty("object");
		expect(value).toHaveProperty("type", "object");

		await rvc.disconnect();
	});

	test("HGETALL for nonexistent key returns undefined (empty obj is filtered)", async () => {
		const testDeserialize = jest.fn((rVal: Record<string, string>) => rVal);
		const rvc = await RedisValueCache.new<Record<string, string>>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "HGETALL" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: testDeserialize as unknown as Deserialize<Record<string, string>, Record<string, string>>,
		});

		const value = await rvc.get("totallyMissingHash");
		expect(value).toBeUndefined();

		// deserialize should not have been called because mock returns null for missing keys
		expect(testDeserialize.mock.calls).toHaveLength(0);

		await rvc.disconnect();
	});
});

// ============================================================================
// Multiple keys and LRU eviction
// ============================================================================

describe("LRU eviction", () => {
	test("old entries are evicted when cache is full", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			cacheMaxSize: 2,
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});

		await rvc.get("key1");
		await rvc.get("key2");
		expect(testDeserialize.mock.calls).toHaveLength(2);

		// both should be in cache
		expect(rvc.has("key1")).toBe(true);
		expect(rvc.has("key2")).toBe(true);

		// fetching key3 evicts the least-recently-used (key1)
		await rvc.get("key3");
		expect(testDeserialize.mock.calls).toHaveLength(3);

		expect(rvc.has("key3")).toBe(true);
		// key1 should be evicted (least recently used)
		expect(rvc.has("key1")).toBe(false);
		// key2 should still be there
		expect(rvc.has("key2")).toBe(true);

		await rvc.disconnect();
	});

	test("accessing a key refreshes its LRU position", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			cacheMaxSize: 2,
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});

		await rvc.get("key1");
		await rvc.get("key2");

		// access key1 again to refresh it
		await rvc.get("key1");

		// add key3 — should evict key2 (now the least recently used)
		await rvc.get("key3");

		expect(rvc.has("key1")).toBe(true);
		expect(rvc.has("key2")).toBe(false);
		expect(rvc.has("key3")).toBe(true);

		await rvc.disconnect();
	});
});

// ============================================================================
// static new() method
// ============================================================================

describe("static new() method", () => {
	test("returns a connected RedisValueCache", async () => {
		const rvc = await RedisValueCache.new<string>(defaultOptsString);

		expect(rvc.getConnected()).toBe(true);
		expect(rvc).toBeInstanceOf(RedisValueCache);

		const value = await rvc.get("key1");
		expect(value).toBe("value1");

		await rvc.disconnect();
	});
});

// ============================================================================
// pSubscribe
// ============================================================================

describe("pSubscribe channel type", () => {
	test("pSubscribe works with pattern-based channels", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "pSubscribe", name: "channel:*" },
				getOpts: { type: "GET" },
			},
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "fetchAlways",
		});

		await Client.serverSendMessage("key1");
		expect(testDeserialize.mock.calls).toHaveLength(1);

		await rvc.disconnect();
	});
});

// ============================================================================
// Error event forwarding
// ============================================================================

describe("error event forwarding", () => {
	test("client error events are forwarded with correct label", async () => {
		const errorListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
		});
		rvc.on("error", errorListener);

		// simulate server disconnect (causes error on both client and subscriber)
		Client.serverDisconnect();

		expect(errorListener.mock.calls.length).toBe(2);
		const labels = errorListener.mock.calls.map((c: [Error, string]) => c[1]);
		expect(labels).toContain("client");
		expect(labels).toContain("subscriber");

		// reconnect for cleanup
		Client.serverConnect();
		await rvc.disconnect();
	});
});

// ============================================================================
// Fallback fetch method error handling
// ============================================================================

describe("fallback fetch method error handling", () => {
	test("fallback errors are handled by errorHandler (emit strategy)", async () => {
		const errorListener = jest.fn();
		const fallbackError = new Error("FALLBACK_BOOM");
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			// force fallback by returning null
			deserialize: () => null,
			fallbackFetchMethod: async () => {
				throw fallbackError;
			},
			errorHandlerStrategy: "emit",
		});
		rvc.on("unexpectedError", errorListener);

		const value = await rvc.get("key1");
		expect(value).toBeUndefined();
		expect(errorListener.mock.calls).toHaveLength(1); // 1 from fallback

		await rvc.disconnect();
	});

	test("fallback errors are handled by errorHandler (warn strategy)", async () => {
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => { });
		const fallbackError = new Error("FALLBACK_WARN");
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: () => null,
			fallbackFetchMethod: async () => {
				throw fallbackError;
			},
			errorHandlerStrategy: "warn",
		});

		const value = await rvc.get("key1");
		expect(value).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(fallbackError);

		warnSpy.mockRestore();
		await rvc.disconnect();
	});
});

// ============================================================================
// Default cacheMaxSize
// ============================================================================

describe("default cacheMaxSize", () => {
	test("default cacheMaxSize is 1000 when not specified", async () => {
		const rvc = new RedisValueCache<string>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: (rVal: string) => rVal,
			// no cacheMaxSize specified
		});

		// just verify it doesn't throw and creates successfully
		await rvc.connect();
		expect(rvc.getConnected()).toBe(true);
		await rvc.disconnect();
	});
});

// ============================================================================
// Rapid disconnect / reconnect stress
// ============================================================================

describe("rapid disconnect / reconnect", () => {
	test("rapid connect-disconnect cycles work without errors", async () => {
		const rvc = new RedisValueCache<string>(defaultOptsString);

		for (let i = 0; i < 5; i++) {
			await rvc.connect();
			expect(rvc.getConnected()).toBe(true);

			const val = await rvc.get("key1");
			expect(val).toBe("value1");

			await rvc.disconnect();
			expect(rvc.getConnected()).toBe(false);
		}
	});
});

// ============================================================================
// Cache cleared on connection error + recovery
// ============================================================================

describe("cache cleared on connection error and recovery", () => {
	test("cache is rebuilt after error + reconnect", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const testOnError = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				client: mockClient,
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "GET" },
			},
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});
		rvc.on("error", testOnError);

		// populate cache
		await rvc.get("key1");
		await rvc.get("key2");
		expect(testDeserialize.mock.calls).toHaveLength(2);

		// confirm cache hit
		await rvc.get("key1");
		expect(testDeserialize.mock.calls).toHaveLength(2);

		// simulate connection loss + recovery
		Client.serverDisconnect();
		Client.serverConnect();

		// cache should be cleared, so next get should re-fetch
		await rvc.get("key1");
		await rvc.get("key2");
		expect(testDeserialize.mock.calls).toHaveLength(4);

		expect(testOnError.mock.calls).toHaveLength(2);

		await rvc.disconnect();
	});
});

// ============================================================================
// Multiple independent instances
// ============================================================================

describe("multiple independent instances", () => {
	test("two instances with different opts operate independently", async () => {
		const deserialize1 = jest.fn((rVal: string) => `inst1:${rVal}`);
		const deserialize2 = jest.fn((rVal: string) => `inst2:${rVal}`);

		const rvc1 = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: deserialize1 as unknown as Deserialize<string>,
		});
		const rvc2 = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: deserialize2 as unknown as Deserialize<string>,
		});

		const val1 = await rvc1.get("key1");
		const val2 = await rvc2.get("key1");

		expect(val1).toBe("inst1:value1");
		expect(val2).toBe("inst2:value1");

		// caches are independent
		expect(deserialize1.mock.calls).toHaveLength(1);
		expect(deserialize2.mock.calls).toHaveLength(1);

		await rvc1.disconnect();
		await rvc2.disconnect();
	});
});

// ============================================================================
// Deserialize receives correct arguments
// ============================================================================

describe("deserialize receives correct arguments", () => {
	test("deserialize receives (value, key) for GET", async () => {
		const testDeserialize = jest.fn((rVal: string, key: string) => `${key}=${rVal}`);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});

		await rvc.get("key1");

		expect(testDeserialize.mock.calls).toHaveLength(1);
		expect(testDeserialize.mock.calls[0][0]).toBe("value1");
		expect(testDeserialize.mock.calls[0][1]).toBe("key1");

		await rvc.disconnect();
	});

	test("deserialize receives (record, key) for HGETALL", async () => {
		const testDeserialize = jest.fn((rVal: Record<string, string>, key: string) => {
			return { ...rVal, _key: key };
		});

		const rvc = await RedisValueCache.new<Record<string, string>>({
			redis: {
				channelOpts: { type: "subscribe", name: "channel" },
				getOpts: { type: "HGETALL" },
			},
			genKeyFromMsg: (msg) => msg,
			deserialize: testDeserialize as unknown as Deserialize<Record<string, string>, Record<string, string>>,
		});

		await rvc.get("key6");

		expect(testDeserialize.mock.calls).toHaveLength(1);
		expect(testDeserialize.mock.calls[0][0]).toHaveProperty("object");
		expect(testDeserialize.mock.calls[0][0]).toHaveProperty("type", "object");
		expect(testDeserialize.mock.calls[0][1]).toBe("key6");

		await rvc.disconnect();
	});
});
