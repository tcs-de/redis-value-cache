import { RedisValueCache } from "../index";
import type { Deserialize, Opts, FallbackFetchMethode } from "../index";
import redisV4Mock, { Client } from "./redisV4Mock";
import { setTimeout } from "node:timers/promises";

const mockClient = redisV4Mock.createClient();

mockClient.constructor = {
	name: "Commander"
// eslint-disable-next-line @typescript-eslint/ban-types
} as Function;

const defaultOptsString: Opts<string> = {
	redis: {
		channelOpts: {
			type: "subscribe",
			name: "channel"
		},
		getOpts: {
			type: "GET"
		}
	},
	cacheMaxSize: 100,
	genKeyFromMsg: (msg: string) => {
		return msg;
	},
	deserialize: (rVal: string) => {
		return rVal;
	}
} as const;

// this is testing with a mocked version of redis

describe("create Redis value caches with different options and read 1 value", () => {
	test("normal create with Get option", async () => {
		const rvc = new RedisValueCache<string>({
			redis: {
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "GET"
				}
			},
			cacheMaxSize: 100,
			genKeyFromMsg: (msg: string) => {
				return msg;
			},
			deserialize: (rVal: string) => {
				return rVal;
			}
		});

		await rvc.connect();

		const value = await rvc.get("key1");

		expect(value).toBe("value1");

		await rvc.quit();
	});

	test(".new() create with HGet Option", async () => {
		const rvc = await RedisValueCache.new<{value: number; info: string}>({
			redis: {
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "HGET",
					argument: "object"
				}
			},
			cacheMaxSize: 100,
			genKeyFromMsg: (msg: string) => {
				return msg;
			},
			deserialize: (rVal: string) => {
				return JSON.parse(rVal) as {value: number; info: string};
			}
		});

		const value = await rvc.get("key6");

		expect(value).toEqual({ value: 6, info: "Info 1" });

		await rvc.disconnect();
	});

	test("pass client into create with HGetAll", async () => {
		const rvc = new RedisValueCache<{object: {value: number; info: string}; type: string}>({
			redis: {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				client: mockClient as any,
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "HGETALL"
				}
			},
			cacheMaxSize: 100,
			genKeyFromMsg: (msg: string) => {
				return msg;
			},
			deserialize: (rVal: Record<string, string>) => {
				const object = JSON.parse(rVal.object) as {value: number; info: string};

				return {
					object,
					type: rVal.type
				};
			}
		});

		await rvc.connect();

		const value = await rvc.get("key7");

		expect(value).toEqual({ object: { value: 7, info: "Info 2" }, type: "object" });

		await rvc.quit();
	});
});

describe("fall back fetch Method", () => {
	const testFallback = jest.fn(() => { return "Test"; });
	test("fall back fetch Methode is unused if deserialize returns values", async () => {
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			fallbackFetchMethod: testFallback as unknown as FallbackFetchMethode<string>
		});

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");
		await rvc.get("key4");
		await rvc.get("key5");

		expect(testFallback.mock.calls).toHaveLength(0);

		await rvc.quit();
	});
	test("fall back fetch Methode is used if no value is found", async () => {
		testFallback.mockClear();

		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			fallbackFetchMethod: testFallback as unknown as FallbackFetchMethode<string>
		});

		await rvc.get("nonexistentKey1");
		await rvc.get("nonexistentKey2");
		await rvc.get("nonexistentKey3");
		await rvc.get("nonexistentKey4");
		await rvc.get("nonexistentKey5");

		expect(testFallback.mock.calls).toHaveLength(5);

		await rvc.quit();
	});
	test("fall back fetch Methode is used if deserialize returns null/undefined", async () => {
		testFallback.mockClear();

		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			fallbackFetchMethod: testFallback as unknown as FallbackFetchMethode<string>,
			deserialize: () => { return null; }
		});

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");
		await rvc.get("key4");
		await rvc.get("key5");

		expect(testFallback.mock.calls).toHaveLength(5);

		await rvc.quit();
	});
	test("if fall back fetch method returns no value no value is cached", async () => {
		const nullTestFallback = jest.fn(() => { return null; });
		const nullTestDeserialize = jest.fn(() => { return null; });

		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			fallbackFetchMethod: nullTestFallback as unknown as FallbackFetchMethode<string>,
			deserialize: nullTestDeserialize
		});

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");
		await rvc.get("key4");
		await rvc.get("key5");

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");
		await rvc.get("key4");
		await rvc.get("key5");

		expect(nullTestFallback.mock.calls).toHaveLength(10);
		expect(nullTestDeserialize.mock.calls).toHaveLength(10);

		await rvc.quit();
	});
});

describe("caching", () => {
	test("object is not fetched 2 times and the same object is returned", async () => {
		const testDeserialize = jest.fn((val: string, key: string) => {
			return { val };
		});

		const rvc = new RedisValueCache<{val: string}>({
			redis: {
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "GET"
				}
			},
			cacheMaxSize: 100,
			genKeyFromMsg: (msg: string) => {
				return msg;
			},
			deserialize: testDeserialize as unknown as Deserialize<{val: string}>
		});

		await rvc.connect();

		const firstValue = await rvc.get("key1");

		const secondValue = await rvc.get("key1");

		await rvc.disconnect();

		// should be same since it the object was cached.
		expect(firstValue).toBe(secondValue);

		expect(firstValue).toEqual({ val: "value1" });

		// deserialize should have only been called
		expect(testDeserialize.mock.calls).toHaveLength(1);
	});

	test("multiple calls of get with same key trigger only 1 fetch", async () => {
		const fallbackFetchMethodTest = jest.fn(async (val: string, key: string) => {
			await setTimeout(1000);
			return "test";
		});

		const rvc = new RedisValueCache<string>({
			...defaultOptsString,
			deserialize: () => {
				// forces fallbackFetchMethod
				return null;
			},
			fallbackFetchMethod: fallbackFetchMethodTest as unknown as FallbackFetchMethode<string>
		});

		await rvc.connect();

		const promises: Promise<string|undefined>[] = [];
		for (let i = 0; i < 10; i++) {
			promises.push(rvc.get("key1"));
		}

		await Promise.all(promises);

		await rvc.disconnect();
		// deserialize should have only been called
		expect(fallbackFetchMethodTest.mock.calls).toHaveLength(1);
	});

	describe("cache is flushed during disconnect / object can be deleted", () => {
		const testDeserialize = jest.fn((val: string, key: string) => {
			return "Anything";
		});
		test("cache flushed during disconnect", async () => {
			const rvc = await RedisValueCache.new<string>({
				...defaultOptsString,
				deserialize: testDeserialize as unknown as Deserialize<string>
			});

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			expect(testDeserialize.mock.calls).toHaveLength(3);

			await rvc.disconnect();
			await rvc.connect();

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");
			await rvc.disconnect();

			expect(testDeserialize.mock.calls).toHaveLength(6);
		});

		test("cache flushed during quit", async () => {
			testDeserialize.mockClear();

			const rvc = await RedisValueCache.new<string>({
				...defaultOptsString,
				deserialize: testDeserialize as unknown as Deserialize<string>
			});

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			expect(testDeserialize.mock.calls).toHaveLength(3);

			await rvc.quit();
			await rvc.connect();

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");
			await rvc.disconnect();

			expect(testDeserialize.mock.calls).toHaveLength(6);
		});

		test("single object cleared after delete", async () => {
			testDeserialize.mockClear();

			const rvc = await RedisValueCache.new<string>({
				...defaultOptsString,
				deserialize: testDeserialize as unknown as Deserialize<string>
			});

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			expect(testDeserialize.mock.calls).toHaveLength(3);

			const wasDeleted = rvc.delete("key1");

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");
			await rvc.disconnect();

			expect(wasDeleted).toBe(true);

			expect(testDeserialize.mock.calls).toHaveLength(4);
		});

		test("cache is flushed on error event and error event is passed on", async () => {
			testDeserialize.mockClear();
			const testOnReady = jest.fn(() => { console.log("ready"); });
			const testOnError = jest.fn(() => { console.log("error"); });

			const rvc = await RedisValueCache.new<string>({
				...defaultOptsString,
				deserialize: testDeserialize as unknown as Deserialize<string>
			});

			rvc.on("ready", testOnReady);
			rvc.on("error", testOnError);

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");

			expect(testDeserialize.mock.calls).toHaveLength(3);

			// fake disconnect. normally disconnects would periodically cause error events but for the mock only 1 is caused
			Client.serverDisconnect();
			// fake reconnect
			Client.serverConnect();

			await rvc.get("key1");
			await rvc.get("key2");
			await rvc.get("key3");
			await rvc.disconnect();

			expect(testDeserialize.mock.calls).toHaveLength(6);
			expect(testOnReady.mock.calls).toHaveLength(1);
			// error needs to be called 2 times since both client and subscriber emit error
			expect(testOnError.mock.calls).toHaveLength(2);
		});
	});
});

describe("messages", () => {
	const testGenKeyFromMsg = jest.fn((msg: string) => { return msg; });
	const testDeserialize = jest.fn((rVal: string) => rVal);

	test("message strategy dropped", async () => {
		const testDroppedListener = jest.fn();

		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				client: mockClient as any,
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "GET"
				}
			},
			genKeyFromMsg: testGenKeyFromMsg,
			deserialize: testDeserialize as unknown as Deserialize<string>
		});

		rvc.on("dropped", testDroppedListener);

		await Client.serverSendMessage("key1");
		await Client.serverSendMessage("key2");
		await Client.serverSendMessage("key3");

		expect(testGenKeyFromMsg.mock.calls).toHaveLength(3);
		expect(testDeserialize.mock.calls).toHaveLength(0);
		expect(testDroppedListener.mock.calls).toHaveLength(0);

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");

		await Client.serverSendMessage("key1");
		await Client.serverSendMessage("key2");
		await Client.serverSendMessage("key3");

		await rvc.disconnect();

		expect(testGenKeyFromMsg.mock.calls).toHaveLength(6);
		expect(testDeserialize.mock.calls).toHaveLength(3);
		expect(testDroppedListener.mock.calls).toHaveLength(3);

	});
	test("message strategy fetch always", async () => {
		testGenKeyFromMsg.mockClear();
		testDeserialize.mockClear();

		const testFetchedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				client: mockClient as any,
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "GET"
				}
			},
			genKeyFromMsg: testGenKeyFromMsg,
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "fetchAlways"
		});

		rvc.on("fetched", testFetchedListener);

		await Client.serverSendMessage("key1");
		await Client.serverSendMessage("key2");
		await Client.serverSendMessage("key3");

		expect(testGenKeyFromMsg.mock.calls).toHaveLength(3);
		expect(testDeserialize.mock.calls).toHaveLength(3);
		expect(testFetchedListener.mock.calls).toHaveLength(3);

		// will not be fetched here since already in cache
		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");

		await Client.serverSendMessage("key1");
		await Client.serverSendMessage("key2");
		await Client.serverSendMessage("key3");

		await rvc.disconnect();

		expect(testGenKeyFromMsg.mock.calls).toHaveLength(6);
		expect(testDeserialize.mock.calls).toHaveLength(6);
		expect(testFetchedListener.mock.calls).toHaveLength(6);
	});
	test("message strategy refetch", async () => {
		testGenKeyFromMsg.mockClear();
		testDeserialize.mockClear();

		const testRefetchedListener = jest.fn();
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			redis: {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				client: mockClient as any,
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "GET"
				}
			},
			genKeyFromMsg: testGenKeyFromMsg,
			deserialize: testDeserialize as unknown as Deserialize<string>,
			onMessageStrategy: "refetch"
		});

		rvc.on("refetched", testRefetchedListener);

		await Client.serverSendMessage("key1");
		await Client.serverSendMessage("key2");
		await Client.serverSendMessage("key3");

		expect(testGenKeyFromMsg.mock.calls).toHaveLength(3);
		expect(testDeserialize.mock.calls).toHaveLength(0);
		expect(testRefetchedListener.mock.calls).toHaveLength(0);

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");

		await Client.serverSendMessage("key1");
		await Client.serverSendMessage("key2");
		await Client.serverSendMessage("key3");

		await rvc.disconnect();

		expect(testDeserialize.mock.calls).toHaveLength(6);
		expect(testRefetchedListener.mock.calls).toHaveLength(3);
		expect(testGenKeyFromMsg.mock.calls).toHaveLength(6);
	});

	test("more complex genKeyFromMessage", async () => {
		testDeserialize.mockClear();
		const rvc = new RedisValueCache({
			...defaultOptsString,
			genKeyFromMsg: (msg: string) => {
				try {
					const msgObject = JSON.parse(msg) as {key: string; info: string; msgId: number};
					return msgObject.key;
				} catch {
					return null;
				}
			},
			onMessageStrategy: "fetchAlways",
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});

		await rvc.connect();

		const msg = JSON.stringify({ key: "key1", info: "test", msgId: 1 });

		await Client.serverSendMessage(msg);

		expect(testDeserialize.mock.calls).toHaveLength(1);

		await rvc.get("key1");

		await rvc.disconnect();

		expect(testDeserialize.mock.calls).toHaveLength(1);
	});
});

describe("freeze/ clone options", () => {
	test("clone Options work as expected", async () => {
		const rvc = new RedisValueCache<{val: string}>({
			redis: {
				channelOpts: {
					type: "subscribe",
					name: "channel"
				},
				getOpts: {
					type: "GET"
				}
			},
			cacheMaxSize: 100,
			genKeyFromMsg: (msg: string) => {
				return msg;
			},
			deserialize: (rVal: string) => {
				return { val: "test" };
			}
		});

		await rvc.connect();

		const value = await rvc.get("key1");
		const unClonedValue = await rvc.get("key1");
		const clonedValue = await rvc.get("key1", { clone: true });
		await rvc.disconnect();

		expect(value).toBe(unClonedValue);
		expect(value).not.toBe(clonedValue);
		expect(value).toEqual(clonedValue);
		expect(clonedValue).toEqual({ val: "test" });

	});
	describe("freeze Options", () => {
		test("object is frozen", async () => {
			const rvc = new RedisValueCache<{val: string}>({
				redis: {
					channelOpts: {
						type: "subscribe",
						name: "channel"
					},
					getOpts: {
						type: "GET"
					}
				},
				cacheMaxSize: 100,
				genKeyFromMsg: (msg: string) => {
					return msg;
				},
				deserialize: (rVal: string) => {
					return { val: "test" };
				}
			});

			await rvc.connect();

			const value = await rvc.get("key1");

			await rvc.disconnect();

			expect(value).toEqual({ val: "test" });

			expect(Object.isFrozen(value)).toBe(true);

		});
		test("object is deepFrozen", async () => {
			const rvc = new RedisValueCache<{val: string; innerObject: {id: number; prop: string}}>({
				redis: {
					channelOpts: {
						type: "subscribe",
						name: "channel"
					},
					getOpts: {
						type: "GET"
					}
				},
				cacheMaxSize: 100,
				genKeyFromMsg: (msg: string) => {
					return msg;
				},
				deserialize: (rVal: string) => {
					return { val: "test", innerObject: { id: 0, prop: "test" } };
				}
			});

			await rvc.connect();

			const value = await rvc.get("key1");

			await rvc.disconnect();

			expect(value).toEqual({ val: "test", innerObject: { id: 0, prop: "test" } });

			// @ts-expect-error checked right above should not result in error
			expect(Object.isFrozen(value.innerObject)).toBe(true);
		});
		test("object is not frozen if option is set to false", async () => {
			const rvc = new RedisValueCache<{val: string; innerObject: {id: number; prop: string}}>({
				redis: {
					channelOpts: {
						type: "subscribe",
						name: "channel"
					},
					getOpts: {
						type: "GET"
					}
				},
				cacheMaxSize: 100,
				genKeyFromMsg: (msg: string) => {
					return msg;
				},
				deserialize: (rVal: string) => {
					return { val: "test", innerObject: { id: 0, prop: "test" } };
				},
				freeze: false
			});

			await rvc.connect();

			const value = await rvc.get("key1");

			await rvc.disconnect();

			expect(value).toEqual({ val: "test", innerObject: { id: 0, prop: "test" } });

			expect(Object.isFrozen(value)).toBe(false);
			// @ts-expect-error checked right above should not result in error
			expect(Object.isFrozen(value.innerObject)).toBe(false);
		});
	});
});

describe("errorHandlerStrategy", () => {
	test("error is thrown if set to throw", async () => {
		const testError = new Error("Test");
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: () => { throw testError; },
			errorHandlerStrategy: "throw"
		});

		try {
			await rvc.get("key1");
			throw new Error("test failed");
		} catch (error) {
			expect(testError).toBe(error);
		}

		await rvc.disconnect();
	});

	test("error is emitted if set to emit", async () => {
		const testError = new Error("Test");
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: () => { throw testError; },
			errorHandlerStrategy: "emit"
		});

		rvc.on("unexpectedError", (error) => {
			expect(error).toBe(testError);

			// use as sanity check to make sure the is called
			// expect(false).toBe(true);
		});

		await rvc.get("key1");

		await rvc.disconnect();
	});

	test("console.warn is called when set to warn", async () => {
		const testError = new Error("Test");
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			deserialize: () => { throw testError; },
			errorHandlerStrategy: "warn"
		});

		const warnSpy = jest.spyOn(console, "warn");

		rvc.on("unexpectedError", (error) => {
			expect(error).toBe(testError);
		});

		await rvc.get("key1");

		await rvc.disconnect();

		expect(warnSpy).toHaveBeenCalledWith(testError);
	});

});

describe("Misc", () => {
	test("cacheMaxSize works", async () => {
		const testDeserialize = jest.fn((rVal: string) => rVal);
		const rvc = await RedisValueCache.new<string>({
			...defaultOptsString,
			cacheMaxSize: 3,
			deserialize: testDeserialize as unknown as Deserialize<string>,
		});

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");

		expect(testDeserialize.mock.calls).toHaveLength(3);

		await rvc.get("key4");
		await rvc.get("key5");

		await rvc.get("key1");
		await rvc.get("key2");
		await rvc.get("key3");
		await rvc.get("key4");
		await rvc.get("key5");

		expect(testDeserialize.mock.calls).toHaveLength(10);
	});
});
