/* eslint-disable unicorn/prefer-event-target */
import { LRUCache } from "lru-cache";
import type { RedisClientOptions } from "redis";
import { createClient } from "redis";
import cloneDeep from "lodash/cloneDeep";
import EventEmitter from "node:events";

interface RedisHget {
	type: "HGET";
	argument: string;
}
interface RedisGet {
	type: "GET";
}

interface RedisHgetall {
	type: "HGETALL";
}

export type RedisGetOpts = RedisHget | RedisGet | RedisHgetall;

export type RedisChannelOpts = {
	type: "subscribe" | "pSubscribe";
	name: string;
};

export type GenKeyFromMsg = (msg: string) => string | null | undefined;
// any because it depends on the GetOpts and Users can type it correctly
export type Deserialize<V, RV extends (string | Record<string, string>) = string> = (rVal: RV, key: string) => V | null | undefined;

export type FallbackFetchMethode<T> = (key: string) => Promise<T | null | undefined>;

export interface GetOpts {
	clone?: boolean;
}

export interface Events {
	"ready": [];
	"error": [error: Error, client: "client" | "subscriber"];
	"unexpectedError": [error: unknown, ctx: {key: string} | { msg: string }];
	"dropped": [key: string];
	"refetched": [key: string];
	"fetched": [key: string];
}

/**
 * options for the constructor of the redis object cache.
 *
 * @property `redis`: Options concerning the direct redis communication.
 * * `redis.clientOpts` (Optional): Options for the redis connection. Will be used for client and subscriber(client.duplicate()).
 * * `redis.client` (Optional): Redis client to duplicate for client and subscriber.
 * * `redis.channelOpts`: Make the subscriber subscribe to 1 channel or pSubscribe to multiple channels.
 * * `redis.getOpts`: Options for wich method the client should use when fetching data from redis
 * @property `genKeyFromMsg`:
 * Function that takes a message that was send over the redis channel and returns a key that needs to be updated.\
 * Return null to ignore message.\
 * This function must not be async.
 * @property `deserialize`:
 * Function that takes a value returned from redis and returns a value to be cached\
 * Return null to ignore value.\
 * This function must not be async.
 * @property `cacheMaxSize` (Optional): Max number of Objects to store in the lru-cache (Default = 1000).
 * @property `errorHandlerStrategy`: Opts how to handle Error.
 * * "warn" (Default): console.warn(error);
 * * "ignore": // do nothing
 * * "throw": throw error;
 * * "emit": this.emit("unexpectedError", error);
 * @property `fallbackFetchMethod`: Optional function to be called in case a key can not be found in redis.\
 * This means the function is called if a the redisValueTransformer function returns null;
 * @property `onMessageStrategy` (Optional): Options for how the RedisValueCache should behave once it receives a message.
 * * "drop" (Default): The value will be deleted from the cache.
 * * "refetch": If a value was already the cache the updated value will be fetched.
 * * "fetchAlways": The updated value will always be fetched even if it was not in the cache before.
 * @property `freezeObjects` (Optional): Whether or not to freeze values when they are cached.
 * @property `cacheFallbackValues` (Optional): Whether or not values returned from the `fallbackFetchMethode` should be cached.
 *
 * @interface Opts
 * @template storedValueType type of the values you want to store.
 */
export type Opts<storedValueType> = {
	redis: {
		clientOpts?: RedisClientOptions;
		client?: ReturnType<(typeof createClient)>;
		channelOpts: RedisChannelOpts;
		getOpts: RedisGet | RedisHget;
	};
	genKeyFromMsg: GenKeyFromMsg;
	deserialize: Deserialize<storedValueType>;
	cacheMaxSize?: number;
	errorHandlerStrategy?: "emit"|"warn"|"throw"|"ignore";
	fallbackFetchMethod?: FallbackFetchMethode<storedValueType>;
	onMessageStrategy?: "drop" | "refetch" | "fetchAlways";
	freeze?: boolean;
	cacheFallbackValues?: boolean;
} | {
	redis: {
		clientOpts?: RedisClientOptions;
		client?: ReturnType<(typeof createClient)>;
		channelOpts: RedisChannelOpts;
		getOpts: RedisHgetall;
	};
	genKeyFromMsg: GenKeyFromMsg;
	deserialize: Deserialize<storedValueType, Record<string, string>>;
	cacheMaxSize?: number;
	errorHandlerStrategy?: "emit"|"warn"|"throw"|"ignore";
	fallbackFetchMethod?: FallbackFetchMethode<storedValueType>;
	onMessageStrategy?: "drop" | "refetch" | "fetchAlways";
	freeze?: boolean;
	cacheFallbackValues?: boolean;
};

/**
 * An object that caches an automatically updates your values from redis
 *
 * @class RedisObjectCache
 * @extends {EventEmitter} Even though certain errors are emitted "normal" errors like trying to get a value before connecting or invalid opts are still thrown.
 * @emits error to pass along error emits of client and subscriber. 1st parameter is the error second parameter is "subscriber" or "client".
 * @emits ready when both client and subscriber (and by extension the class) are ready.
 * @emits unexpectedError when the handleErrors option is set to "emit" and an unexpected error shows up (usually in fetch function).
 * @template storedValueType
 */
export class RedisValueCache<storedValueType extends NonNullable<unknown> = NonNullable<unknown>> extends EventEmitter<Events> {
	private readonly opts: Opts<storedValueType>;
	private readonly valueCache: LRUCache<string, storedValueType>;
	private readonly client: ReturnType<(typeof createClient)>;
	private readonly subscriber: ReturnType<(typeof createClient)>;
	private readonly genKeyFromMsg: GenKeyFromMsg;
	private readonly deserialize: Deserialize<storedValueType> | Deserialize<storedValueType, Record<string, string>>;
	private readonly fallbackFetchMethod: FallbackFetchMethode<storedValueType> | undefined;
	private readonly redisGetOpts: RedisGetOpts;
	private onMessageStrategy: "drop" | "refetch" | "fetchAlways" = "drop";
	private clientConnected = false;
	private subscriberConnected = false;
	private listenersAdded = false;
	private freeze = true;
	private cacheFallbackValues = false;
	private promiseMap: Record<string, Promise<storedValueType | undefined> | undefined> = {};

	constructor(opts: Opts<storedValueType>) {
		super();
		const checkedOpts = RedisValueCache.checkOpts<storedValueType>(opts);
		this.opts = checkedOpts;
		// create client and subscriber
		if (this.opts.redis.client) {
			this.client = this.opts.redis.client.duplicate();
		} else {
			this.client = createClient(this.opts.redis.clientOpts);
		}
		this.subscriber = this.client.duplicate();

		// set other attributes
		this.genKeyFromMsg = this.opts.genKeyFromMsg;
		this.deserialize = this.opts.deserialize;
		if (this.opts.fallbackFetchMethod) {
			this.fallbackFetchMethod = this.opts.fallbackFetchMethod;
		}
		this.redisGetOpts = this.opts.redis.getOpts;
		if (this.opts.onMessageStrategy) {
			this.onMessageStrategy = this.opts.onMessageStrategy;
		}
		this.valueCache = new LRUCache<string, storedValueType>({
			max: this.opts.cacheMaxSize ?? 1000,
			fetchMethod: async (key: string) => {
				try {
					return await this.fetchMethod(key);
				} catch (error) {
					this.errorHandler(error, { key });
				}
				// eslint-disable-next-line consistent-return
				return;
			}
		});
		if (this.opts.freeze === false) {
			this.freeze = false;
		}
		if (this.opts.cacheFallbackValues === true) {
			this.cacheFallbackValues = true;
		}
	}

	/**
	 * Creates a new RedisValueCache and calls the connect function before returning it.
	 *
	 * @static
	 * @template storedValueType Type of the values you want to store
	 * @param {Opts<storedValueType>} opts options to create a RedisValueCache
	 * @memberof RedisValueCache
	 */
	public static async new<storedValueType extends NonNullable<unknown> = NonNullable<unknown>>(opts: Opts<storedValueType>) {
		const rvc = new RedisValueCache<storedValueType>(opts);

		await rvc.connect();

		return rvc;
	}

	/**
	 * Returns true if redis value cache is connected else returns false
	 *
	 * @memberof RedisValueCache
	 */
	public getConnected() {
		return (this.clientConnected && this.subscriberConnected);
	}

	/**
	 * Throws error if the redis value cache is not connected
	 *
	 * @private
	 * @memberof RedisValueCache
	 */
	private assertConnected() {
		if (!this.getConnected()) {
			throw new Error("DISCONNECTED");
		}
	}

	/**
	 * Connects both clients and subscriber.
	 * Also subscribes subscriber to the channel(s).
	 *
	 * @memberof RedisObjectCache
	 */
	public async connect() {
		if (!this.listenersAdded) {
			this.client.on("ready", () => {
				this.clientConnected = true;
				if (this.subscriberConnected === true) {
					this.emit("ready");
				}
			});

			this.client.on("end", () => {
				this.clientConnected = false;
				// need to clear because of potential missed messages
				this.valueCache.clear();
			});

			this.client.on("error", (error: Error) => {
				this.clientConnected = false;
				// need to clear because of potential missed messages
				this.valueCache.clear();
				this.emit("error", error, "client");
			});


			this.subscriber.on("ready", () => {
				this.subscriberConnected = true;
				if (this.clientConnected === true) {
					this.emit("ready");
				}
			});

			this.subscriber.on("end", () => {
				this.subscriberConnected = false;
				// need to clear because of potential missed messages
				this.valueCache.clear();
			});

			this.subscriber.on("error", (error: Error) => {
				this.subscriberConnected = false;
				// need to clear because of potential missed messages
				this.valueCache.clear();
				this.emit("error", error, "subscriber");
			});

			this.listenersAdded = true;
		}

		if (this.clientConnected === false) {
			await this.client.connect();
		}

		if (this.subscriberConnected === false) {
			await this.subscriber.connect();
			if (this.opts.redis.channelOpts.type === "pSubscribe") {
				await this.subscriber.pSubscribe(this.opts.redis.channelOpts.name, async (message) => {
					await this.onMessage(message);
				});
			} else {
				await this.subscriber.subscribe(this.opts.redis.channelOpts.name, async (message) => {
					await this.onMessage(message);
				});

			}
		}
	}

	/**
	 * Function that returns true if a value for the key is in the cache and false otherwise
	 *
	 * @param {string} key key to check the value for
	 * @memberof RedisValueCache
	 */
	public has(key: string) {
		return this.valueCache.has(key);
	}

	/**
	 * Funktion to get the value for the specific key.
	 * Uses the lru cache fetch function.
	 * Returns undefined if no value was found.
	 * Can only be used if connected.
	 * Returns a copy of the Object if defined in the opts otherwise returns a reference.
	 *
	 * @param {string} key key you want to look up
	 * @param {GetOpts} opts options for getting values
	 * @memberof RedisObjectCache
	 */
	public async get(key: string, opts?: GetOpts) {
		this.assertConnected();

		const previousAttempt = this.promiseMap[key];

		let value: storedValueType| undefined;

		if (previousAttempt) {
			value = await previousAttempt;
		} else {
			const currentAttempt = this.fetch(key);

			this.promiseMap[key] = currentAttempt;

			value = await currentAttempt;

			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete this.promiseMap[key];
		}

		if (value && opts?.clone) {
			value = cloneDeep(value);
		}

		// eslint-disable-next-line consistent-return
		return value;
	}

	/**
	 * Function that disconnects both client and subscriber.
	 *
	 * @memberof RedisObjectCache
	 */
	public async disconnect() {
		// is done without checking for client and subscriber connected because we want to keep option to disconnect when reconnects do not work
		if (this.subscriber.isOpen) {
			await this.subscriber.disconnect();
		}

		if (this.client.isOpen) {
			await this.client.disconnect();
		}

	}

	/**
	 * Funktion that calls quit function on both client and subscriber.
	 * Can only be called if clients are connected.
	 *
	 * @memberof RedisObjectCache
	 */
	public async quit() {
		this.assertConnected();

		const results = await Promise.allSettled([this.subscriber.quit(), this.client.quit()]);

		if (results[0].status === "rejected") {
			this.emit("error", new Error("CLIENT_FAILED_TO_QUIT"), "subscriber");
		}
		if (results[1].status === "rejected") {
			this.emit("error", new Error("CLIENT_FAILED_TO_QUIT"), "client");
		}
	}

	/**
	 * Function that deletes a value from the cache. Returns true if value was in the cache, false if it was not.
	 *
	 * @param key key you want to remove
	 * @memberof RedisValueCache
	 */
	public delete(key: string) {
		this.assertConnected();
		const wasInCache = this.valueCache.delete(key);
		return wasInCache;
	}

	/**
	 * Funktion to handle errors as defined in the opts.
	 *
	 * @private
	 * @param {unknown} error
	 * @memberof RedisObjectCache
	 */
	private errorHandler(error: unknown, ctx: {msg: string} | {key: string}) {
		if (!this.opts.errorHandlerStrategy || this.opts.errorHandlerStrategy === "warn") {
			console.warn(error);
		} else if (this.opts.errorHandlerStrategy === "throw") {
			throw error;
		} else if (this.opts.errorHandlerStrategy === "emit") {
			this.emit("unexpectedError", error, ctx);
		}
	}

	/**
	 * function to handle the messages the subscriber receives
	 *
	 * @private
	 * @param {string} msg the message that was received
	 * @memberof RedisValueCache
	 */
	private async onMessage(msg: string) {
		// if for whatever reason client is disconnected but subscriber is not (should not happen) take this for safety
		if (this.clientConnected) {
			let key: string | null | undefined;
			try {
				key = this.genKeyFromMsg(msg);

			} catch (error) {
				this.errorHandler(error, { msg });
			}
			if (key !== null && key !== undefined) {
				// delete key and find out if value was in cache
				const wasInCache = this.valueCache.delete(key);
				if (this.onMessageStrategy === "drop") {
					if (wasInCache) {
						this.emit("dropped", key);
					}
					return;
				}

				if (this.onMessageStrategy === "refetch" && !wasInCache) {
					return;
				}

				await this.valueCache.fetch(key);

				if (this.onMessageStrategy === "refetch" && wasInCache) {
					this.emit("refetched", key);
				} else {
					this.emit("fetched", key);
				}
			}
		}
	}

	/**
	 * Functions that handles fetching of values from cache or with the fallback fetch method
	 *
	 * @private
	 * @param {string} key
	 * @memberof RedisValueCache
	 */
	private async fetch(key: string) {
		this.assertConnected();

		let savedValue: storedValueType | undefined | null;

		try {
			savedValue = await this.valueCache.fetch(key);
		} catch (error) {
			this.errorHandler(error, { key });
		}

		if (!savedValue && this.fallbackFetchMethod) {
			try {
				savedValue = await this.fallbackFetchMethod(key);
			} catch (error) {
				this.errorHandler(error, { key });
			}
			if (savedValue && this.cacheFallbackValues) {
				if (!Object.isFrozen(savedValue) && this.freeze) {
					deepFreeze(savedValue);
				}

				this.valueCache.set(key, savedValue);
			}
		}
		if (savedValue) {
			return savedValue;
		}
		// eslint-disable-next-line consistent-return
		return;
	}

	/**
	 * Function called in the lru cache fetch function.
	 * Contains main (complete) logic for fetching values.
	 *
	 * @private
	 * @param {string} key key to fetch
	 * @memberof RedisValueCache
	 */
	private async fetchMethod(key: string) {
		let redisValue: string | undefined | null | Record<string, string>;

		switch (this.redisGetOpts.type) {
			case "HGET": {
				redisValue = await this.client.HGET(key, this.redisGetOpts.argument);
				break;
			}
			case "GET": {
				redisValue = await this.client.GET(key);
				break;
			}
			case "HGETALL": {
				redisValue = await this.client.HGETALL(key);
				break;
			}
			default: {
				throw new Error("INVALID_FETCH_OPTIONS");
			}
		}

		let value: storedValueType | null | undefined;
		if (redisValue) {
			// @ts-expect-error the deserialize should be typed correctly according to which getOption was selected see Opts type
			value = this.deserialize(redisValue, key);
		}

		/*
		if ((value === null || value === undefined) && this.fallbackFetchMethode) {
			try {
				value = await this.fallbackFetchMethode(key);
			} catch (error) {
				this.errorHandler(error, { key });
			}
		}
		*/

		if (value === null || value === undefined) {
			return;
		}

		if (!Object.isFrozen(value) && this.freeze) {
			deepFreeze(value);
		}

		// eslint-disable-next-line consistent-return
		return value;
	}

	/**
	 * Functions that checks whether or not the opts provided are valid opts.
	 * Does not deeply check the client options and functions.
	 * Throws error if the opts are invalid.
	 *
	 * @private
	 * @param {unknown} opts
	 * @memberof RedisObjectCache
	 */
	private static checkOpts<storedValueType extends NonNullable<unknown> = NonNullable<unknown>>(opts: unknown) {
		if (!opts) {
			throw new Error("OPTS_MISSING");
		}
		if (typeof opts !== "object") {
			throw new TypeError("OPTS_NOT_AN_OBJECT");
		}

		let cacheMaxSize: number|undefined;

		if ("cacheMaxSize" in opts) {
			if (typeof opts.cacheMaxSize === "number") {
				cacheMaxSize = opts.cacheMaxSize;
			} else {
				throw new TypeError("OPTS_CACHE_MAX_SIZE_TYPE_MISMATCH");
			}
		}

		let errorHandlerStrategy: "emit" | "warn" | "ignore" | "throw" | undefined;
		if ("errorHandlerStrategy" in opts) {
			if (opts.errorHandlerStrategy === "emit" || opts.errorHandlerStrategy === "warn" || opts.errorHandlerStrategy === "ignore" || opts.errorHandlerStrategy === "throw") {
				errorHandlerStrategy = opts.errorHandlerStrategy;
			} else {
				throw new Error("OPTS_HANDLE_ERRORS_INVALID");
			}
		}

		let onMessageStrategy: "drop" | "refetch" | "fetchAlways" | undefined;

		if ("onMessageStrategy" in opts) {
			if (opts.onMessageStrategy === "drop" || opts.onMessageStrategy === "refetch" || opts.onMessageStrategy === "fetchAlways") {
				onMessageStrategy = opts.onMessageStrategy;
			} else {
				throw new Error("OPTS_FETCH_ON_MESSAGE_INVALID");
			}
		}

		let fallbackFetchMethod: FallbackFetchMethode<storedValueType> | undefined;
		if ("fallbackFetchMethod" in opts) {
			if (typeof opts.fallbackFetchMethod === "function") {
				fallbackFetchMethod = opts.fallbackFetchMethod as FallbackFetchMethode<storedValueType>;
			} else {
				throw new TypeError("OPTS_FALL_BACK_FETCH_METHOD_INVALID");
			}
		}

		let freeze = true;
		if ("freeze" in opts) {
			if (typeof opts.freeze !== "boolean") {
				throw new TypeError("OPTS_FREEZE_TYPE_MISMATCH");
			}
			if (opts.freeze === false) {
				freeze = false;
			}
		}

		let cacheFallbackValues = false;
		if ("cacheFallbackValues" in opts) {
			if (typeof opts.cacheFallbackValues !== "boolean") {
				throw new TypeError("OPTS_CACHE_FALLBACK_VALUES_TYPE_MISMATCH");
			}
			if (opts.cacheFallbackValues === true) {
				cacheFallbackValues = true;
			}
		}

		if (!("genKeyFromMsg" in opts)) {
			throw new Error("OPTS_GEN_KEY_FROM_MSG_MISSING");
		}

		if (typeof opts.genKeyFromMsg !== "function") {
			throw new TypeError("OPTS_GEN_KEY_FROM_MSG_INVALID");
		}

		if (!("deserialize" in opts) || !opts.deserialize) {
			throw new Error("OPTS_DESERIALIZE_MISSING");
		}
		if (typeof opts.deserialize !== "function") {
			throw new TypeError("OPTS_DESERIALIZE_TYPE_MISMATCH");
		}

		if (!("redis" in opts)) {
			throw new Error("OPTS_REDIS_MISSING");
		}

		if (typeof opts.redis !== "object" || !opts.redis) {
			throw new TypeError("OPTS_REDIS_TYPE_MISMATCH");
		}

		if (!("channelOpts" in opts.redis) || !opts.redis.channelOpts) {
			throw new Error("OPTS_REDIS_CHANNEL_OPTS_MISSING");
		}
		if (typeof opts.redis.channelOpts !== "object") {
			throw new TypeError("OPTS_REDIS_CHANNEL_OPTS_TYPE_MISMATCH");
		}
		if (!(
			"type" in opts.redis.channelOpts
			&& "name" in opts.redis.channelOpts
			&& (opts.redis.channelOpts.type === "subscribe" || opts.redis.channelOpts.type === "pSubscribe")
			&& typeof opts.redis.channelOpts.name === "string"
		)) {
			throw new TypeError("OPTS_REDIS_CHANNEL_OPTS_TYPE_INVALID");
		}

		let clientOpts: RedisClientOptions|undefined;
		if (("clientOpts" in opts.redis)) {
			if (!opts.redis.clientOpts) {
				throw new Error("OPTS_REDIS_CLIENT_OPTS_IS_NULL");
			}
			if (typeof opts.redis.clientOpts !== "object") {
				throw new TypeError("OPTS_REDIS_CLIENT_OPTS_TYPE_MISMATCH");
			}
			clientOpts = opts.redis.clientOpts;
		}

		let client: ReturnType<(typeof createClient)> | undefined;

		if ("client" in opts.redis && opts.redis.client) {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (!(opts.redis.client.constructor && opts.redis.client.constructor.name === "Commander")) {
				throw new TypeError("OPTS_REDIS_CLIENT_INVALID");
			}
			client = opts.redis.client as ReturnType<(typeof createClient)>;
		}

		if (!("getOpts" in opts.redis) || !opts.redis.getOpts) {
			throw new Error("OPTS_REDIS_FETCH_OPTIONS_MISSING");
		}
		if (typeof opts.redis.getOpts !== "object") {
			throw new TypeError("OPTS_REDIS_FETCH_OPTIONS_TYPE_MISMATCH");
		}
		if (!("type" in opts.redis.getOpts)
			|| !(opts.redis.getOpts.type === "HGET"
			|| opts.redis.getOpts.type === "HGETALL"
			|| opts.redis.getOpts.type === "GET")) {
			throw new Error("OPTS_REDIS_FETCH_OPTIONS_TYPE_INVALID");
		}

		let checkedOpts: Opts<storedValueType>;

		if (opts.redis.getOpts.type === "GET" || opts.redis.getOpts.type === "HGET") {
			let getOpts: RedisGetOpts;

			if (opts.redis.getOpts.type === "HGET") {
				if (!("argument" in opts.redis.getOpts && typeof opts.redis.getOpts.argument === "string")) {
					throw new Error("OPTS_REDIS_FETCH_OPTIONS_ARGUMENT_INVALID");
				}
				getOpts = {
					type: opts.redis.getOpts.type,
					argument: opts.redis.getOpts.argument
				};
			} else {
				getOpts = {
					type: opts.redis.getOpts.type
				};
			}

			checkedOpts = {
				redis: {
					getOpts,
					clientOpts,
					client,
					channelOpts: {
						type: opts.redis.channelOpts.type,
						name: opts.redis.channelOpts.name
					}
				},
				cacheMaxSize,
				fallbackFetchMethod,
				genKeyFromMsg: opts.genKeyFromMsg as GenKeyFromMsg,
				onMessageStrategy,
				errorHandlerStrategy: errorHandlerStrategy,
				deserialize: opts.deserialize as Deserialize<storedValueType>,
				freeze,
				cacheFallbackValues
			};

		} else {
			checkedOpts = {
				redis: {
					getOpts: {
						type: opts.redis.getOpts.type
					},
					clientOpts,
					client,
					channelOpts: {
						type: opts.redis.channelOpts.type,
						name: opts.redis.channelOpts.name
					}
				},
				cacheMaxSize,
				fallbackFetchMethod,
				genKeyFromMsg: opts.genKeyFromMsg as GenKeyFromMsg,
				onMessageStrategy,
				errorHandlerStrategy: errorHandlerStrategy,
				deserialize: opts.deserialize as Deserialize<storedValueType, Record<string, string>>,
				freeze,
				cacheFallbackValues
			};
		}

		return checkedOpts;
	}
}

function deepFreeze<T>(o: T): T {
	Object.freeze(o);

	const oIsFunction = typeof o === "function";
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const hasOwnProp = Object.prototype.hasOwnProperty;

	for (const prop of Object.getOwnPropertyNames(o)) {
		if (
			hasOwnProp.call(o, prop)
		&& (oIsFunction
			? prop !== "caller" && prop !== "callee" && prop !== "arguments"
			: true)
		&& o[prop as keyof T] !== null
		&& (typeof o[prop as keyof T] === "object"
		|| typeof o[prop as keyof T] === "function")
		&& !Object.isFrozen(o[prop as keyof T])
		) {
			deepFreeze(o[prop as keyof T]);
		}
	}

	return o;
}

export { type RedisClientOptions } from "redis";
